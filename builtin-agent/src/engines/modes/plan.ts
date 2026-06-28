import { existsSync, readFileSync } from 'node:fs';
import { MastraRuntimeChat } from './chat.js';

import { buildSystemPrompt } from '../prompts/system-prompt.js';
import { createMastraMemoryReference, createMastraMemoryScope, resolveObservationalMemoryEnabled, resolveSemanticRecallEnabled } from '../context/memory.js';
import { createExecutionRequestContext } from '../context/context.js';
import { createMastraMemoryForModel, createMastraModelConfig, resolveMastraModelConfig } from '../agent/factory.js';
import { createAcontextTokenEventDraft } from '../budget/budget.js';
import { normalizeMastraError } from '../shared/errors.js';
import { buildMastraMessages } from '../session/session-messages.js';
import { buildAgentPlanFromPlanSteps } from '../plan/plan-utils.js';
import { createErrorResponse, createPlanRecordResponse, createPlanResponse } from '../responses/responses.js';
import { loadMastraMcpTools } from '../../tools/index.js';
import { parsePlanSteps, resolvePlanFilePath } from '../../tools/plan/update-plan.js';
import { DEFAULT_EXECUTION_AGENT_ID } from '../shared/types.js';
import type { IMastraAgentLike, IMastraGenerateOptions, IMastraMcpBundle, TMastraChatMessage, TRuntimeEventFactory } from '../shared/types.js';
import { attachMcpGatewayMetrics, createRuntimeEventFactory, createSessionId, pushUiEvent } from '../shared/utils.js';
import { createMastraAgentInputProcessors, createMastraAgentOutputProcessors, destroyMastraBrowser, destroyMastraWorkspace } from '../workspace/workspace.js';
import type { IAgentRuntimeResponse, IAgentRuntimeRunOptions, TAgentRuntimeOutputEvent } from '../contracts/runtime-contracts.js';
import type { IAgentRuntimeInput, IPlanApprovalInput, IPlanFinishInput, IPlanQueryInput, IPlanRejectInput } from '../contracts/runtime-input.js';
import type { AnyWorkspace } from '@mastra/core/workspace';
import type { MastraBrowser } from '@mastra/core/browser';

/**
 * 计划族（plan / validate / replan）共享的「流式消费 + 可选结构化对象」结果。
 * - object：fullStream 正常消费完成后的 Mastra MastraModelOutput.object；validate/replan
 *   依赖它读取结构化结果，plan() 不使用它（计划唯一事实源是 PLAN.md）。
 * - pending：出现工具审批 / ask_user 反向提问挂起（仅 plan() 这类持可恢复 handle 的
 *   调用方支持续跑；validate/replan 视为不支持的挂起并降级为错误）。
 * - error：流内错误 / 中止。
 * releaseResources 透传自 consumeTextStream，交由调用方决定是否在 finally 释放重型资源。
 */
type TStreamStructuredPlanResult =
    | { status: 'object'; object: unknown; releaseResources: boolean }
    | { status: 'pending'; releaseResources: boolean }
    | { status: 'error'; message: string; releaseResources: boolean };

/**
 * Plan 模式 agent 循环的最大步数：需覆盖「只读调研 → 多次 update_plan 迭代 →
 * 可选 ask_user 反向提问 → exit_plan 收尾」。取一个宽裕上界，正常会在模型调用
 * exit_plan 后自然收束；即便触顶，update_plan 已落盘的 PLAN.md 仍可作为草稿桥接。
 */
const PLAN_AGENT_MAX_STEPS = 32;

