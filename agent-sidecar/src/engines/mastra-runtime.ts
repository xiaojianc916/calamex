import { Agent, type ToolsInput } from '@mastra/core/agent';
import type { OpenAICompatibleConfig } from '@mastra/core/llm';
import { toStandardSchema } from '@mastra/core/schema';
import type {
    TextDeltaPayload,
    ToolCallPayload,
} from '@mastra/core/stream';
import { createTool } from '@mastra/core/tools';

import {
    createDeepSeekModelConfigFromEnv,
    type IDeepSeekModelConfig,
} from '../models/deepseek-model.js';
import type { TJsonValue } from '../schemas/events.js';
import { agentPlanSchema, type TAgentPlan } from '../schemas/plan.js';
import { createMastraMcpClientBundle } from '../tools/mcp.js';
import { buildSystemPrompt } from './agent-runtime-helpers.js';
import type {
    IAgentRuntimeResponse,
    IAgentRuntimeRunOptions,
    TAgentRuntimeOutputEvent,
} from './runtime-contracts.js';
import type {
    IAgentMessageInput,
    IAgentRuntimeInput,
    IApprovalResolutionInput,
} from './runtime-input.js';

type TMastraChatMessage = {
    role: 'user' | 'assistant';
    content: string;
};

interface IMastraAgentStreamLike {
    fullStream: AsyncIterable<unknown>;
}

interface IMastraApprovalOptions {
    runId: string;
    toolCallId?: string;
    abortSignal?: AbortSignal;
}

interface IMastraGenerateOptions {
    abortSignal?: AbortSignal;
    runId?: string;
    maxSteps?: number;
    toolChoice?: 'auto' | 'none';
    structuredOutput?: {
        schema: unknown;
    };
}

interface IMastraGenerateResultLike {
    object?: unknown;
    text?: string;
}

interface IMastraAgentLike {
    stream(
        messages: TMastraChatMessage[],
        options?: IMastraGenerateOptions,
    ): Promise<IMastraAgentStreamLike>;
    generate(
        messages: TMastraChatMessage[],
        options?: IMastraGenerateOptions,
    ): Promise<IMastraGenerateResultLike>;
    approveToolCall?: (options: IMastraApprovalOptions) => Promise<IMastraAgentStreamLike>;
    declineToolCall?: (options: IMastraApprovalOptions) => Promise<IMastraAgentStreamLike>;
}

interface IMastraAgentConfig {
    id: string;
    name: string;
    instructions: string;
    model: OpenAICompatibleConfig;
    tools?: ToolsInput;
}

interface IMcpToolLike {
    name: string;
    description: string;
    toolSpec: {
        inputSchema?: unknown;
    };
}

interface IMastraMcpBundle {
    tools: IMcpToolLike[];
    disconnectAll: () => Promise<void>;
}

interface IMastraRuntimeDeps {
    createAgent?: (config: IMastraAgentConfig) => IMastraAgentLike;
    readModelConfig?: () => IDeepSeekModelConfig | null;
    createMcpClientBundle?: (
        options?: { workspaceRootPath?: string | null },
    ) => Promise<IMastraMcpBundle>;
}

interface IMastraPendingApproval {
    agent: IMastraAgentLike;
    bundle: IMastraMcpBundle;
    runId: string;
    sessionId: string;
    toolCallId: string;
}

interface IMastraTextStreamSummary {
    pendingApproval: boolean;
    releaseResources: boolean;
    streamErrorMessage: string | null;
    visibleText: string;
}

const createSessionId = (prefix: string): string =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const APPROVAL_TOKEN_PREFIX = 'mastra-approval.';

const DEFAULT_TOOL_INPUT_SCHEMA = {
    type: 'object',
    properties: {},
    additionalProperties: false,
} as const;

const toRecord = (value: unknown): Record<string, unknown> | null => (
    value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
);

