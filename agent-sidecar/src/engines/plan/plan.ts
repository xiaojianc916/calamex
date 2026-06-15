import { MastraRuntimeChat } from '../chat/chat.js';
import { createDeepSeekReasoningRunPrefix, evictDeepSeekReasoningByPrefix, runWithDeepSeekReasoningContext } from '../../models/providers/deepseek-reasoning-fetch.js';
import { agentPlanGenerationSchema } from '../../schemas/plan.js';
import { buildSystemPrompt } from '../prompts/system-prompt.js';
import { createMastraMemoryReference, createMastraMemoryScope, resolveObservationalMemoryEnabled, resolveSemanticRecallEnabled } from '../context/memory.js';
import { createExecutionRequestContext } from '../context/context.js';
import { createMastraMemoryForModel, createMastraModelConfig, resolveMastraModelConfig } from '../agent/factory.js';
import { createAcontextTokenEventDraft, createDeepSeekPayloadEventSink } from '../budget/budget.js';
import { normalizeMastraError } from '../errors.js';
import { buildMastraMessages } from '../session/session-messages.js';
import { normalizeGeneratedAgentPlan } from './plan-utils.js';
import { createErrorResponse, createPlanRecordResponse, createPlanResponse } from '../responses.js';
import { loadMastraMcpTools } from '../tools/tools.js';
import { DEFAULT_EXECUTION_AGENT_ID } from '../types.js';
import type { IMastraGenerateOptions } from '../types.js';
import { attachMcpGatewayMetrics, createRuntimeEventFactory, createSessionId, pushUiEvent } from '../utils.js';
import { createMastraAgentInputProcessors, createMastraAgentOutputProcessors, destroyMastraBrowser, destroyMastraWorkspace } from '../workspace.js';
import type { IAgentRuntimeResponse, IAgentRuntimeRunOptions, TAgentRuntimeOutputEvent } from '../contracts/runtime-contracts.js';
import type { IAgentRuntimeInput, IPlanApprovalInput, IPlanFinishInput, IPlanQueryInput, IPlanRejectInput } from '../contracts/runtime-input.js';


export class MastraRuntimePlan extends MastraRuntimeChat {
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
                'AI 模型未配置：请在 Node sidecar 环境设置 AGENT_SIDECAR_MODEL 与 AGENT_SIDECAR_API_KEY。',
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
        const payloadEventSink = createDeepSeekPayloadEventSink(events, options);
        let shouldDisconnectBundle = true;

        try {
            return await runWithDeepSeekReasoningContext({
                sessionId,
                runId: requestedRunId,
                onRequestPayload: payloadEventSink.onRequestPayload,
            }, async () => {
                const systemPrompt = buildSystemPrompt(planInput, modelConfig.modelId);
                // 计划模式与 chat/agent 共用同一条流式脊柱：当存在工具（含 ask_user 反向提问）时，
                // 复用 chat.ts 同款可恢复 agent handle，使 ask_user 在规划阶段也能挂起/恢复。
                const resumableAgentHandle = hasAgentTools && this.shouldUseRegisteredAgentForTools
                    ? await this.createResumableAgentHandle({
                        id: 'calamex-agent-sidecar-plan',
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
                    id: 'calamex-agent-sidecar-plan',
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
                const streamOptions: IMastraGenerateOptions = {
                    maxSteps: hasAgentTools ? 10 : 1,
                    toolChoice,
                    structuredOutput: {
                        schema: agentPlanGenerationSchema,
                        ...(hasAgentTools ? { jsonPromptInjection: true } : {}),
                    },
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
                payloadEventSink.attachRuntimeEventFactory(createRuntimeEvent);
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
                // 先经 consumeTextStream 消费 fullStream（投影推理/正文/工具事件，并让
                // ask_user 反向提问得以挂起），再读取 Mastra 官方 MastraModelOutput.object
                // 取最终计划对象；计划持久化一律后置到对象解析成功之后，避免半成品计划落库。
                const stream = await agent.stream(mastraMessages, streamOptions);
                const streamSummary = await this.consumeTextStream(
                    agent,
                    mcpBundle,
                    sessionId,
                    stream,
                    events,
                    options,
                    createRuntimeEvent,
                    workspace,
                    browser,
                );
                shouldDisconnectBundle = streamSummary.releaseResources;

                if (streamSummary.streamErrorMessage) {
                    return createErrorResponse(
                        sessionId,
                        `Mastra Plan 执行失败：${streamSummary.streamErrorMessage}`,
                        events,
                        options,
                    );
                }

                if (streamSummary.pendingApproval) {
                    // 规划阶段触发 ask_user 反向提问（或其它挂起工具）：事件流已带出
                    // ask_user_required，所持 bundle/workspace/browser 不在此回收，待用户经
                    // ask-user resume 续跑后再完成计划生成。
                    return {
                        sessionId,
                        events,
                        result: null,
                    };
                }

                let planObject: unknown;
                try {
                    planObject = stream.object ? await stream.object : undefined;
                } catch {
                    // 结构化对象解析失败（模型未产出合规对象）：降级到统一的
                    // “没有返回有效 AgentPlan” 错误，保留精确语义而非抛给外层泛化错误。
                    planObject = undefined;
                }
                const parsedPlan = normalizeGeneratedAgentPlan(planObject, input.goal);

                if (!parsedPlan) {
                    return createErrorResponse(
                        sessionId,
                        'Mastra structured output 没有返回有效 AgentPlan，计划未生成。',
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
            });
        } catch (error) {
            return createErrorResponse(
                sessionId,
                `Mastra Plan 执行失败：${normalizeMastraError(error)}`,
                [],
                options,
            );
        } finally {
            evictDeepSeekReasoningByPrefix(createDeepSeekReasoningRunPrefix(sessionId, requestedRunId));
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