export class MastraRuntimePlan extends MastraRuntimeChat {
    /**
     * 计划族共享的流式脊柱：先经 consumeTextStream 消费 fullStream（投影推理/正文/工具
     * 事件，并让工具审批 / ask_user 反向提问得以挂起），再按需读取 Mastra 官方
     * MastraModelOutput.object。validatePlan() / replanPlan() 仍使用结构化 object；plan()
     * 已切到 planning-as-tool，只复用 pending/error/done 的统一处理，不再兼容旧 JSON 计划生成。
     */
    protected async streamStructuredPlanObject(args: {
        agent: IMastraAgentLike;
        bundle: IMastraMcpBundle;
        sessionId: string;
        messages: TMastraChatMessage[];
        streamOptions: IMastraGenerateOptions;
        events: TAgentRuntimeOutputEvent[];
        options: IAgentRuntimeRunOptions;
        createRuntimeEvent: TRuntimeEventFactory;
        workspace?: AnyWorkspace | undefined;
        browser?: MastraBrowser | undefined;
    }): Promise<TStreamStructuredPlanResult> {
        const stream = await args.agent.stream(args.messages, args.streamOptions);
        const summary = await this.consumeTextStream(
            args.agent,
            args.bundle,
            args.sessionId,
            stream,
            args.events,
            args.options,
            args.createRuntimeEvent,
            args.workspace,
            args.browser,
        );

        if (summary.streamErrorMessage) {
            return { status: 'error', message: summary.streamErrorMessage, releaseResources: summary.releaseResources };
        }
        if (summary.pendingApproval) {
            return { status: 'pending', releaseResources: summary.releaseResources };
        }

        let object: unknown;
        try {
            object = stream.object ? await stream.object : undefined;
        } catch {
            // 结构化对象解析失败（模型未产出合规对象）：返回 undefined，由调用方降级为
            // 各自精确的「没有返回有效结构化结果」错误，而非抛给外层泛化错误。
            object = undefined;
        }
        return { status: 'object', object, releaseResources: summary.releaseResources };
    }