const toJsonValue = (value: unknown): TJsonValue => {
    if (
        value === null
        || typeof value === 'string'
        || typeof value === 'number'
        || typeof value === 'boolean'
    ) {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map((item) => toJsonValue(item));
    }

    const record = toRecord(value);
    if (!record) {
        return String(value);
    }

    return Object.fromEntries(
        Object.entries(record).map(([key, item]) => [key, toJsonValue(item)]),
    );
};

const pushUiEvent = (
    events: TAgentRuntimeOutputEvent[],
    event: TAgentRuntimeOutputEvent,
    options: IAgentRuntimeRunOptions = {},
): void => {
    events.push(event);
    options.onEvent?.(event);
};

const createMastraModelConfig = (
    modelConfig: IDeepSeekModelConfig,
): OpenAICompatibleConfig => {
    return {
        id: (modelConfig.model.includes('/')
            ? modelConfig.model
            : `deepseek/${modelConfig.model}`) as `${string}/${string}`,
        url: modelConfig.baseUrl,
        apiKey: modelConfig.apiKey,
    };
};

const defaultCreateAgent = (config: IMastraAgentConfig): IMastraAgentLike => {
    const agent = new Agent({
        id: config.id,
        name: config.name,
        instructions: config.instructions,
        model: config.model,
        ...(config.tools ? { tools: config.tools } : {}),
    });
    const bridge = agent as unknown as IMastraAgentLike;
    const approveToolCall = typeof bridge.approveToolCall === 'function'
        ? async (options: IMastraApprovalOptions): Promise<IMastraAgentStreamLike> => bridge.approveToolCall!(options)
        : undefined;
    const declineToolCall = typeof bridge.declineToolCall === 'function'
        ? async (options: IMastraApprovalOptions): Promise<IMastraAgentStreamLike> => bridge.declineToolCall!(options)
        : undefined;

    return {
        stream: async (messages, options) => bridge.stream(messages, options),
        generate: async (messages, options) => bridge.generate(messages, options),
        ...(approveToolCall ? { approveToolCall } : {}),
        ...(declineToolCall ? { declineToolCall } : {}),
    };
};

const getMcpToolClient = (tool: IMcpToolLike): {
    callTool: (targetTool: unknown, args: TJsonValue) => Promise<unknown>;
} | null => {
    const candidate = toRecord(tool)?.mcpClient;
    const client = toRecord(candidate);

    if (!client || typeof client.callTool !== 'function') {
        return null;
    }

    return {
        callTool: client.callTool as (targetTool: unknown, args: TJsonValue) => Promise<unknown>,
    };
};

const createMastraMcpTools = (
    tools: IMcpToolLike[],
): Record<string, ReturnType<typeof createTool>> => Object.fromEntries(
    tools.map((tool) => [tool.name, createTool({
        id: tool.name,
        description: tool.description,
        inputSchema: toStandardSchema(tool.toolSpec.inputSchema ?? DEFAULT_TOOL_INPUT_SCHEMA),
        execute: async (inputData) => {
            const client = getMcpToolClient(tool);

            if (!client) {
                throw new Error(`MCP tool ${tool.name} 缺少客户端句柄。`);
            }

            return toJsonValue(await client.callTool(tool, toJsonValue(inputData)));
        },
    })]),
);

const loadMastraMcpTools = async (
    createBundle: (
        options?: { workspaceRootPath?: string | null },
    ) => Promise<IMastraMcpBundle>,
    workspaceRootPath?: string,
): Promise<{
    bundle: IMastraMcpBundle;
    tools: ToolsInput;
    hasTools: boolean;
}> => {
    const bundle = await createBundle(workspaceRootPath
        ? { workspaceRootPath }
        : {});
    const tools = createMastraMcpTools(bundle.tools);

    return {
        bundle,
        tools,
        hasTools: Object.keys(tools).length > 0,
    };
};

const isConversationMessage = (
    message: IAgentMessageInput,
): message is IAgentMessageInput & { role: 'user' | 'assistant' } => (
    message.role === 'user' || message.role === 'assistant'
);

