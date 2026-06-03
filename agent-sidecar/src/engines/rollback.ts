import { MastraRuntimeApproval } from './approval-client/client.js';
import { createMastraModelConfig, resolveMastraModelConfig } from './agent/factory.js';
import { extractRestoreResultText, resolveSystemPromptFromSnapshot, resolveWorkspaceRootPathFromSnapshot } from './context/context.js';
import { normalizeMastraError } from './messages.js';
import { createErrorResponse } from './responses.js';
import { createMastraPlanOrchestrationDeps } from './plan/orchestration-deps.js';
import { PLAN_ORCHESTRATION_WORKFLOW_ID, createPlanOrchestrationWorkflow, type TPlanOrchestrationWorkflow } from './plan/orchestration-workflow.js';
import { loadMastraMcpTools } from './tools/tools.js';
import { DEFAULT_EXECUTION_AGENT_ID, DEFAULT_EXECUTION_AGENT_NAME, DEFAULT_ROLLBACK_STEP } from './types.js';
import { createMastraRequestContext, createRuntimeEventFactory, createSessionId, pushUiEvent, requestContextToRecord } from './utils.js';
import { createMastraAgentInputProcessors, createMastraAgentOutputProcessors, destroyMastraBrowser, destroyMastraWorkspace } from './workspace.js';
import type { IAgentRuntimeResponse, IAgentRuntimeRunOptions, TAgentRuntimeOutputEvent } from './contracts/runtime-contracts.js';
import type { IAgentRuntimeModelConfigInput, ICheckpointRestoreInput } from './contracts/runtime-input.js';
import { DurableStepIds } from '@mastra/core/agent/durable';
import { Mastra } from '@mastra/core/mastra';


export class MastraRuntime extends MastraRuntimeApproval {
    /**
     * Phase 2：构建原生 Mastra 计划编排 workflow（默认关，由 server.ts 的
     * `/agent/plan/orchestrate` 在 `AGENT_ORCHESTRATION_WORKFLOW=1` 时调用）。
     *
     * deps 复用现有 store（结构化真值）与现有 phase 方法（跑 agent），
     * 不改动任何既有运行路径，可随时 git revert。
     *
     * Phase 3a：把 workflow 注册到带 libsql storage 的 Mastra 实例上，让 run
     * 快照落到持久化存储（storage 域 'workflows'，官方用于 suspend/resume），
     * 为跨进程 / TTL 回收后恢复打基础。复用 factory.ts 中 agent 执行 workflow
     * 已验证的持久化范式。仍默认关，不影响任何既有路径，可随时 git revert。
     */
    buildPlanOrchestrationWorkflow(
        modelConfig?: IAgentRuntimeModelConfigInput,
    ): TPlanOrchestrationWorkflow {
        const workflow = createPlanOrchestrationWorkflow(
            createMastraPlanOrchestrationDeps({
                planStore: this.planStore,
                planWorkflowStore: this.planWorkflowStore,
                plan: (input, options) => this.plan(input, options),
                execute: (input, options) => this.execute(input, options),
                validatePlan: (input, options) => this.validatePlan(input, options),
                replanPlan: (input, options) => this.replanPlan(input, options),
                ...(modelConfig ? { modelConfig } : {}),
            }),
        );

        // 实例级 storage 会流向注册在其上的 workflow，使 createRun().start() 的
        // run 快照写入 libsql。必须返回「经实例取回」的句柄（绑定了 storage），
        // 而非裸 workflow——与 factory.ts 中 getAgentById/getWorkflow 一致。
        const mastra = new Mastra({
            workflows: { [PLAN_ORCHESTRATION_WORKFLOW_ID]: workflow as never },
            storage: this.storage as never,
        });

        // workflow 值 as never 会使 getWorkflowById 的参数联合塌缩为 never，
        // 给实参加 as never（纯编译期，运行时传真实 id）解除。
        return mastra.getWorkflowById(
            PLAN_ORCHESTRATION_WORKFLOW_ID as never,
        ) as unknown as TPlanOrchestrationWorkflow;
    }

