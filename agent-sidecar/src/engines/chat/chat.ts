import { MastraRuntimeBase } from '../base.js';
import { createDeepSeekReasoningRunPrefix, evictDeepSeekReasoningByPrefix, runWithDeepSeekReasoningContext } from '../../models/providers/deepseek-reasoning-fetch.js';
import { createMcpGatewayRunBundle } from '../../tools/mcp-gateway.js';
import { buildSystemPrompt } from '../prompts/system-prompt.js';
import { createMastraMemoryReference, createMastraMemoryScope } from '../context/memory.js';
import { createMastraMemoryForModel, createMastraModelConfig, resolveMastraModelConfig } from '../agent/factory.js';
import { createAcontextTokenEventDraft, createDeepSeekPayloadEventSink } from '../budget/budget.js';
import { createExecutionRequestContext } from '../context/context.js';
import { normalizeMastraError } from '../errors.js';
import { buildMastraMessages, hasImageAttachmentParts, isVisionModelId } from '../session/session-messages.js';
import { createErrorResponse } from '../responses.js';
import { createDoneOutputEvent } from '../stream/stream-utils.js';
import { loadMastraMcpTools } from '../tools/tools.js';
import { DEFAULT_EXECUTION_AGENT_ID, DEFAULT_EXECUTION_AGENT_NAME } from '../types.js';
import type { IMastraGenerateOptions } from '../types.js';
import { attachMcpGatewayMetrics, createRuntimeEventFactory, createSessionId, pushUiEvent } from '../utils.js';
import { createMastraAgentInputProcessors, createMastraAgentOutputProcessors, createMastraTextModeExecutionPlan, destroyMastraBrowser, destroyMastraWorkspace } from '../workspace.js';
import type { IAgentRuntimeResponse, IAgentRuntimeRunOptions, TAgentRuntimeOutputEvent } from '../contracts/runtime-contracts.js';
import type { IAgentRuntimeInput } from '../contracts/runtime-input.js';