const findLastUserMessageIndex = (messages: IAgentMessageInput[]): number => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'user') {
            return index;
        }
    }

    return -1;
};

const buildMastraUserPrompt = (input: IAgentRuntimeInput): string => {
    const lastUserMessageIndex = findLastUserMessageIndex(input.messages);
    const lastUserContent = lastUserMessageIndex >= 0
        ? input.messages[lastUserMessageIndex]?.content.trim()
        : '';
    const request = lastUserContent || input.goal;
    const toolContext = input.messages
        .filter((message) => message.role === 'tool')
        .map((message, index) => `tool ${index + 1}: ${message.content}`)
        .join('\n');
    const goal = request === input.goal ? '' : `目标：${input.goal}`;

    return [
        goal,
        request,
        toolContext ? `工具上下文：\n${toolContext}` : '',
    ]
        .filter((line) => line.trim().length > 0)
        .join('\n');
};

const buildMastraMessages = (input: IAgentRuntimeInput): TMastraChatMessage[] => {
    const lastUserMessageIndex = findLastUserMessageIndex(input.messages);
    const history = (lastUserMessageIndex >= 0
        ? input.messages.slice(0, lastUserMessageIndex)
        : input.messages)
        .filter(isConversationMessage)
        .map((message) => ({
            role: message.role,
            content: message.content,
        }));
    const userPrompt = buildMastraUserPrompt(input).trim();

    if (userPrompt.length > 0) {
        history.push({
            role: 'user',
            content: userPrompt,
        });
    }

    if (history.length > 0) {
        return history;
    }

    return [{
        role: 'user',
        content: input.goal.trim().length > 0 ? input.goal : '继续。',
    }];
};

const formatApprovalSummary = (payload: ToolCallPayload): string => {
    if (payload.args === undefined) {
        return `${payload.toolName} 请求执行，但当前没有可展示的参数。`;
    }

    const serializedArgs = JSON.stringify(toJsonValue(payload.args));
    return `${payload.toolName} 请求执行，参数：${serializedArgs}`;
};

const normalizeMastraError = (error: unknown): string => {
    if (error instanceof Error) {
        return error.message;
    }

    const message = toRecord(error)?.message;
    return typeof message === 'string' && message.trim().length > 0
        ? message
        : String(error);
};

const encodeApprovalRequestId = (runId: string, toolCallId: string): string => {
    const encoded = Buffer.from(JSON.stringify({ runId, toolCallId }), 'utf8').toString('base64url');

    return `${APPROVAL_TOKEN_PREFIX}${encoded}`;
};

const decodeApprovalRequestId = (
    requestId: string,
): { runId: string; toolCallId: string } | null => {
    if (!requestId.startsWith(APPROVAL_TOKEN_PREFIX)) {
        return null;
    }

    try {
        const parsed = JSON.parse(
            Buffer.from(requestId.slice(APPROVAL_TOKEN_PREFIX.length), 'base64url').toString('utf8'),
        ) as { runId?: unknown; toolCallId?: unknown };

        return typeof parsed.runId === 'string' && typeof parsed.toolCallId === 'string'
            ? { runId: parsed.runId, toolCallId: parsed.toolCallId }
            : null;
    } catch {
        return null;
    }
};

const getChunkRunId = (chunk: unknown): string | null => {
    const runId = toRecord(chunk)?.runId;
    return typeof runId === 'string' && runId.trim().length > 0 ? runId : null;
};

const isApprovedDecision = (decision: string): boolean => {
    const normalizedDecision = decision.trim().toLowerCase();

    return ![
        'decline',
        'declined',
        'deny',
        'denied',
        'no',
        'reject',
        'rejected',
    ].includes(normalizedDecision);
};

const getTextDelta = (payload: TextDeltaPayload): string => payload.text;

const isChunkWithType = <TType extends string>(
    chunk: unknown,
    type: TType,
): chunk is { type: TType; payload?: unknown } => toRecord(chunk)?.type === type;