    async restoreCheckpoint(
        input: ICheckpointRestoreInput,
        options: IAgentRuntimeRunOptions = {},
    ): Promise<IAgentRuntimeResponse> {
        const sessionId = input.sessionId ?? createSessionId('mastra-rollback');
        const events: TAgentRuntimeOutputEvent[] = [];
        const snapshotId = input.snapshotId ?? input.runId;
        const createRuntimeEvent = createRuntimeEventFactory({
            runId: input.runId,
            sessionId,
            agentId: DEFAULT_EXECUTION_AGENT_ID,
            ...(this.now ? { now: this.now } : {}),
        });
        const modelConfig = resolveMastraModelConfig(
            this.readModelConfig,
            'modelConfig' in input ? (input as ICheckpointRestoreInput & {
                modelConfig?: IAgentRuntimeModelConfigInput | undefined;
            }).modelConfig : undefined,
        );

        if (!modelConfig) {
            return createErrorResponse(
                sessionId,
                'AI 模型未配置：请先在应用设置中完成 Mastra 模型配置。',
                events,
                options,
            );
        }

        try {
            const snapshot = await this.loadExecutionSnapshot(DurableStepIds.AGENTIC_LOOP, input.runId);

            if (!snapshot) {
                pushUiEvent(events, createRuntimeEvent({
                    type: 'rollback.restore.failed',
                    visibility: 'user',
                    level: 'error',
                    snapshotId,
                    errorMessage: '未找到可恢复的 checkpoint。',
                }), options);

                return createErrorResponse(
                    sessionId,
                    'Mastra 回滚恢复失败：未找到可恢复的 checkpoint。',
                    events,
                    options,
                );
            }

            if (snapshot.status === 'running') {
                pushUiEvent(events, createRuntimeEvent({
                    type: 'rollback.restore.failed',
                    visibility: 'user',
                    level: 'error',
                    snapshotId,
                    errorMessage: '当前 run 仍在执行，暂时不能回滚。',
                }), options);

                return createErrorResponse(
                    sessionId,
                    'Mastra 回滚恢复失败：当前 run 仍在执行，暂时不能回滚。',
                    events,
                    options,
                );
            }

            const systemPrompt = resolveSystemPromptFromSnapshot(snapshot);

            if (!systemPrompt) {
                pushUiEvent(events, createRuntimeEvent({
                    type: 'rollback.restore.failed',
                    visibility: 'user',
                    level: 'error',
                    snapshotId,
                    errorMessage: 'checkpoint 缺少可恢复的系统提示词。',
                }), options);

                return createErrorResponse(
                    sessionId,
                    'Mastra 回滚恢复失败：checkpoint 缺少可恢复的系统提示词。',
                    events,
                    options,
                );
            }

            const workspaceRootPath = resolveWorkspaceRootPathFromSnapshot(snapshot);
            const {
                bundle: mcpBundle,
                tools: mastraTools,
                hasTools,
                workspace,
                browser,
            } = await loadMastraMcpTools(
                this.mcpGatewayPool,
                workspaceRootPath,
                this.loggerRef,
                [],
                'write',
                {
                    mode: 'agent',
                    goal: '恢复 Mastra checkpoint',
                    messages: [],
                },
            );

            try {
                const executionHandle = await this.createExecutionHandle({
                    id: DEFAULT_EXECUTION_AGENT_ID,
                    name: DEFAULT_EXECUTION_AGENT_NAME,
                    instructions: systemPrompt,
                    model: createMastraModelConfig(modelConfig),
                    ...(hasTools ? { tools: mastraTools } : {}),
                    ...(workspace ? { workspace } : {}),
                    ...(browser ? { browser } : {}),
                    inputProcessors: createMastraAgentInputProcessors(),
                    outputProcessors: createMastraAgentOutputProcessors(),
                });
                const run = await executionHandle.workflow.createRun({ runId: input.runId });
                const requestContextRecord = requestContextToRecord(snapshot.requestContext);
                const requestContext = requestContextRecord
                    ? createMastraRequestContext(requestContextRecord)
                    : undefined;

                pushUiEvent(events, createRuntimeEvent({
                    type: 'rollback.restore.started',
                    visibility: 'user',
                    level: 'info',
                    snapshotId,
                }), options);

                const restoreResult = await run.timeTravel({
                    step: input.step ?? DEFAULT_ROLLBACK_STEP,
                    ...(requestContext ? { requestContext } : {}),
                });
                const restoreMessage = extractRestoreResultText(restoreResult)
                    ?? '已使用 Mastra 官方 timeTravel 恢复到最近 checkpoint。';

                pushUiEvent(events, createRuntimeEvent({
                    type: 'rollback.restore.completed',
                    visibility: 'user',
                    level: 'info',
                    snapshotId,
                    savedAsLatest: true,
                    message: restoreMessage,
                }), options);
                pushUiEvent(events, {
                    type: 'done',
                    result: restoreMessage,
                }, options);

                return {
                    sessionId,
                    events,
                    result: restoreMessage,
                };
            } catch (error) {
                pushUiEvent(events, createRuntimeEvent({
                    type: 'rollback.restore.failed',
                    visibility: 'user',
                    level: 'error',
                    snapshotId,
                    errorMessage: normalizeMastraError(error),
                }), options);

                return createErrorResponse(
                    sessionId,
                    `Mastra 回滚恢复失败：${normalizeMastraError(error)}`,
                    events,
                    options,
                );
            } finally {
                await mcpBundle.disconnectAll();
                await destroyMastraWorkspace(workspace);
                await destroyMastraBrowser(browser);
            }
        } catch (error) {
            pushUiEvent(events, createRuntimeEvent({
                type: 'rollback.restore.failed',
                visibility: 'user',
                level: 'error',
                snapshotId,
                errorMessage: normalizeMastraError(error),
            }), options);

            return createErrorResponse(
                sessionId,
                `Mastra 回滚恢复失败：${normalizeMastraError(error)}`,
                events,
                options,
            );
        }
    }
}