    async plan(
        input: IAgentRuntimeInput,
        options: IAgentRuntimeRunOptions = {},
    ): Promise<IAgentRuntimeResponse> {
        const sessionId = input.sessionId ?? createSessionId('mastra-plan');
        const events: TAgentRuntimeOutputEvent[] = [];
        const modelConfig = resolveMastraModelConfig(this.readModelConfig, input.modelConfig);

        if (!modelConfig) {
            return createErrorResponse(
                sessionId,
                'AI 模型未配置：请在 Node sidecar 环境设置 BUILTIN_AGENT_MODEL 与 BUILTIN_AGENT_API_KEY。',
                events,
                options,
            );
        }

        const planInput: IAgentRuntimeInput = {
            ...input,
            mode: 'plan',
        };
        const {
            bundle: mcpBundle,
            tools: mastraTools,
            hasTools,
            toolStats,
            mcpGatewayMetrics,
            workspace,
            browser,
        } = await loadMastraMcpTools(
            this.mcpGatewayPool,
            input.workspaceRootPath,
            this.loggerRef,
            input.context ?? [],
            'readonly',
            planInput,
        );
        const hasAgentTools = hasTools || Boolean(workspace) || Boolean(browser);
        const requestedRunId = options.context?.requestId ?? createSessionId('mastra-plan-run');
        const memory = createMastraMemoryReference(
            createMastraMemoryScope(
                input,
                sessionId,
                { resourceScope: 'session' },
            ),
        );
        const agentMemory = createMastraMemoryForModel(modelConfig);
        const observationalMemoryEnabled = resolveObservationalMemoryEnabled();
        const semanticRecallEnabled = resolveSemanticRecallEnabled();
        
        let shouldDisconnectBundle = true;

        try {
            
                const systemPrompt = buildSystemPrompt(planInput, modelConfig.modelId);
                // 计划模式与 chat/agent 共用同一条流式脊柱：plan 模式始终挂载规划工具
                // （update_plan / exit_plan）与 ask_user，故复用 chat.ts 同款可恢复 agent handle，
                // 使 ask_user 在规划阶段也能挂起/恢复。
                const resumableAgentHandle = hasAgentTools && this.shouldUseRegisteredAgentForTools
                    ? await this.createResumableAgentHandle({
                        id: 'calamex-builtin-agent-plan',
                        name: 'Calamex Agent Plan Sidecar',
                        instructions: systemPrompt,
                        model: createMastraModelConfig(modelConfig),
                        memory: agentMemory,
                        ...(hasTools ? { tools: mastraTools } : {}),
                        ...(workspace ? { workspace } : {}),
                        ...(browser ? { browser } : {}),
                        inputProcessors: createMastraAgentInputProcessors(),
                        outputProcessors: createMastraAgentOutputProcessors(),
                    })
                    : null;
                const agent = resumableAgentHandle?.agent ?? this.createAgent({
                    id: 'calamex-builtin-agent-plan',
                    name: 'Calamex Agent Plan Sidecar',
                    instructions: systemPrompt,
                    model: createMastraModelConfig(modelConfig),
                    memory: agentMemory,
                    ...(hasTools ? { tools: mastraTools } : {}),
                    ...(workspace ? { workspace } : {}),
                    ...(browser ? { browser } : {}),
                    inputProcessors: createMastraAgentInputProcessors(),
                    outputProcessors: createMastraAgentOutputProcessors(),
                });
                const toolChoice: IMastraGenerateOptions['toolChoice'] = hasAgentTools ? 'auto' : 'none';
                // planning-as-tool：不再用 structuredOutput.schema 让模型直接吐 JSON 计划；
                // 模型改为在多步循环中用只读工具调研、用 update_plan 写活体 PLAN.md、用 exit_plan 收尾。
                const streamOptions: IMastraGenerateOptions = {
                    maxSteps: hasAgentTools ? PLAN_AGENT_MAX_STEPS : 1,
                    toolChoice,
                    memory,
                    ...(options.context?.signal ? { abortSignal: options.context.signal } : {}),
                    runId: requestedRunId,
                    ...(resumableAgentHandle ? {
                        requestContext: createExecutionRequestContext(
                            planInput,
                            systemPrompt,
                            memory,
                        ),
                    } : {}),
                };
                const mastraMessages = buildMastraMessages(planInput);
                const createRuntimeEvent = createRuntimeEventFactory({
                    runId: requestedRunId,
                    sessionId,
                    agentId: DEFAULT_EXECUTION_AGENT_ID,
                    ...(this.now ? { now: this.now } : {}),
                });
                
                attachMcpGatewayMetrics(mcpGatewayMetrics, console);
                pushUiEvent(events, createRuntimeEvent(createAcontextTokenEventDraft({
                    systemPrompt,
                    messages: mastraMessages,
                    contextReferences: input.context ?? [],
                    tools: mastraTools,
                    toolStats,
                    workspaceEnabled: Boolean(workspace),
                    browserEnabled: Boolean(browser),
                    memoryEnabled: true,
                    observationalMemoryEnabled,
                    semanticRecallEnabled,
                    maxSteps: streamOptions.maxSteps ?? 1,
                    toolChoice,
                    modelCapabilities: modelConfig.capabilities,
                })), options);
                // 共享流式脊柱：消费 fullStream（含 ask_user 挂起投影、工具事件）。Plan 模式不读取
                // 结构化对象——计划改由 update_plan 写入的活体 PLAN.md 承载，streamed.object 在此
                // 被有意忽略，仅复用 pending/error/done 的统一处理。
                const streamed = await this.streamStructuredPlanObject({
                    agent,
                    bundle: mcpBundle,
                    sessionId,
                    messages: mastraMessages,
                    streamOptions,
                    events,
                    options,
                    createRuntimeEvent,
                    workspace,
                    browser,
                });
                shouldDisconnectBundle = streamed.releaseResources;

                if (streamed.status === 'error') {
                    return createErrorResponse(
                        sessionId,
                        `Mastra Plan 执行失败：${streamed.message}`,
                        events,
                        options,
                    );
                }

                if (streamed.status === 'pending') {
                    // 规划阶段触发 ask_user 反向提问（或其它挂起工具）：事件流已带出
                    // ask_user_required，所持 bundle/workspace/browser 不在此回收，待用户经
                    // ask-user resume 续跑后再完成计划生成。
                    return {
                        sessionId,
                        events,
                        result: null,
                    };
                }

                // agent 规划循环正常结束。活体 PLAN.md 是计划的唯一事实源（update_plan 写入、
                // exit_plan 校验交付）；据其 canonical Steps 区解析出有序步骤文本，再桥接到
                // 既有严格计划存储与编排结构。
                const planFilePath = resolvePlanFilePath({
                    workspaceRootPath: input.workspaceRootPath,
                    threadId: input.threadId,
                });
                const planMarkdown = existsSync(planFilePath)
                    ? readFileSync(planFilePath, 'utf-8')
                    : '';
                const planSteps = parsePlanSteps(planMarkdown);

                if (planSteps.length === 0) {
                    return createErrorResponse(
                        sessionId,
                        '规划未产出有效 PLAN.md：应先用 update_plan 写入计划（含可解析的有序 Steps 区）再调用 exit_plan 收尾。',
                        events,
                        options,
                    );
                }

                const parsedPlan = buildAgentPlanFromPlanSteps(input.goal, planSteps);

                if (!parsedPlan) {
                    return createErrorResponse(
                        sessionId,
                        '从 PLAN.md 解析出的步骤无法构建有效 AgentPlan，计划未生成。',
                        events,
                        options,
                    );
                }

                const record = await this.planStore.createPendingPlan({
                    ...(input.planId ? { planId: input.planId } : {}),
                    threadId: input.threadId ?? sessionId,
                    userRequest: input.goal,
                    plan: parsedPlan,
                });
                await this.planWorkflowStore.createForPlan({ record });

                return createPlanResponse(sessionId, record, events, options);
            
        } catch (error) {
            return createErrorResponse(
                sessionId,
                `Mastra Plan 执行失败：${normalizeMastraError(error)}`,
                [],
                options,
            );
        } finally {
            
            if (shouldDisconnectBundle) {
                await mcpBundle.disconnectAll();
                await destroyMastraWorkspace(workspace);
                await destroyMastraBrowser(browser);
            }
        }
    }