const isTextDeltaChunk = (
    chunk: unknown,
): chunk is { type: 'text-delta'; payload: TextDeltaPayload } => {
    if (!isChunkWithType(chunk, 'text-delta')) {
        return false;
    }

    const payload = toRecord(chunk.payload);
    return typeof payload?.text === 'string';
};

const isToolCallChunk = (
    chunk: unknown,
): chunk is { type: 'tool-call' | 'tool-call-approval'; payload: ToolCallPayload } => {
    if (!isChunkWithType(chunk, 'tool-call') && !isChunkWithType(chunk, 'tool-call-approval')) {
        return false;
    }

    const payload = toRecord(chunk.payload);
    return typeof payload?.toolName === 'string' && typeof payload?.toolCallId === 'string';
};

const isToolResultChunk = (
    chunk: unknown,
): chunk is { type: 'tool-result'; payload: { toolName: string; result: unknown } } => {
    if (!isChunkWithType(chunk, 'tool-result')) {
        return false;
    }

    const payload = toRecord(chunk.payload);
    return typeof payload?.toolName === 'string' && 'result' in payload;
};

const isToolCallSuspendedChunk = (
    chunk: unknown,
): chunk is { type: 'tool-call-suspended'; payload: { toolCallId: string; toolName: string; suspendPayload: unknown } } => {
    if (!isChunkWithType(chunk, 'tool-call-suspended')) {
        return false;
    }

    const payload = toRecord(chunk.payload);
    return typeof payload?.toolCallId === 'string' && typeof payload?.toolName === 'string';
};

const isToolErrorChunk = (
    chunk: unknown,
): chunk is { type: 'tool-error'; payload: { toolName: string; error: unknown } } => {
    if (!isChunkWithType(chunk, 'tool-error')) {
        return false;
    }

    const payload = toRecord(chunk.payload);
    return typeof payload?.toolName === 'string' && 'error' in payload;
};

const isErrorChunk = (
    chunk: unknown,
): chunk is { type: 'error'; payload: { error: unknown } } => {
    if (!isChunkWithType(chunk, 'error')) {
        return false;
    }

    const payload = toRecord(chunk.payload);
    return payload !== null && 'error' in payload;
};

const createApprovalRequest = (payload: ToolCallPayload, runId?: string | null) => ({
    id: runId ? encodeApprovalRequestId(runId, payload.toolCallId) : payload.toolCallId,
    toolName: payload.toolName,
    question: `${payload.toolName} 需要你的确认后才能继续执行。`,
    summary: formatApprovalSummary(payload),
    riskLevel: 'medium' as const,
    reversible: false,
    createdAt: new Date().toISOString(),
});

const createDoneResultFromPlan = (plan: TAgentPlan): string =>
    `已生成计划：${plan.steps.length} 个待办事项。`;

const createPlanResponse = (
    sessionId: string,
    plan: TAgentPlan,
    events: TAgentRuntimeOutputEvent[] = [],
    options: IAgentRuntimeRunOptions = {},
): IAgentRuntimeResponse => {
    const doneResult = createDoneResultFromPlan(plan);
    const planEvent: TAgentRuntimeOutputEvent = {
        type: 'plan_ready',
        plan,
    };
    const doneEvent: TAgentRuntimeOutputEvent = {
        type: 'done',
        result: doneResult,
    };

    pushUiEvent(events, planEvent, options);
    pushUiEvent(events, doneEvent, options);

    return {
        sessionId,
        events,
        result: doneResult,
    };
};

const createErrorResponse = (
    sessionId: string,
    message: string,
    events: TAgentRuntimeOutputEvent[] = [],
    options: IAgentRuntimeRunOptions = {},
): IAgentRuntimeResponse => {
    const errorEvent: TAgentRuntimeOutputEvent = {
        type: 'error',
        message,
    };

    options.onEvent?.(errorEvent);

    return {
        sessionId,
        events: [...events, errorEvent],
        result: null,
    };
};

export class MastraRuntime {
    private readonly createAgent: (config: IMastraAgentConfig) => IMastraAgentLike;

