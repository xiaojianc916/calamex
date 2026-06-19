import { MastraRuntimeBase } from '../runtime/base.js';
import { createMcpGatewayRunBundle } from '../../tools/mcp/index.js';
import { buildSystemPrompt } from '../prompts/system-prompt.js';
import { createMastraMemoryReference, createMastraMemoryScope } from '../context/memory.js';
import { createMastraMemoryForModel, createMastraModelConfig, resolveMastraModelConfig } from '../agent/factory.js';
import { createAcontextTokenEventDraft } from '../budget/budget.js';
import { createExecutionRequestContext } from '../context/context.js';
import { normalizeMastraError } from '../shared/errors.js';
import { buildMastraMessages, hasImageAttachmentParts, isVisionModelId } from '../session/session-messages.js';
import { createErrorResponse } from '../responses/responses.js';
import { loadMastraMcpTools } from '../../tools/index.js';
import { DEFAULT_EXECUTION_AGENT_ID, DEFAULT_EXECUTION_AGENT_NAME } from '../shared/types.js';
import type { IMastraGenerateOptions } from '../shared/types.js';
import { attachMcpGatewayMetrics, createRuntimeEventFactory, createSessionId, pushUiEvent } from '../shared/utils.js';
import { createMastraAgentInputProcessors, createMastraAgentOutputProcessors, createMastraTextModeExecutionPlan, destroyMastraBrowser, destroyMastraWorkspace } from '../workspace/workspace.js';
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
        let shouldDisconnectBundle = true;

        try {
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
            // [diag] 临时诊断（只读、可回滚）：透传包装 fullStream，逐块打印 chunk 类型，
            // 用于定位“空气泡”根因——确认 sidecar 究竟产出了哪些 chunk、是否累积出正文。
            let diagChunkCount = 0;
            const diagFullStream = (async function* () {
                for await (const rawChunk of stream.stream) {
                    diagChunkCount += 1;
                    const chunkType = (rawChunk as { type?: unknown }).type;
                    process.stderr.write(
                        `[diag] chunk #${diagChunkCount} type=${typeof chunkType === 'string' ? chunkType : typeof chunkType}\n`,
                    );
                    yield rawChunk;
                }
            })();
            const diagStream = { ...stream, fullStream: diagFullStream };
            const createRuntimeEvent = createRuntimeEventFactory({
                runId: stream.runId ?? requestedRunId,
                sessionId,
                agentId: DEFAULT_EXECUTION_AGENT_ID,
                ...(stream.traceId ? { traceId: stream.traceId } : {}),
                ...(this.now ? { now: this.now } : {}),
            });
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
                diagStream,
                events,
                options,
                createRuntimeEvent,
                workspace,
                browser,
            );
            shouldDisconnectBundle = streamSummary.releaseResources;

            // [diag] 临时诊断（只读、可回滚）：打印本回合汇总——总 chunk 数、正文长度/预览、
            // 是否挂起、是否有流错误。配合上面的逐块类型，足以判定空气泡来自 sidecar 还是下游投影。
            process.stderr.write(
                `[diag] streamSummary ${JSON.stringify({
                    chunkCount: diagChunkCount,
                    visibleTextLength: streamSummary.visibleText.length,
                    visiblePreview: streamSummary.visibleText.slice(0, 120),
                    pendingApproval: streamSummary.pendingApproval,
                    streamErrorMessage: streamSummary.streamErrorMessage,
                })}\n`,
            );

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

            // [diag] 临时诊断（只读、可回滚）：打印本回合最终 result——若此处非空但前端气泡为空，
            // 则根因在 sidecar→Rust 信封解析 / done 帧字段，而非文本累积。
            process.stderr.write(
                `[diag] result length=${result.length} preview=${JSON.stringify(result.slice(0, 120))}\n`,
            );

            return {
                sessionId,
                events,
                result,
                ...(streamSummary.doneTokenSnapshot ? { usage: streamSummary.doneTokenSnapshot } : {}),
            };
        } catch (error) {
            return createErrorResponse(
                sessionId,
                `Mastra Agent 执行失败：${normalizeMastraError(error)}`,
                events,
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

    async chat(
        input: IAgentRuntimeInput,
        options: IAgentRuntimeRunOptions = {},
    ): Promise<IAgentRuntimeResponse> {
        return this.runTextMode(input, input.mode ?? 'ask', 'mastra-chat', options);
    }
}