    async approvePlan(
        input: IPlanApprovalInput,
        options: IAgentRuntimeRunOptions = {},
    ): Promise<IAgentRuntimeResponse> {
        const sessionId = input.sessionId ?? createSessionId('mastra-plan-approve');

        try {
            const record = await this.planStore.approvePlan(input);
            await this.planWorkflowStore.approvePlan(record);
            const versions = await this.planStore.listPlanVersions(record.planId);
            return createPlanRecordResponse(
                sessionId,
                record,
                versions,
                `计划 ${record.planId}@v${record.version} 已批准。`,
                [],
                options,
            );
        } catch (error) {
            return createErrorResponse(
                sessionId,
                `批准计划失败：${normalizeMastraError(error)}`,
                [],
                options,
            );
        }
    }

    async getPlan(
        input: IPlanQueryInput,
        options: IAgentRuntimeRunOptions = {},
    ): Promise<IAgentRuntimeResponse> {
        const sessionId = input.sessionId ?? createSessionId('mastra-plan-query');

        try {
            const record = await this.planStore.getPlan(input);
            const versions = await this.planStore.listPlanVersions(record.planId);
            return createPlanRecordResponse(
                sessionId,
                record,
                versions,
                `已读取计划 ${record.planId}@v${record.version}。`,
                [],
                options,
            );
        } catch (error) {
            return createErrorResponse(
                sessionId,
                `读取计划失败：${normalizeMastraError(error)}`,
                [],
                options,
            );
        }
    }

    async rejectPlan(
        input: IPlanRejectInput,
        options: IAgentRuntimeRunOptions = {},
    ): Promise<IAgentRuntimeResponse> {
        const sessionId = input.sessionId ?? createSessionId('mastra-plan-reject');

        try {
            const record = await this.planStore.rejectPlan(input);
            await this.planWorkflowStore.rejectPlan(record, input.reason);
            const versions = await this.planStore.listPlanVersions(record.planId);
            return createPlanRecordResponse(
                sessionId,
                record,
                versions,
                `计划 ${record.planId}@v${record.version} 已拒绝。`,
                [],
                options,
            );
        } catch (error) {
            return createErrorResponse(
                sessionId,
                `拒绝计划失败：${normalizeMastraError(error)}`,
                [],
                options,
            );
        }
    }

    async finishPlan(
        input: IPlanFinishInput,
        options: IAgentRuntimeRunOptions = {},
    ): Promise<IAgentRuntimeResponse> {
        const sessionId = input.sessionId ?? createSessionId('mastra-plan-finish');

        try {
            const record = await this.planStore.finishPlan(input);
            await this.planWorkflowStore.finishPlan({
                planId: record.planId,
                version: record.version,
                status: input.status,
                ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
            });
            const versions = await this.planStore.listPlanVersions(record.planId);
            const statusLabel = input.status === 'completed' ? '已完成' : '已失败';
            return createPlanRecordResponse(
                sessionId,
                record,
                versions,
                `计划 ${record.planId}@v${record.version} ${statusLabel}。`,
                [],
                options,
            );
        } catch (error) {
            return createErrorResponse(
                sessionId,
                `更新计划状态失败：${normalizeMastraError(error)}`,
                [],
                options,
            );
        }
    }
}