    private readonly readModelConfig: () => IDeepSeekModelConfig | null;

    private readonly createMcpClientBundle: (
        options?: { workspaceRootPath?: string | null },
    ) => Promise<IMastraMcpBundle>;

    private readonly pendingApprovals = new Map<string, IMastraPendingApproval>();

    readonly name = 'mastra';

    constructor(deps: IMastraRuntimeDeps = {}) {
        this.createAgent = deps.createAgent ?? defaultCreateAgent;
        this.readModelConfig = deps.readModelConfig ?? createDeepSeekModelConfigFromEnv;
        this.createMcpClientBundle = deps.createMcpClientBundle ?? createMastraMcpClientBundle;
    }

    private registerPendingApproval(
        sessionId: string,
        agent: IMastraAgentLike,
        bundle: IMastraMcpBundle,
        chunk: { type: 'tool-call-approval'; payload: ToolCallPayload },
    ): string | null {
        const runId = getChunkRunId(chunk);

        if (
            !runId
            || typeof agent.approveToolCall !== 'function'
            || typeof agent.declineToolCall !== 'function'
        ) {
            return null;
        }

        const requestId = encodeApprovalRequestId(runId, chunk.payload.toolCallId);
        this.pendingApprovals.set(requestId, {
            agent,
            bundle,
            runId,
            sessionId,
            toolCallId: chunk.payload.toolCallId,
        });

        return requestId;
    }

    private async consumeTextStream(
        agent: IMastraAgentLike,
        bundle: IMastraMcpBundle,
        sessionId: string,
        stream: IMastraAgentStreamLike,
        events: TAgentRuntimeOutputEvent[],
        options: IAgentRuntimeRunOptions,
    ): Promise<IMastraTextStreamSummary> {
        let visibleText = '';
        let emittedVisibleText = '';
        let streamErrorMessage: string | null = null;
        let pendingApproval = false;
        let releaseResources = true;

        for await (const chunk of stream.fullStream) {
            if (isTextDeltaChunk(chunk)) {
                const nextText = getTextDelta(chunk.payload);
                if (!nextText) {
                    continue;
                }

                visibleText += nextText;

                if (visibleText !== emittedVisibleText) {
                    emittedVisibleText = visibleText;
                    pushUiEvent(events, {
                        type: 'message_delta',
                        text: visibleText,
                        phase: 'final',
                    }, options);
                }
                continue;
            }

            if (isChunkWithType(chunk, 'tool-call') && isToolCallChunk(chunk)) {
                pushUiEvent(events, {
                    type: 'tool_start',
                    toolName: chunk.payload.toolName,
                    input: chunk.payload.args === undefined ? null : toJsonValue(chunk.payload.args),
                }, options);
                continue;
            }

            if (isToolResultChunk(chunk)) {
                pushUiEvent(events, {
                    type: 'tool_result',
                    toolName: chunk.payload.toolName,
                    output: toJsonValue(chunk.payload.result),
                }, options);
                continue;
            }

            if (isChunkWithType(chunk, 'tool-call-approval') && isToolCallChunk(chunk)) {
                pendingApproval = true;
                const pendingRequestId = this.registerPendingApproval(sessionId, agent, bundle, chunk);

                if (pendingRequestId) {
                    releaseResources = false;
                }

                pushUiEvent(events, {
                    type: 'approval_required',
                    request: createApprovalRequest(chunk.payload, pendingRequestId ? getChunkRunId(chunk) : null),
                }, options);
                continue;
            }

            if (isToolCallSuspendedChunk(chunk)) {
                pendingApproval = true;
                pushUiEvent(events, {
                    type: 'approval_required',
                    request: {
                        id: chunk.payload.toolCallId,
                        toolName: chunk.payload.toolName,
                        question: `${chunk.payload.toolName} 已暂停，等待继续信息。`,
                        summary: JSON.stringify(toJsonValue(chunk.payload.suspendPayload)),
                        riskLevel: 'medium',
                        reversible: true,
                        createdAt: new Date().toISOString(),
                    },
                }, options);
                continue;
            }

            if (isToolErrorChunk(chunk)) {
                pushUiEvent(events, {
                    type: 'tool_result',
                    toolName: chunk.payload.toolName,
                    output: toJsonValue({
                        error: normalizeMastraError(chunk.payload.error),
                    }),
                }, options);
                continue;
            }

            if (isErrorChunk(chunk)) {
                streamErrorMessage = normalizeMastraError(chunk.payload.error);
                continue;
            }

            if (isChunkWithType(chunk, 'abort')) {
                streamErrorMessage = 'Mastra Agent 执行已中止。';
            }
        }

        return {
            pendingApproval,
            releaseResources,
            streamErrorMessage,
            visibleText,
        };
    }