export class MastraRuntimeChat extends MastraRuntimeBase {
    private async runTextMode(
        input: IAgentRuntimeInput,
        mode: IAgentRuntimeInput['mode'],
        sessionPrefix: string,
        options: IAgentRuntimeRunOptions = {},
    ): Promise<IAgentRuntimeResponse> {
        const normalizedInput: IAgentRuntimeInput = {
            ...input,
            mode,
        };
        const sessionId = normalizedInput.sessionId ?? createSessionId(sessionPrefix);
        const events: TAgentRuntimeOutputEvent[] = [];
        const modelConfig = resolveMastraModelConfig(this.readModelConfig, normalizedInput.modelConfig);
        const executionPlan = createMastraTextModeExecutionPlan(normalizedInput);

        if (!modelConfig) {
            return createErrorResponse(
                sessionId,
                'AI 模型未配置：请在 Node sidecar 环境设置 AGENT_SIDECAR_MODEL 与 AGENT_SIDECAR_API_KEY。',
                events,
                options,
            );
        }

        if (hasImageAttachmentParts(normalizedInput.context) && !isVisionModelId(modelConfig.modelId)) {
            return createErrorResponse(
                sessionId,
                '当前模型不支持图片理解，请切换支持视觉输入的模型后再发送图片。',
                events,
                options,
            );
        }

        const {
            bundle: mcpBundle,
            tools: mastraTools,
            hasTools,
            toolStats,
            mcpGatewayMetrics,
            workspace,
            browser,
        } = executionPlan.useTools
                ? await loadMastraMcpTools(
                    this.mcpGatewayPool,
                    normalizedInput.workspaceRootPath,
                    this.loggerRef,
                    normalizedInput.context ?? [],
                    normalizedInput.mode === 'agent' ? 'write' : 'readonly',
                    normalizedInput,
                )
                : {
                    bundle: createMcpGatewayRunBundle(),
                    tools: {},
                    hasTools: false,
                    toolStats: {
                        toolCount: 0,
                        mcpToolCount: 0,
                        mcpServerCount: 0,
                        mcpServerNames: [],
                        uiContextToolCount: 0,
                        nativeToolCount: 0,
                        logToolCount: 0,
                        toolSchemaCharCount: 0,
                        toolLoadStrategy: 'none',
                    },
                    mcpGatewayMetrics: this.mcpGatewayPool.createMetricBuffer(),
                    workspace: undefined,
                    browser: undefined,
                };
        const hasAgentTools = hasTools || Boolean(workspace) || Boolean(browser);
        const requestedRunId = options.context?.requestId ?? createSessionId(`${sessionPrefix}-run`);
        const memory = executionPlan.useMemory
            ? createMastraMemoryReference(
                createMastraMemoryScope(
                    normalizedInput,
                    sessionId,
                    executionPlan.useTools ? { resourceScope: 'session' } : {},
                ),
            )
            : null;
        const agentMemory = executionPlan.useMemory
            ? createMastraMemoryForModel(modelConfig)
            : undefined;
        const systemPrompt = buildSystemPrompt(normalizedInput, modelConfig.modelId);
        const payloadEventSink = createDeepSeekPayloadEventSink(events, options);
        let shouldDisconnectBundle = true;

        try {
            return await runWithDeepSeekReasoningContext({
                sessionId,
                runId: requestedRunId,
                onRequestPayload: payloadEventSink.onRequestPayload,
            }, async () => {
                const resumableAgentHandle = hasAgentTools && this.shouldUseRegisteredAgentForTools
                    ? await this.createResumableAgentHandle({
                        id: DEFAULT_EXECUTION_AGENT_ID,
                        name: DEFAULT_EXECUTION_AGENT_NAME,
                        instructions: systemPrompt,
                        model: createMastraModelConfig(modelConfig),
                        ...(agentMemory ? { memory: agentMemory } : {}),
                        ...(hasTools ? { tools: mastraTools } : {}),
                        ...(workspace ? { workspace } : {}),
                        ...(browser ? { browser } : {}),
                        inputProcessors: createMastraAgentInputProcessors(),
                        outputProcessors: createMastraAgentOutputProcessors(),
                    })
                    : null;
                const agent = resumableAgentHandle?.agent ?? this.createAgent({
                    id: 'calamex-agent-sidecar',
                    name: 'Calamex Agent Sidecar',
                    instructions: systemPrompt,
                    model: createMastraModelConfig(modelConfig),
                    ...(agentMemory ? { memory: agentMemory } : {}),
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
                    ...(memory ? { memory } : {}),
                    ...(options.context?.signal ? { abortSignal: options.context.signal } : {}),
                    ...(resumableAgentHandle || options.context?.requestId ? { runId: requestedRunId } : {}),
                    ...(resumableAgentHandle && memory ? {
                        requestContext: createExecutionRequestContext(
                            normalizedInput,
                            systemPrompt,
                            memory,
                        ),
                    } : {}),
                };
                const mastraMessages = buildMastraMessages(normalizedInput);
                const stream = await agent.stream(mastraMessages, {
                    ...streamOptions,
                });
                const createRuntimeEvent = createRuntimeEventFactory({
                    runId: stream.runId ?? requestedRunId,
                    sessionId,
                    agentId: DEFAULT_EXECUTION_AGENT_ID,
                    ...(stream.traceId ? { traceId: stream.traceId } : {}),
                    ...(this.now ? { now: this.now } : {}),
                });
                payloadEventSink.attachRuntimeEventFactory(createRuntimeEvent);
                attachMcpGatewayMetrics(mcpGatewayMetrics, console);
                pushUiEvent(events, createRuntimeEvent(createAcontextTokenEventDraft({
                    systemPrompt,
                    messages: mastraMessages,
                    contextReferences: normalizedInput.context ?? [],
                    tools: mastraTools,
                    toolStats,
                    workspaceEnabled: Boolean(workspace),
                    browserEnabled: Boolean(browser),
                    memoryEnabled: Boolean(memory),
                    maxSteps: streamOptions.maxSteps ?? 1,
                    toolChoice,
                })), options);
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
                        `Mastra Agent 执行失败：${streamSummary.streamErrorMessage}`,
                        events,
                        options,
                    );
                }

                if (streamSummary.pendingApproval) {
                    return {
                        sessionId,
                        events,
                        result: null,
                    };
                }

                const result = streamSummary.visibleText.trim().length > 0
                    ? streamSummary.visibleText
                    : 'Agent 已完成。';
                const doneEvent: TAgentRuntimeOutputEvent = createDoneOutputEvent(
                    result,
                    streamSummary.doneTokenSnapshot,
                );

                pushUiEvent(events, doneEvent, options);

                return {
                    sessionId,
                    events,
                    result,
                };
            });
        } catch (error) {
            return createErrorResponse(
                sessionId,
                `Mastra Agent 执行失败：${normalizeMastraError(error)}`,
                events,
                options,
            );
        } finally {
            if (shouldDisconnectBundle) {
                evictDeepSeekReasoningByPrefix(createDeepSeekReasoningRunPrefix(sessionId, requestedRunId));
                await mcpBundle.disconnectAll();
                await destroyMastraWorkspace(workspace);
                await destroyMastraBrowser(browser);
            }
        }
    }

    async chat(
        input: IAgentRuntimeInput,
        options: IAgentRuntimeRunOptions = {},
    ): Promise<IAgentRuntimeResponse> {
        return this.runTextMode(input, input.mode ?? 'ask', 'mastra-chat', options);
    }
}
