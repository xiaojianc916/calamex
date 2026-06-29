import { MastraRuntimeApproval } from '../approval/client.js';
import { createMastraModelConfig, resolveMastraModelConfig } from '../agent/factory.js';
import { extractRestoreResultText, resolveSystemPromptFromSnapshot, resolveWorkspaceRootPathFromSnapshot } from '../context/context.js';
import { normalizeMastraError, classifyProviderErrorCode } from '../shared/errors.js';
import { createErrorResponse } from '../responses/responses.js';
import { getSessionMessageText } from '../session/session-messages.js';
import { loadMastraMcpTools } from '../../tools/index.js';
import { DEFAULT_EXECUTION_AGENT_ID, DEFAULT_EXECUTION_AGENT_NAME, DEFAULT_ROLLBACK_STEP, type TMastraChatMessage } from '../shared/types.js';
import { createMastraRequestContext, createRuntimeEventFactory, createSessionId, pushUiEvent, requestContextToRecord } from '../shared/utils.js';
import { createMastraAgentInputProcessors, createMastraAgentOutputProcessors, destroyMastraBrowser, destroyMastraWorkspace } from '../workspace/workspace.js';
import type { IAgentRuntimeResponse, IAgentRuntimeRunOptions, TAgentRuntimeOutputEvent } from '../contracts/runtime-contracts.js';
import type { IAgentRuntimeInput, IAgentRuntimeModelConfigInput, ICheckpointRestoreInput } from '../contracts/runtime-input.js';
import { DurableStepIds } from '@mastra/core/agent/durable';


export class MastraRuntime extends MastraRuntimeApproval {
    /**
     * 原始模型透传（仿 Zed 独立模型请求的 utility 用法：标题生成 / 行内补全 / 连接测试）。
     *
     * 与 chat/plan/execute 的本质区别——**不**调用 buildSystemPrompt、不挂工具、不挂记忆、
     * 不读会话历史、不投影过程事件。调用方传入的 system 消息合并为 instructions，其余
     * user/assistant 消息按原序映射为模型消息后直接 generate。这些「工具型」一次性调用
     * 必须由调用方完全掌控 prompt，绝不能被 ask 模式自建的 Calamex 助手人格 / Agent 模式
     * 指令 / 工具策略污染（见 prompts/system-prompt.ts 的 buildSystemPrompt）。
     *
     * 非流式：utility 调用要的是完整结果，故用 agent.generate 而非 stream。
     */
    async modelChat(
        input: IAgentRuntimeInput,
        options: IAgentRuntimeRunOptions = {},
    ): Promise<IAgentRuntimeResponse> {
        const sessionId = input.sessionId ?? createSessionId('mastra-model-chat');
        const events: TAgentRuntimeOutputEvent[] = [];
        const modelConfig = resolveMastraModelConfig(
            this.readModelConfig,
            input.modelConfig,
        );

        if (!modelConfig) {
            return createErrorResponse(
                sessionId,
                'AI 模型未配置：请先在应用设置中完成模型配置。',
                events,
                options,
            );
        }

        // system → instructions（合并、保序、去空）；调用方未给 system 时 instructions 为空，
        // 不臆造任何人格——这正是「原始透传」的语义。
        const instructions = input.messages
            .filter((message) => message.role === 'system')
            .map((message) => getSessionMessageText(message.content).trim())
            .filter((text) => text.length > 0)
            .join('\n\n');

        // 其余角色按原序映射为模型消息（逐分支构造以匹配 TMastraChatMessage 的可辨识联合）。
        const conversation = input.messages.flatMap<TMastraChatMessage>((message) => {
            if (message.role !== 'user' && message.role !== 'assistant') {
                return [];
            }
            const content = getSessionMessageText(message.content);
            if (content.trim().length === 0) {
                return [];
            }
            return message.role === 'user'
                ? [{ role: 'user', content }]
                : [{ role: 'assistant', content }];
        });

        if (conversation.length === 0) {
            return createErrorResponse(
                sessionId,
                '原始模型透传至少需要一条非空的 user/assistant 消息。',
                events,
                options,
            );
        }

        try {
            const agent = this.createAgent({
                id: DEFAULT_EXECUTION_AGENT_ID,
                name: DEFAULT_EXECUTION_AGENT_NAME,
                instructions,
                model: createMastraModelConfig(modelConfig),
            });
            const result = await agent.generate(conversation, (options.context?.signal
                    ? { abortSignal: options.context.signal }
                    : {}));
            const text = typeof result.text === 'string' ? result.text : '';
            return { sessionId, events, result: text };
        } catch (error) {
            return createErrorResponse(
                sessionId,
                `原始模型透传失败：${normalizeMastraError(error)}`,
                events,
                options,
                classifyProviderErrorCode(error),
            );
        }
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

        const failRestore = (errorMessage: string): IAgentRuntimeResponse => {
            pushUiEvent(events, createRuntimeEvent({
                type: 'rollback.restore.failed',
                visibility: 'user',
                level: 'error',
                snapshotId,
                errorMessage,
            }), options);

            return createErrorResponse(
                sessionId,
                `Mastra 回滚恢复失败：${errorMessage}`,
                events,
                options,
            );
        };

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
                return failRestore('未找到可恢复的 checkpoint。');
            }

            if (snapshot.status === 'running') {
                return failRestore('当前 run 仍在执行，暂时不能回滚。');
            }

            const systemPrompt = resolveSystemPromptFromSnapshot(snapshot);

            if (!systemPrompt) {
                return failRestore('checkpoint 缺少可恢复的系统提示词。');
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

                return {
                    sessionId,
                    events,
                    result: restoreMessage,
                };
            } catch (error) {
                return failRestore(normalizeMastraError(error));
            } finally {
                await mcpBundle.disconnectAll();
                await destroyMastraWorkspace(workspace);
                await destroyMastraBrowser(browser);
            }
        } catch (error) {
            return failRestore(normalizeMastraError(error));
        }
    }
}