    private createFallbackApprovalResponse(
        input: IApprovalResolutionInput,
        sessionId: string,
        options: IAgentRuntimeRunOptions,
    ): IAgentRuntimeResponse {
        const result = '审批结果已记录，等待下一次 Agent 执行继续消费。';
        const events: TAgentRuntimeOutputEvent[] = [];

        pushUiEvent(events, {
            type: 'tool_result',
            toolName: 'approval',
            output: {
                requestId: input.requestId,
                decision: input.decision,
            },
        }, options);
        pushUiEvent(events, {
            type: 'done',
            result,
        }, options);

        return {
            sessionId,
            events,
            result,
        };
    }

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
        const modelConfig = this.readModelConfig();

        if (!modelConfig) {
            return createErrorResponse(
                sessionId,
                'DeepSeek 未配置：请在 Node sidecar 环境设置 DEEPSEEK_API_KEY。',
                events,
                options,
            );
        }

        const {
            bundle: mcpBundle,
            tools: mastraTools,
            hasTools,
        } = await loadMastraMcpTools(this.createMcpClientBundle, normalizedInput.workspaceRootPath);
        let shouldDisconnectBundle = true;

        try {
            const agent = this.createAgent({
                id: 'calamex-agent-sidecar',
                name: 'Calamex Agent Sidecar',
                instructions: buildSystemPrompt(normalizedInput, modelConfig.model),
                model: createMastraModelConfig(modelConfig),
                ...(hasTools ? { tools: mastraTools } : {}),
            });
            const toolChoice: IMastraGenerateOptions['toolChoice'] = hasTools ? 'auto' : 'none';
            const streamOptions = {
                maxSteps: hasTools ? 10 : 1,
                toolChoice,
                ...(options.context?.signal ? { abortSignal: options.context.signal } : {}),
                ...(options.context?.requestId ? { runId: options.context.requestId } : {}),
            };
            const stream = await agent.stream(buildMastraMessages(normalizedInput), {
                ...streamOptions,
            });
            const streamSummary = await this.consumeTextStream(
                agent,
                mcpBundle,
                sessionId,
                stream,
                events,
                options,
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
            const doneEvent: TAgentRuntimeOutputEvent = {
                type: 'done',
                result,
            };

            pushUiEvent(events, doneEvent, options);

            return {
                sessionId,
                events,
                result,
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
            }
        }
    }

    async chat(
        input: IAgentRuntimeInput,
        options: IAgentRuntimeRunOptions = {},
    ): Promise<IAgentRuntimeResponse> {
        return this.runTextMode(input, input.mode ?? 'ask', 'mastra-chat', options);
    }

    async plan(
        input: IAgentRuntimeInput,
        options: IAgentRuntimeRunOptions = {},
    ): Promise<IAgentRuntimeResponse> {
        const sessionId = input.sessionId ?? createSessionId('mastra-plan');
        const modelConfig = this.readModelConfig();

        if (!modelConfig) {
            return createErrorResponse(
                sessionId,
                'DeepSeek 未配置：请在 Node sidecar 环境设置 DEEPSEEK_API_KEY。',
                [],
                options,
            );
        }

        const {
            bundle: mcpBundle,
            tools: mastraTools,
            hasTools,
        } = await loadMastraMcpTools(this.createMcpClientBundle, input.workspaceRootPath);

        try {
            const agent = this.createAgent({
                id: 'calamex-agent-sidecar-plan',
                name: 'Calamex Agent Plan Sidecar',
                instructions: buildSystemPrompt({
                    ...input,
                    mode: 'plan',
                }, modelConfig.model),
                model: createMastraModelConfig(modelConfig),
                ...(hasTools ? { tools: mastraTools } : {}),
            });
            const toolChoice: IMastraGenerateOptions['toolChoice'] = hasTools ? 'auto' : 'none';
            const generateOptions = {
                maxSteps: hasTools ? 10 : 1,
                toolChoice,
                structuredOutput: {
                    schema: agentPlanSchema,
                },
                ...(options.context?.signal ? { abortSignal: options.context.signal } : {}),
                ...(options.context?.requestId ? { runId: options.context.requestId } : {}),
            };
            const generated = await agent.generate(buildMastraMessages({
                ...input,
                mode: 'plan',
            }), generateOptions);
            const parsedPlan = agentPlanSchema.safeParse(generated.object);

            if (!parsedPlan.success) {
                return createErrorResponse(
                    sessionId,
                    'Mastra structured output 没有返回有效 AgentPlan，计划未生成。',
                    [],
                    options,
                );
            }

            return createPlanResponse(sessionId, parsedPlan.data, [], options);
        } catch (error) {
            return createErrorResponse(
                sessionId,
                `Mastra Plan 执行失败：${normalizeMastraError(error)}`,
                [],
                options,
            );
        } finally {
            await mcpBundle.disconnectAll();
        }
    }

    async execute(
        input: IAgentRuntimeInput,
        options: IAgentRuntimeRunOptions = {},
    ): Promise<IAgentRuntimeResponse> {
        return this.runTextMode(input, 'agent', 'mastra-execute', options);
    }

    async resolveApproval(
        input: IApprovalResolutionInput,
        options: IAgentRuntimeRunOptions = {},
    ): Promise<IAgentRuntimeResponse> {
        const decodedRequest = decodeApprovalRequestId(input.requestId);
        const pending = this.pendingApprovals.get(input.requestId);
        const sessionId = pending?.sessionId ?? input.sessionId ?? createSessionId('mastra-approval');

        if (!pending || !decodedRequest) {
            return this.createFallbackApprovalResponse(input, sessionId, options);
        }

        this.pendingApprovals.delete(input.requestId);

        const continueStream = isApprovedDecision(input.decision)
            ? pending.agent.approveToolCall
            : pending.agent.declineToolCall;

        if (!continueStream) {
            await pending.bundle.disconnectAll();
            return this.createFallbackApprovalResponse(input, sessionId, options);
        }

        const events: TAgentRuntimeOutputEvent[] = [];
        let shouldDisconnectBundle = true;

        try {
            const stream = await continueStream({
                runId: decodedRequest.runId,
                toolCallId: decodedRequest.toolCallId,
                ...(options.context?.signal ? { abortSignal: options.context.signal } : {}),
            });
            const streamSummary = await this.consumeTextStream(
                pending.agent,
                pending.bundle,
                sessionId,
                stream,
                events,
                options,
            );
            shouldDisconnectBundle = streamSummary.releaseResources;

            if (streamSummary.streamErrorMessage) {
                return createErrorResponse(
                    sessionId,
                    `Mastra Approval 执行失败：${streamSummary.streamErrorMessage}`,
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

            pushUiEvent(events, {
                type: 'done',
                result,
            }, options);

            return {
                sessionId,
                events,
                result,
            };
        } catch (error) {
            return createErrorResponse(
                sessionId,
                `Mastra Approval 执行失败：${normalizeMastraError(error)}`,
                events,
                options,
            );
        } finally {
            if (shouldDisconnectBundle) {
                await pending.bundle.disconnectAll();
            }
        }
    }
}