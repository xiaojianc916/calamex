import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { SIDECAR_VERSION } from './runtime.js';

import { AgentBrowser } from '@mastra/agent-browser';
import { Agent, type ToolsInput } from '@mastra/core/agent';
import { createDurableAgent, DurableStepIds } from '@mastra/core/agent/durable';
import type { MastraBrowser } from '@mastra/core/browser';
import type { MastraModelConfig } from '@mastra/core/llm';
import { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import type {
    AgentChunkType,
    DataChunkType,
    DynamicToolResultPayload,
    ReasoningDeltaPayload,
    ToolCallChunk,
    ToolCallPayload,
    ToolResultChunk,
    ToolResultPayload,
} from '@mastra/core/stream';
import { createTool } from '@mastra/core/tools';
import type { AnyWorkspace } from '@mastra/core/workspace';
import { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';

import {
    createDeepSeekModelConfigFromEnv,
    type TDeepSeekModelConfig,
} from '../models/deepseek-model.js';
import {
    createDeepSeekReasoningRunPrefix,
    evictDeepSeekReasoningByPrefix,
    runWithDeepSeekReasoningContext,
    type IDeepSeekRequestPayloadStats,
} from '../models/deepseek-reasoning-fetch.js';
import {
    compactModelOutput,
    truncateModelOutputText,
} from '../models/model-output-budget.js';
import type { TJsonValue } from '../schemas/events.js';
import {
    agentPlanDeltaSchema,
    agentPlanValidationReportSchema,
    type TAgentPlanDelta,
    type TAgentPlanStepPatch,
    type TAgentPlanValidationReport,
} from '../schemas/plan-workflow.js';
import {
    agentPlanGenerationSchema,
    agentPlanSchema,
    agentPlanStepSchema,
    type TAgentPlan,
    type TAgentPlanStep,
} from '../schemas/plan.js';
import { redactForStream } from '../streaming/stream-redaction.js';
import {
    createAgentRuntimeEvent,
    type IAgentRuntimeEventContext,
    type TAgentRuntimeEventDraft,
} from '../streaming/stream-types.js';
import { createMastraFileTools } from '../tools/file-primitives.js';
import {
    createMastraFileLogger,
    createMastraLoggerRef,
    createMastraLogTools,
    type IMastraLogToolsRef,
} from '../tools/log.js';
import {
    createMcpGatewayRunBundle,
    createMcpGatewayWarmPool,
    type IMcpGatewayBundle,
    type McpGatewayMetricBuffer,
    type McpGatewayWarmPool,
    type TMcpGatewayToolProfile
} from '../tools/mcp-gateway.js';
import { createMastraMcpClientBundle, type TMcpServerName } from '../tools/mcp.js';
import { createMastraTimeTools } from '../tools/time.js';
import { buildSystemPrompt } from './agent-runtime-helpers.js';
import {
    createMastraAgentMemory,
    createMastraMemoryReference,
    createMastraMemoryScope,
    resolveMastraStorageUrl,
} from './mastra-memory.js';
import { createAgentPlanStore, type IAgentPlanStore, type TAgentPlanRecord } from './plan-store.js';
import {
    createAgentPlanWorkflowStore,
    type IAgentPlanWorkflowStore,
} from './plan-workflow-store.js';
import type {
    IAgentRuntimeResponse,
    IAgentRuntimeRunOptions,
    TAgentRuntimeOutputEvent,
} from './runtime-contracts.js';
import type {
    IAgentContextReferenceInput,
    IAgentMessageInput,
    IAgentRuntimeInput,
    IApprovalResolutionInput,
    ICheckpointRestoreInput,
    IPlanApprovalInput,
    IPlanFinishInput,
    IPlanQueryInput,
    IPlanRejectInput,
    TRollbackStepPath,
} from './runtime-input.js';

const DEFAULT_MASTRA_LOG_FILE = './.agent-sidecar/mastra.log';
const DEFAULT_EXECUTION_AGENT_ID = 'calamex-agent-sidecar';
const DEFAULT_EXECUTION_AGENT_NAME = 'Calamex Agent Sidecar';
const DEFAULT_VALIDATOR_AGENT_ID = 'calamex-agent-sidecar-validator';
const DEFAULT_REPLANNER_AGENT_ID = 'calamex-agent-sidecar-replanner';
const RUNTIME_TOOL_PREVIEW_CHARS = 1200;
const CURRENT_FILE_TOOL_CONTENT_MAX_CHARS = 2_000;
const CURRENT_FILE_TOOL_MODEL_OUTPUT_MAX_CHARS = 2_600;
const EXPLICIT_CONTEXT_MESSAGE_LIMIT = 12;
const DEFAULT_ROLLBACK_STEP: TRollbackStepPath = [
    DurableStepIds.AGENTIC_EXECUTION,
    DurableStepIds.LLM_EXECUTION,
];
type TMastraRequestContextValues = Record<string, unknown>;
type TMastraRequestContext = RequestContext<TMastraRequestContextValues>;
type IMcpGatewayMetricLogger = {
    info(data: object, msg?: string): void;
    warn(data: object, msg?: string): void;
};
type TMastraChatMessage = {
    role: 'user' | 'assistant';
    content: string;
};

type TMastraAgentChunk = AgentChunkType<undefined>;
type TMastraStreamChunk = TMastraAgentChunk | DataChunkType;
type TMastraTextDeltaChunk = Extract<TMastraAgentChunk, { type: 'text-delta' }>;
type TMastraReasoningDeltaChunk = Extract<TMastraAgentChunk, { type: 'reasoning-delta' }>;
type TMastraToolCallApprovalChunk = Extract<TMastraAgentChunk, { type: 'tool-call-approval' }>;
type TMastraToolCallSuspendedChunk = Extract<TMastraAgentChunk, { type: 'tool-call-suspended' }>;
type TMastraToolErrorChunk = Extract<TMastraAgentChunk, { type: 'tool-error' }>;
type TMastraErrorChunk = Extract<TMastraAgentChunk, { type: 'error' }>;
type TMastraFinishChunk = Extract<TMastraAgentChunk, { type: 'finish' }>;
type TOmDataChunk = DataChunkType & {
    type: 'data-om-activation' | 'data-om-observation-end';
};
type TCompatibleReasoningDeltaChunk = TMastraReasoningDeltaChunk & {
    payload: ReasoningDeltaPayload & {
        reasoning?: string;
        delta?: string;
        reasoning_content?: string;
        reasoningContent?: string;
    };
};
type TCompatibleToolResultPayload = ToolResultPayload | DynamicToolResultPayload;

interface IMastraAgentStreamLike {
    fullStream: AsyncIterable<unknown>;
    runId?: string;
    cleanup?: () => void;
}

interface IMastraApprovalOptions {
    runId: string;
    toolCallId?: string;
    abortSignal?: AbortSignal | undefined;
}

interface IMastraGenerateOptions {
    abortSignal?: AbortSignal | undefined;
    runId?: string;
    maxSteps?: number;
    toolChoice?: 'auto' | 'none';
    memory?: {
        thread: string;
        resource: string;
    };
    requestContext?: TMastraRequestContext;
    structuredOutput?: {
        schema: unknown;
        jsonPromptInjection?: boolean;
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

interface IMastraWorkflowRunLike {
    timeTravel(options: {
        step: TRollbackStepPath;
        requestContext?: TMastraRequestContext;
        resumeData?: unknown;
    }): Promise<unknown>;
}

interface IMastraWorkflowLike {
    id: string;
    createRun(options?: { runId?: string }): Promise<IMastraWorkflowRunLike>;
}

interface IMastraExecutionHandle {
    agent: IMastraAgentLike;
    workflow: IMastraWorkflowLike;
}

interface IMastraWorkflowSnapshotLike {
    requestContext?: unknown;
    status?: string;
}

interface IMastraWorkflowStoreLike {
    loadWorkflowSnapshot(options: {
        workflowName: string;
        runId: string;
    }): Promise<IMastraWorkflowSnapshotLike | null>;
}

interface IMastraStorageLike {
    getStore(domain: 'workflows'): Promise<IMastraWorkflowStoreLike | null | undefined>;
}

interface IMastraAgentConfig {
    id: string;
    name: string;
    instructions: string;
    model: MastraModelConfig;
    memory?: ReturnType<typeof createMastraAgentMemory>;
    tools?: ToolsInput;
    workspace?: AnyWorkspace;
    browser?: MastraBrowser;
}

type IMastraMcpBundle = IMcpGatewayBundle;

interface IMastraRuntimeDeps {
    createAgent?: (config: IMastraAgentConfig) => IMastraAgentLike;
    createExecutionHandle?: (config: IMastraAgentConfig) => Promise<IMastraExecutionHandle>;
    createStorage?: () => IMastraStorageLike;
    loadExecutionSnapshot?: (
        workflowName: string,
        runId: string,
    ) => Promise<IMastraWorkflowSnapshotLike | null>;
    readModelConfig?: () => TDeepSeekModelConfig | null;
    createMcpClientBundle?: (
        options?: { workspaceRootPath?: string | null; serverNames?: readonly TMcpServerName[] },
    ) => Promise<IMastraMcpBundle>;
    createPlanStore?: () => IAgentPlanStore;
    createPlanWorkflowStore?: () => IAgentPlanWorkflowStore;
    now?: () => string;
}

interface IMastraPendingApproval {
    agent: IMastraAgentLike;
    bundle: IMastraMcpBundle;
    runId: string;
    sessionId: string;
    toolCallId: string;
    workspace?: AnyWorkspace;
    browser?: MastraBrowser;
}

interface IMastraTextStreamSummary {
    pendingApproval: boolean;
    releaseResources: boolean;
    streamErrorMessage: string | null;
    visibleText: string;
    doneTokenSnapshot?: TDoneTokenSnapshot;
}

type TDoneTokenSnapshot = Pick<Extract<TAgentRuntimeOutputEvent, {
    type: 'done';
}>, 'promptTokens' | 'completionTokens' | 'totalTokens' | 'usage'>;

interface IPlanWorkflowStepTracker {
    planId: string;
    version: number;
    stepId: string;
}

type TRuntimeEventFactory = (draft: TAgentRuntimeEventDraft) => TAgentRuntimeOutputEvent;
type TOmMemoryCompressedEventDraft = Extract<TAgentRuntimeEventDraft, {
    type: 'acontext.memory.compressed';
}>;
type TAcontextTokenEventDraft = Extract<TAgentRuntimeEventDraft, {
    type: 'acontext.token.checked';
}>;
type TAcontextProviderPayloadEventDraft = Extract<TAgentRuntimeEventDraft, {
    type: 'acontext.provider_payload.checked';
}>;
type TMastraToolProfile = TMcpGatewayToolProfile;

interface IMastraToolLoadPlan {
    workspaceEnabled: boolean;
    browserEnabled: boolean;
    strategy: string;
}

interface IMastraToolBudgetStats {
    toolCount: number;
    mcpToolCount: number;
    mcpServerCount: number;
    uiContextToolCount: number;
    nativeToolCount: number;
    logToolCount: number;
    toolSchemaCharCount: number;
    mcpServerNames: string[];
    toolLoadStrategy: string;
}

interface IMastraDurableAgentLike {
    stream(
        messages: TMastraChatMessage[],
        options?: IMastraGenerateOptions,
    ): Promise<{
        fullStream: ReadableStream<unknown>;
        runId: string;
        cleanup: () => void;
    }>;
    resume(
        runId: string,
        resumeData: unknown,
    ): Promise<{
        fullStream: ReadableStream<unknown>;
        runId: string;
        cleanup: () => void;
    }>;
    getWorkflow(): IMastraWorkflowLike;
}

const createSessionId = (prefix: string): string =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const APPROVAL_TOKEN_PREFIX = 'mastra-approval.';

const isNodeTestProcess = (): boolean => Boolean(process.env.NODE_TEST_CONTEXT);

const toRecord = (value: unknown): Record<string, unknown> | null => (
    value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
);

const toNonEmptyString = (value: unknown): string | null => {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};

const isRequestContextLike = (value: unknown): value is {
    all?: unknown;
    entries?: () => Iterable<readonly [string, unknown]>;
    toJSON?: () => unknown;
} => Boolean(value && typeof value === 'object');

const requestContextToRecord = (value: unknown): Record<string, unknown> | null => {
    if (!value) {
        return null;
    }

    if (isRequestContextLike(value)) {
        if (typeof value.toJSON === 'function') {
            const jsonValue = toRecord(value.toJSON());
            if (jsonValue) {
                return jsonValue;
            }
        }

        const allValue = toRecord(value.all);
        if (allValue) {
            return allValue;
        }

        if (typeof value.entries === 'function') {
            return Object.fromEntries(value.entries());
        }
    }

    return toRecord(value);
};

const createMastraRequestContext = (
    values: Record<string, unknown>,
): TMastraRequestContext => new RequestContext<TMastraRequestContextValues>(
    Object.entries(values),
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

const stringifyJsonValue = (value: TJsonValue): string => {
    if (typeof value === 'string') {
        return value;
    }

    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
};

const createRuntimePreview = (
    value: unknown,
    limit = RUNTIME_TOOL_PREVIEW_CHARS,
): string => {
    const normalized = stringifyJsonValue(toJsonValue(value))
        .replace(/\s+/gu, ' ')
        .trim();

    if (!normalized) {
        return '';
    }

    const characters = Array.from(normalized);
    const clipped = characters.length <= limit
        ? normalized
        : `${characters.slice(0, limit).join('')}...`;

    return redactForStream(clipped);
};

const pushUiEvent = (
    events: TAgentRuntimeOutputEvent[],
    event: TAgentRuntimeOutputEvent,
    options: IAgentRuntimeRunOptions = {},
): void => {
    events.push(event);
    options.onEvent?.(event);
};

const createRuntimeEventFactory = (
    context: IAgentRuntimeEventContext,
): ((draft: TAgentRuntimeEventDraft) => TAgentRuntimeOutputEvent) => {
    let seq = 0;

    return (draft) => ({
        type: 'agent_event',
        event: createAgentRuntimeEvent(context, seq++, draft),
    });
};

const attachMcpGatewayMetrics = (
    metricBuffer: McpGatewayMetricBuffer,
    logger: IMcpGatewayMetricLogger,
): void => {
    metricBuffer.setListener((metric) => {
        switch (metric.type) {
            case 'mcp_gateway.boot':
            case 'mcp_gateway.catalog':
                logger.info({
                    type: metric.type,
                    serverName: metric.serverName,
                    durationMs: metric.durationMs,
                    activeBundleCount: metric.activeBundleCount,
                    warmBundleCount: metric.warmBundleCount,
                    toolCount: metric.toolCount,
                    errorCount: metric.errorCount,
                    ...(metric.type === 'mcp_gateway.catalog'
                        ? { profile: metric.profile, cacheHit: metric.cacheHit }
                        : {}),
                }, '[mcp-gateway] metric');
                return;
            case 'mcp_gateway.call':
                logger.info({
                    type: metric.type,
                    serverName: metric.serverName,
                    requestedToolName: metric.requestedToolName,
                    resolvedToolName: metric.resolvedToolName,
                    durationMs: metric.durationMs,
                    activeBundleCount: metric.activeBundleCount,
                    warmBundleCount: metric.warmBundleCount,
                    toolCallCount: metric.toolCallCount,
                    errorCount: metric.errorCount,
                }, '[mcp-gateway] metric');
                return;
            case 'mcp_gateway.boot_failed':
                logger.warn({
                    type: metric.type,
                    serverName: metric.serverName,
                    durationMs: metric.durationMs,
                    errorMessage: metric.errorMessage,
                }, '[mcp-gateway] boot failed');
                return;
            case 'mcp_gateway.metric_buffer_dropped':
                logger.warn({
                    type: metric.type,
                    droppedCount: metric.droppedCount,
                }, '[mcp-gateway] metric buffer overflow');
                return;
        }
    });
};

const countTextChars = (value: string): number => Array.from(value).length;

const stringifyForBudget = (value: unknown): string => {
    try {
        return JSON.stringify(value) ?? '';
    } catch {
        return '';
    }
};

const countJsonChars = (value: unknown): number => countTextChars(stringifyForBudget(value));

const createJsonToolModelOutput = (value: unknown): { type: 'json'; value: unknown } => ({
    type: 'json',
    value,
});

const EMPTY_TOOL_PARAMETERS = {
    type: 'object',
    properties: {},
    additionalProperties: false,
} as const;

const isZodSchemaLike = (value: unknown): value is z.ZodType<unknown> => {
    const record = toRecord(value);

    return typeof record?.parse === 'function'
        && typeof record?.safeParse === 'function';
};

const convertToolInputSchemaForBudget = (schema: unknown): unknown => {
    if (!schema) {
        return EMPTY_TOOL_PARAMETERS;
    }

    const schemaRecord = toRecord(schema);
    if (schemaRecord && 'jsonSchema' in schemaRecord) {
        return schemaRecord.jsonSchema;
    }

    if (isZodSchemaLike(schema)) {
        try {
            return z.toJSONSchema(schema);
        } catch {
            return EMPTY_TOOL_PARAMETERS;
        }
    }

    return schema;
};

const createProviderToolBudgetShape = (
    name: string,
    tool: unknown,
): {
    type: 'function';
    name: string;
    description?: string;
    parameters: unknown;
} => {
    const toolRecord = toRecord(tool);
    const description = typeof toolRecord?.description === 'string'
        ? toolRecord.description
        : undefined;
    const inputSchema = toolRecord && 'inputSchema' in toolRecord
        ? toolRecord.inputSchema
        : toolRecord?.parameters;

    return {
        type: 'function',
        name,
        ...(description ? { description } : {}),
        parameters: convertToolInputSchemaForBudget(inputSchema),
    };
};

const countProviderToolSchemaChars = (tools: ToolsInput): number =>
    countJsonChars(Object.entries(tools).map(([name, tool]) =>
        createProviderToolBudgetShape(name, tool),
    ));

const estimateInputTokensByChars = (value: string): number => {
    let asciiRunLength = 0;
    let tokens = 0;

    for (const char of Array.from(value)) {
        const codePoint = char.codePointAt(0) ?? 0;

        if (codePoint <= 0x7f) {
            asciiRunLength += 1;
            continue;
        }

        if (asciiRunLength > 0) {
            tokens += Math.ceil(asciiRunLength / 4);
            asciiRunLength = 0;
        }

        tokens += 1;
    }

    if (asciiRunLength > 0) {
        tokens += Math.ceil(asciiRunLength / 4);
    }

    return Math.max(tokens, 1);
};

const createAcontextTokenEventDraft = (input: {
    systemPrompt: string;
    messages: readonly TMastraChatMessage[];
    contextReferences: readonly IAgentContextReferenceInput[];
    tools: ToolsInput;
    toolStats: IMastraToolBudgetStats;
    workspaceEnabled: boolean;
    browserEnabled: boolean;
    memoryEnabled: boolean;
    maxSteps: number;
    toolChoice: 'auto' | 'none';
}): TAcontextTokenEventDraft => {
    const messagesText = stringifyForBudget(input.messages);
    const toolsText = stringifyForBudget(Object.entries(input.tools).map(([name, tool]) =>
        createProviderToolBudgetShape(name, tool),
    ));
    const systemPromptCharCount = countTextChars(input.systemPrompt);
    const messageCharCount = countTextChars(messagesText);
    const toolSchemaCharCount = input.toolStats.toolSchemaCharCount;
    const contextCharCount = countJsonChars(input.contextReferences);
    const inputText = [
        input.systemPrompt,
        messagesText,
        toolsText,
    ].join('\n');

    return {
        type: 'acontext.token.checked',
        visibility: 'debug',
        level: 'info',
        projectedInputTokens: estimateInputTokensByChars(inputText),
        inputCharCount: systemPromptCharCount + messageCharCount + toolSchemaCharCount,
        systemPromptCharCount,
        messageCharCount,
        contextCharCount,
        toolSchemaCharCount,
        toolCount: input.toolStats.toolCount,
        mcpToolCount: input.toolStats.mcpToolCount,
        mcpServerCount: input.toolStats.mcpServerCount,
        uiContextToolCount: input.toolStats.uiContextToolCount,
        nativeToolCount: input.toolStats.nativeToolCount,
        logToolCount: input.toolStats.logToolCount,
        mcpServerNames: input.toolStats.mcpServerNames,
        toolLoadStrategy: input.toolStats.toolLoadStrategy,
        workspaceEnabled: input.workspaceEnabled,
        browserEnabled: input.browserEnabled,
        memoryEnabled: input.memoryEnabled,
        maxSteps: input.maxSteps,
        toolChoice: input.toolChoice,
        tokenEstimateMethod: 'char_heuristic',
    };
};

const createAcontextProviderPayloadEventDraft = (
    stats: IDeepSeekRequestPayloadStats,
    requestIndex: number,
): TAcontextProviderPayloadEventDraft => ({
    type: 'acontext.provider_payload.checked',
    visibility: 'debug',
    level: 'info',
    provider: stats.provider,
    ...(stats.model ? { model: stats.model } : {}),
    ...(stats.stream !== undefined ? { stream: stats.stream } : {}),
    requestIndex,
    requestBodyCharCount: stats.requestBodyCharCount,
    projectedInputTokens: stats.projectedInputTokens,
    messageCharCount: stats.messageCharCount,
    systemMessageCharCount: stats.systemMessageCharCount,
    userMessageCharCount: stats.userMessageCharCount,
    assistantMessageCharCount: stats.assistantMessageCharCount,
    toolMessageCharCount: stats.toolMessageCharCount,
    reasoningReplayCharCount: stats.reasoningReplayCharCount,
    toolSchemaCharCount: stats.toolSchemaCharCount,
    toolCount: stats.toolCount,
    responseFormatCharCount: stats.responseFormatCharCount,
    reasoningInjected: stats.reasoningInjected,
    tokenEstimateMethod: 'char_heuristic',
});

const createDeepSeekPayloadEventSink = (
    events: TAgentRuntimeOutputEvent[],
    options: IAgentRuntimeRunOptions,
): {
    onRequestPayload: (stats: IDeepSeekRequestPayloadStats) => void;
    attachRuntimeEventFactory: (factory: TRuntimeEventFactory) => void;
} => {
    const pending: TAcontextProviderPayloadEventDraft[] = [];
    let runtimeEventFactory: TRuntimeEventFactory | null = null;
    let requestIndex = 0;

    const pushDraft = (draft: TAcontextProviderPayloadEventDraft): void => {
        if (!runtimeEventFactory) {
            pending.push(draft);
            return;
        }

        pushUiEvent(events, runtimeEventFactory(draft), options);
    };

    return {
        onRequestPayload: (stats) => {
            requestIndex += 1;
            pushDraft(createAcontextProviderPayloadEventDraft(stats, requestIndex));
        },
        attachRuntimeEventFactory: (factory) => {
            runtimeEventFactory = factory;

            while (pending.length > 0) {
                const draft = pending.shift();

                if (draft) {
                    pushUiEvent(events, runtimeEventFactory(draft), options);
                }
            }
        },
    };
};

const createExecutionRequestContext = (
    input: IAgentRuntimeInput,
    systemPrompt: string,
    memory: { thread: string; resource: string },
    approvedPlanRecord?: TAgentPlanRecord,
): TMastraRequestContext => createMastraRequestContext({
    mode: input.mode,
    goal: input.goal,
    systemPrompt,
    workspaceRootPath: input.workspaceRootPath ?? null,
    context: input.context ?? [],
    memoryThreadId: memory.thread,
    memoryResourceId: memory.resource,
    ...(approvedPlanRecord ? {
        planId: approvedPlanRecord.planId,
        planVersion: approvedPlanRecord.version,
        planStepId: input.planStepId ?? null,
        approvedPlan: toJsonValue(approvedPlanRecord.plan),
    } : {}),
});

const resolveSystemPromptFromSnapshot = (
    snapshot: IMastraWorkflowSnapshotLike,
): string | null => toNonEmptyString(requestContextToRecord(snapshot.requestContext)?.systemPrompt);

const resolveWorkspaceRootPathFromSnapshot = (
    snapshot: IMastraWorkflowSnapshotLike,
): string | undefined => {
    const value = toNonEmptyString(requestContextToRecord(snapshot.requestContext)?.workspaceRootPath);
    return value ?? undefined;
};

const extractRestoreResultText = (result: unknown): string | null => {
    const topLevel = toRecord(result);
    const nestedResult = toRecord(topLevel?.result);
    const output = toRecord(nestedResult?.output) ?? toRecord(topLevel?.output);
    return toNonEmptyString(output?.text);
};

const resolveWorkspaceDirectory = (workspaceRootPath?: string | null): string | null => {
    const configured = toNonEmptyString(workspaceRootPath);

    if (!configured) {
        return null;
    }

    const absolutePath = resolve(configured);

    try {
        if (!existsSync(absolutePath) || !statSync(absolutePath).isDirectory()) {
            return null;
        }

        return realpathSync(absolutePath);
    } catch {
        return null;
    }
};

const destroyMastraWorkspace = async (workspace: AnyWorkspace | undefined): Promise<void> => {
    if (!workspace || workspace.status === 'destroyed') {
        return;
    }

    await workspace.destroy().catch(() => undefined);
};

const createMastraBrowser = (): MastraBrowser => new AgentBrowser({
    headless: true,
});

const destroyMastraBrowser = async (browser: MastraBrowser | undefined): Promise<void> => {
    if (!browser || browser.status === 'closed') {
        return;
    }

    await browser.close().catch(() => undefined);
};

const createMastraToolLoadPlan = (
    input: Pick<IAgentRuntimeInput, 'goal' | 'messages' | 'mode' | 'planId' | 'planStepId'>,
    workspaceRootPath: string | undefined,
    contextReferences: readonly IAgentContextReferenceInput[] = [],
): IMastraToolLoadPlan => {
    const workspaceAvailable = resolveWorkspaceDirectory(workspaceRootPath) !== null;
    void input;
    void contextReferences;

    return {
        workspaceEnabled: false,
        browserEnabled: false,
        strategy: workspaceAvailable ? 'gateway+file-primitives' : 'gateway',
    };
};

const createMastraModelConfig = (
    model: TDeepSeekModelConfig,
): MastraModelConfig => model;

const createMastraMemoryForModel = (
    model: TDeepSeekModelConfig,
): ReturnType<typeof createMastraAgentMemory> =>
    createMastraAgentMemory(resolveMastraStorageUrl(), createMastraModelConfig(model));

const defaultCreateAgent = (config: IMastraAgentConfig): IMastraAgentLike => {
    const agent = new Agent({
        id: config.id,
        name: config.name,
        instructions: config.instructions,
        model: config.model,
        ...(config.memory ? { memory: config.memory } : {}),
        ...(config.tools ? { tools: config.tools } : {}),
        ...(config.workspace ? { workspace: config.workspace } : {}),
        ...(config.browser ? { browser: config.browser } : {}),
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

const defaultCreateStorage = (): IMastraStorageLike => new LibSQLStore({
    id: 'agent-sidecar-storage',
    url: resolveMastraStorageUrl(),
});

const defaultCreateExecutionHandle = async (
    config: IMastraAgentConfig,
    storage: IMastraStorageLike,
    loggerRef?: IMastraLogToolsRef,
): Promise<IMastraExecutionHandle> => {
    const fileLogger = createMastraFileLogger(
        process.env.AGENT_SIDECAR_LOG_FILE ?? DEFAULT_MASTRA_LOG_FILE,
    );
    if (loggerRef) {
        loggerRef.current = fileLogger;
    }
    const baseAgent = new Agent({
        id: config.id,
        name: config.name,
        instructions: config.instructions,
        model: config.model,
        ...(config.memory ? { memory: config.memory } : {}),
        ...(config.tools ? { tools: config.tools } : {}),
        ...(config.workspace ? { workspace: config.workspace } : {}),
        ...(config.browser ? { browser: config.browser } : {}),
    });
    const durableAgent = createDurableAgent({ agent: baseAgent });
    const mastra = new Mastra({
        agents: {
            [config.id]: durableAgent,
        },
        ...(config.tools ? { tools: config.tools as never } : {}),
        storage: storage as never,
        logger: fileLogger,
    });
    const registeredAgent = mastra.getAgentById(baseAgent.id) as unknown as IMastraDurableAgentLike;

    return {
        agent: {
            stream: async (messages, options) => {
                const streamResult = await registeredAgent.stream(messages, {
                    ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
                    ...(options?.runId ? { runId: options.runId } : {}),
                    ...(options?.maxSteps ? { maxSteps: options.maxSteps } : {}),
                    ...(options?.toolChoice ? { toolChoice: options.toolChoice } : {}),
                    ...(options?.memory ? { memory: options.memory } : {}),
                    ...(options?.requestContext ? { requestContext: options.requestContext } : {}),
                });

                return {
                    fullStream: streamResult.fullStream as unknown as AsyncIterable<TMastraStreamChunk>,
                    runId: streamResult.runId,
                    cleanup: streamResult.cleanup,
                };
            },
            generate: async () => {
                throw new Error('Durable execution handle does not support generate().');
            },
            approveToolCall: async ({ runId }) => {
                const streamResult = await registeredAgent.resume(runId, { approved: true });

                return {
                    fullStream: streamResult.fullStream as unknown as AsyncIterable<TMastraStreamChunk>,
                    runId: streamResult.runId,
                    cleanup: streamResult.cleanup,
                };
            },
            declineToolCall: async ({ runId }) => {
                const streamResult = await registeredAgent.resume(runId, { approved: false });

                return {
                    fullStream: streamResult.fullStream as unknown as AsyncIterable<TMastraStreamChunk>,
                    runId: streamResult.runId,
                    cleanup: streamResult.cleanup,
                };
            },
        },
        workflow: registeredAgent.getWorkflow(),
    };
};

const findCurrentFileReference = (
    contextReferences: readonly IAgentContextReferenceInput[] = [],
): IAgentContextReferenceInput | null =>
    contextReferences.find((reference) => reference.kind === 'current-file') ?? null;

const createUiContextTools = (
    contextReferences: readonly IAgentContextReferenceInput[] = [],
): Record<string, ReturnType<typeof createTool>> => {
    const currentFile = findCurrentFileReference(contextReferences);

    if (!currentFile) {
        return {};
    }

    return {
        read_current_file: createTool({
            id: 'read_current_file',
            description: 'Read the current editor file preview only when the user asks about the current file. Takes no arguments; output is capped, use read_file_window with line ranges when more content is needed.',
            inputSchema: z.object({}).passthrough(),
            execute: async () => {
                const content = truncateModelOutputText(
                    currentFile.contentPreview,
                    CURRENT_FILE_TOOL_CONTENT_MAX_CHARS,
                );

                return {
                    path: currentFile.path,
                    label: currentFile.label,
                    range: currentFile.range,
                    redacted: currentFile.redacted,
                    content: content.text,
                    truncated: content.truncated,
                    originalCharCount: content.originalCharCount,
                };
            },
            toModelOutput: (output) => createJsonToolModelOutput(compactModelOutput(output, {
                maxTotalChars: CURRENT_FILE_TOOL_MODEL_OUTPUT_MAX_CHARS,
                maxStringChars: CURRENT_FILE_TOOL_CONTENT_MAX_CHARS,
                maxArrayItems: 10,
                maxObjectKeys: 20,
                maxDepth: 4,
            })),
        }),
    };
};

const loadMastraMcpTools = async (
    mcpGatewayPool: McpGatewayWarmPool,
    workspaceRootPath?: string,
    loggerRef?: IMastraLogToolsRef,
    contextReferences: readonly IAgentContextReferenceInput[] = [],
    profile: TMastraToolProfile = 'write',
    input: Pick<IAgentRuntimeInput, 'goal' | 'messages' | 'mode' | 'planId' | 'planStepId'> = {
        mode: 'ask',
        goal: '',
        messages: [],
    },
): Promise<{
    bundle: IMastraMcpBundle;
    tools: ToolsInput;
    hasTools: boolean;
    toolStats: IMastraToolBudgetStats;
    mcpGatewayMetrics: McpGatewayMetricBuffer;
    workspace: AnyWorkspace | undefined;
    browser: MastraBrowser | undefined;
}> => {
    const toolLoadPlan = createMastraToolLoadPlan(input, workspaceRootPath, contextReferences);
    const bundle = createMcpGatewayRunBundle();
    const workspace = undefined;
    const browser = toolLoadPlan.browserEnabled ? createMastraBrowser() : undefined;
    const mcpGatewayMetrics = mcpGatewayPool.createMetricBuffer();
    const mcpGatewayTools = mcpGatewayPool.createTools({
        ...(workspaceRootPath ? { workspaceRootPath } : {}),
        profile,
        metricSink: mcpGatewayMetrics,
    });
    const uiContextTools = createUiContextTools(contextReferences);
    const nativeFileTools = createMastraFileTools(workspaceRootPath, profile);
    const nativeTimeTools = createMastraTimeTools();
    const logTools = loggerRef ? createMastraLogTools(loggerRef) : {};
    const tools: ToolsInput = {
        ...mcpGatewayTools,
        ...uiContextTools,
        ...nativeFileTools,
        ...nativeTimeTools,
        ...logTools,
    };

    return {
        bundle,
        tools,
        hasTools: Object.keys(tools).length > 0,
        toolStats: {
            toolCount: Object.keys(tools).length,
            mcpToolCount: Object.keys(mcpGatewayTools).length,
            mcpServerCount: 0,
            mcpServerNames: [],
            uiContextToolCount: Object.keys(uiContextTools).length,
            nativeToolCount: Object.keys(nativeTimeTools).length + Object.keys(nativeFileTools).length,
            logToolCount: Object.keys(logTools).length,
            toolSchemaCharCount: countProviderToolSchemaChars(tools),
            toolLoadStrategy: toolLoadPlan.strategy,
        },
        mcpGatewayMetrics,
        workspace,
        browser,
    };
};

const findLastUserMessage = (messages: IAgentMessageInput[]): IAgentMessageInput | null => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];

        if (message?.role === 'user') {
            return message;
        }
    }

    return null;
};

const buildMastraUserPrompt = (input: IAgentRuntimeInput): string => {
    const lastUserContent = findLastUserMessage(input.messages)?.content.trim() ?? '';
    const request = lastUserContent || input.goal.trim();
    const goal = request === input.goal ? '' : `目标：${input.goal}`;
    const outputContract = input.mode === 'plan'
        ? '输出格式：返回一个简洁的 json object，根对象必须直接包含 goal、steps；steps 只写短标题节点，不要包裹在 plan/result/data 字段里。'
        : '';

    return [
        outputContract,
        goal,
        request,
    ]
        .filter((line) => line.trim().length > 0)
        .join('\n');
};

const buildMastraMessages = (input: IAgentRuntimeInput): TMastraChatMessage[] => {
    const userPrompt = buildMastraUserPrompt(input).trim();
    const conversationMessages = input.messages
        .filter((message): message is IAgentMessageInput & { role: TMastraChatMessage['role'] } =>
            (message.role === 'user' || message.role === 'assistant')
            && message.content.trim().length > 0)
        .map((message) => ({
            role: message.role,
            content: message.content.trim(),
        }))
        .slice(-EXPLICIT_CONTEXT_MESSAGE_LIMIT);

    if (conversationMessages.length === 0) {
        return [{
            role: 'user',
            content: userPrompt.length > 0
                ? userPrompt
                : (input.goal.trim().length > 0 ? input.goal : '继续。'),
        }];
    }

    if (userPrompt.length === 0) {
        return conversationMessages;
    }

    for (let index = conversationMessages.length - 1; index >= 0; index -= 1) {
        if (conversationMessages[index]?.role === 'user') {
            return conversationMessages.map((message, messageIndex) =>
                messageIndex === index ? { ...message, content: userPrompt } : message);
        }
    }

    return [
        ...conversationMessages,
        { role: 'user', content: userPrompt },
    ];
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

const PLAN_WRAPPER_KEYS = ['plan', 'result', 'data'] as const;
const unwrapGeneratedPlanCandidate = (value: unknown): unknown => {
    const record = toRecord(value);

    if (!record) {
        return value;
    }

    for (const key of PLAN_WRAPPER_KEYS) {
        if (toRecord(record[key])) {
            return record[key];
        }
    }

    return value;
};

const toStringArray = (value: unknown): string[] | undefined => {
    if (value === null || value === undefined) {
        return undefined;
    }

    const singleValue = toNonEmptyString(value);
    if (singleValue) {
        return [singleValue];
    }

    if (!Array.isArray(value)) {
        return undefined;
    }

    const values = value
        .map((item) => toNonEmptyString(item))
        .filter((item): item is string => Boolean(item));

    return values.length > 0 ? values : undefined;
};

const toBoolean = (value: unknown): boolean | undefined => {
    if (typeof value === 'boolean') {
        return value;
    }

    const text = toNonEmptyString(value)?.toLowerCase();

    if (text === 'true' || text === 'yes' || text === '是') {
        return true;
    }

    if (text === 'false' || text === 'no' || text === '否') {
        return false;
    }

    return undefined;
};

const normalizePlanStepStatus = (value: unknown): TAgentPlanStep['status'] => {
    const status = toNonEmptyString(value);
    switch (status) {
        case 'running':
        case 'done':
        case 'failed':
        case 'skipped':
        case 'cancelled':
            return status;
        default:
            return 'pending';
    }
};

const normalizePlanStepRiskLevel = (value: unknown): TAgentPlanStep['riskLevel'] => {
    const riskLevel = toNonEmptyString(value);
    switch (riskLevel) {
        case 'low':
        case 'high':
            return riskLevel;
        default:
            return 'medium';
    }
};

const normalizeGeneratedAgentPlanStep = (
    value: unknown,
    index: number,
): Record<string, unknown> | null => {
    const record = toRecord(value);

    if (!record) {
        return null;
    }

    const title = toNonEmptyString(record.title)
        ?? toNonEmptyString(record.goal)
        ?? toNonEmptyString(record.description)
        ?? `步骤 ${index + 1}`;
    const goal = toNonEmptyString(record.goal)
        ?? toNonEmptyString(record.description)
        ?? title;
    const riskLevel = normalizePlanStepRiskLevel(record.riskLevel);
    const tools = toStringArray(record.tools) ?? [];
    const files = toStringArray(record.files);
    const commands = toStringArray(record.commands);
    const risks = toStringArray(record.risks);
    const acceptanceCriteria = toStringArray(record.acceptanceCriteria);
    const expectedOutput = toNonEmptyString(record.expectedOutput)
        ?? acceptanceCriteria?.join('\n')
        ?? goal;

    return {
        ...record,
        id: toNonEmptyString(record.id) ?? `step-${index + 1}`,
        title,
        goal,
        status: normalizePlanStepStatus(record.status),
        tools,
        ...(files ? { files } : {}),
        ...(commands ? { commands } : {}),
        ...(risks ? { risks } : {}),
        ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
        riskLevel,
        requiresApproval: toBoolean(record.requiresApproval) ?? (
            riskLevel !== 'low'
        ),
        expectedOutput,
    };
};

const normalizeGeneratedAgentPlan = (
    value: unknown,
    fallbackGoal: string,
): TAgentPlan | null => {
    const generationResult = agentPlanGenerationSchema.safeParse(value);

    if (!generationResult.success) {
        return null;
    }

    const candidateRecord = toRecord(unwrapGeneratedPlanCandidate(generationResult.data));

    if (!candidateRecord) {
        return null;
    }

    const steps = Array.isArray(candidateRecord.steps)
        ? candidateRecord.steps
            .map((step, index) => normalizeGeneratedAgentPlanStep(step, index))
            .filter((step): step is Record<string, unknown> => Boolean(step))
        : undefined;

    const parsedPlan = agentPlanSchema.safeParse({
        ...candidateRecord,
        goal: toNonEmptyString(candidateRecord.goal) ?? fallbackGoal,
        requiresApproval: toBoolean(candidateRecord.requiresApproval) ?? true,
        ...(steps ? { steps } : {}),
    });

    return parsedPlan.success ? parsedPlan.data : null;
};

const parseValidationReport = (value: unknown): TAgentPlanValidationReport | null => {
    const parsedReport = agentPlanValidationReportSchema.safeParse(value);
    return parsedReport.success ? parsedReport.data : null;
};

const parsePlanDelta = (value: unknown): TAgentPlanDelta | null => {
    const parsedDelta = agentPlanDeltaSchema.safeParse(value);
    return parsedDelta.success ? parsedDelta.data : null;
};

const applyStepPatch = (
    step: TAgentPlanStep,
    patch: TAgentPlanStepPatch,
): TAgentPlanStep => {
    const definedPatch: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) {
            definedPatch[key] = value;
        }
    }

    return agentPlanStepSchema.parse({
        ...step,
        ...definedPatch,
        status: 'pending',
    });
};

const applyAgentPlanDelta = (
    plan: TAgentPlan,
    delta: TAgentPlanDelta,
): TAgentPlan | null => {
    const removedIds = new Set(delta.removed);
    const modifiedById = new Map(delta.modified.map((item) => [item.id, item.patch]));
    const addedIds = new Set(delta.added.map((step) => step.id));
    const steps = [
        ...plan.steps
            .filter((step) => !removedIds.has(step.id))
            .map((step) => {
                const patch = modifiedById.get(step.id);
                return patch ? applyStepPatch(step, patch) : step;
            })
            .filter((step) => !addedIds.has(step.id)),
        ...delta.added,
    ];
    const parsedPlan = agentPlanSchema.safeParse({
        ...plan,
        summary: delta.summary,
        steps,
        requiresApproval: true,
    });

    return parsedPlan.success ? parsedPlan.data : null;
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

const getTextDelta = (chunk: TMastraTextDeltaChunk): string => chunk.payload.text;

const isReasoningDeltaChunk = (
    chunk: TMastraStreamChunk,
): chunk is TCompatibleReasoningDeltaChunk => chunk.type === 'reasoning-delta';

const getReasoningDelta = (chunk: TMastraStreamChunk): string | null => {
    if (isReasoningDeltaChunk(chunk)) {
        return chunk.payload.text
            ?? chunk.payload.reasoning
            ?? chunk.payload.delta
            ?? chunk.payload.reasoning_content
            ?? chunk.payload.reasoningContent
            ?? null;
    }

    return null;
};

const isTextDeltaChunk = (
    chunk: TMastraStreamChunk,
): chunk is TMastraTextDeltaChunk => chunk.type === 'text-delta';

const isToolCallChunk = (
    chunk: TMastraStreamChunk,
): chunk is ToolCallChunk | TMastraToolCallApprovalChunk =>
    (chunk.type === 'tool-call' || chunk.type === 'tool-call-approval')
    && typeof chunk.payload.toolName === 'string'
    && typeof chunk.payload.toolCallId === 'string';

const isToolResultChunk = (
    chunk: TMastraStreamChunk,
): chunk is ToolResultChunk & { payload: TCompatibleToolResultPayload } =>
    chunk.type === 'tool-result'
    && typeof chunk.payload.toolName === 'string'
    && 'result' in chunk.payload;

const isToolCallSuspendedChunk = (
    chunk: TMastraStreamChunk,
): chunk is TMastraToolCallSuspendedChunk =>
    chunk.type === 'tool-call-suspended'
    && typeof chunk.payload.toolCallId === 'string'
    && typeof chunk.payload.toolName === 'string';

const isToolErrorChunk = (
    chunk: TMastraStreamChunk,
): chunk is TMastraToolErrorChunk =>
    chunk.type === 'tool-error'
    && typeof chunk.payload.toolName === 'string';

const isErrorChunk = (
    chunk: TMastraStreamChunk,
): chunk is TMastraErrorChunk => chunk.type === 'error';

const isOmOperationType = (value: unknown): value is TOmMemoryCompressedEventDraft['operationType'] =>
    value === 'observation' || value === 'reflection';

const isOmActivationTrigger = (
    value: unknown,
): value is NonNullable<TOmMemoryCompressedEventDraft['triggeredBy']> =>
    value === 'threshold' || value === 'ttl' || value === 'provider_change';

const toFiniteNumber = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const toNonNegativeFiniteNumber = (value: unknown): number | undefined => {
    const candidate = toFiniteNumber(value);
    return candidate !== undefined && candidate >= 0 ? candidate : undefined;
};

const sumTokenCounts = (
    left: number | undefined,
    right: number | undefined,
): number | undefined => {
    if (left === undefined && right === undefined) {
        return undefined;
    }

    return (left ?? 0) + (right ?? 0);
};

const sumRequiredTokenCounts = (
    left: number | undefined,
    right: number | undefined,
): number => (left ?? 0) + (right ?? 0);

const readRawTokenValue = (
    raw: Record<string, unknown> | null,
    key: string,
): number | undefined => toNonNegativeFiniteNumber(raw?.[key]);

const parseInputTokenDetails = (
    record: Record<string, unknown>,
    inputTokens: number,
): NonNullable<NonNullable<TDoneTokenSnapshot['usage']>['inputTokenDetails']> | undefined => {
    const inputTokenDetailsRecord = toRecord(record.inputTokenDetails);
    const raw = toRecord(record.raw);
    const rawCacheHitTokens = readRawTokenValue(raw, 'prompt_cache_hit_tokens');
    const rawCacheMissTokens = readRawTokenValue(raw, 'prompt_cache_miss_tokens');
    const cacheReadTokens = toNonNegativeFiniteNumber(inputTokenDetailsRecord?.cacheReadTokens)
        ?? toNonNegativeFiniteNumber(record.cachedInputTokens)
        ?? rawCacheHitTokens;
    const noCacheTokens = toNonNegativeFiniteNumber(inputTokenDetailsRecord?.noCacheTokens)
        ?? rawCacheMissTokens;
    const cacheWriteTokens = toNonNegativeFiniteNumber(inputTokenDetailsRecord?.cacheWriteTokens);

    if (
        cacheReadTokens === undefined
        && noCacheTokens === undefined
        && cacheWriteTokens === undefined
    ) {
        return undefined;
    }

    const resolvedCacheReadTokens = cacheReadTokens ?? 0;
    const resolvedNoCacheTokens = noCacheTokens ?? Math.max(0, inputTokens - resolvedCacheReadTokens);

    return {
        noCacheTokens: resolvedNoCacheTokens,
        cacheReadTokens: resolvedCacheReadTokens,
        cacheWriteTokens: cacheWriteTokens ?? 0,
    };
};

const parseOutputTokenDetails = (
    record: Record<string, unknown>,
    outputTokens: number,
): NonNullable<NonNullable<TDoneTokenSnapshot['usage']>['outputTokenDetails']> | undefined => {
    const outputTokenDetailsRecord = toRecord(record.outputTokenDetails);
    const raw = toRecord(record.raw);
    const rawCompletionTokenDetails = toRecord(raw?.completion_tokens_details);
    const textTokens = toNonNegativeFiniteNumber(outputTokenDetailsRecord?.textTokens);
    const reasoningTokens = toNonNegativeFiniteNumber(outputTokenDetailsRecord?.reasoningTokens)
        ?? toNonNegativeFiniteNumber(record.reasoningTokens)
        ?? toNonNegativeFiniteNumber(rawCompletionTokenDetails?.reasoning_tokens);

    if (textTokens === undefined && reasoningTokens === undefined) {
        return undefined;
    }

    const resolvedReasoningTokens = reasoningTokens ?? 0;

    return {
        textTokens: textTokens ?? Math.max(0, outputTokens - resolvedReasoningTokens),
        reasoningTokens: resolvedReasoningTokens,
    };
};

const aggregateDoneTokenSnapshot = (
    current: TDoneTokenSnapshot | undefined,
    next: TDoneTokenSnapshot,
): TDoneTokenSnapshot => {
    if (!current) {
        return next;
    }

    const promptTokens = sumTokenCounts(current.promptTokens, next.promptTokens);
    const completionTokens = sumTokenCounts(current.completionTokens, next.completionTokens);
    const totalTokens = sumTokenCounts(current.totalTokens, next.totalTokens);
    const currentUsage = current.usage ?? undefined;
    const nextUsage = next.usage ?? undefined;
    const inputTokenDetails = currentUsage?.inputTokenDetails || nextUsage?.inputTokenDetails
        ? {
            noCacheTokens: sumTokenCounts(
                currentUsage?.inputTokenDetails?.noCacheTokens,
                nextUsage?.inputTokenDetails?.noCacheTokens,
            ) ?? 0,
            cacheReadTokens: sumTokenCounts(
                currentUsage?.inputTokenDetails?.cacheReadTokens,
                nextUsage?.inputTokenDetails?.cacheReadTokens,
            ) ?? 0,
            cacheWriteTokens: sumTokenCounts(
                currentUsage?.inputTokenDetails?.cacheWriteTokens,
                nextUsage?.inputTokenDetails?.cacheWriteTokens,
            ) ?? 0,
        }
        : undefined;
    const outputTokenDetails = currentUsage?.outputTokenDetails || nextUsage?.outputTokenDetails
        ? {
            textTokens: sumTokenCounts(
                currentUsage?.outputTokenDetails?.textTokens,
                nextUsage?.outputTokenDetails?.textTokens,
            ) ?? 0,
            reasoningTokens: sumTokenCounts(
                currentUsage?.outputTokenDetails?.reasoningTokens,
                nextUsage?.outputTokenDetails?.reasoningTokens,
            ) ?? 0,
        }
        : undefined;
    const cachedInputTokens = sumTokenCounts(
        currentUsage?.cachedInputTokens,
        nextUsage?.cachedInputTokens,
    );
    const reasoningTokens = sumTokenCounts(
        currentUsage?.reasoningTokens,
        nextUsage?.reasoningTokens,
    );

    return {
        ...(promptTokens !== undefined ? { promptTokens } : {}),
        ...(completionTokens !== undefined ? { completionTokens } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
        usage: {
            inputTokens: sumRequiredTokenCounts(currentUsage?.inputTokens, nextUsage?.inputTokens),
            ...(inputTokenDetails ? { inputTokenDetails } : {}),
            outputTokens: sumRequiredTokenCounts(currentUsage?.outputTokens, nextUsage?.outputTokens),
            ...(outputTokenDetails ? { outputTokenDetails } : {}),
            totalTokens: sumRequiredTokenCounts(currentUsage?.totalTokens, nextUsage?.totalTokens),
            ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
            ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
        },
    };
};

const parseDoneTokenSnapshot = (value: unknown): TDoneTokenSnapshot | undefined => {
    const record = toRecord(value);

    if (!record) {
        return undefined;
    }

    const inputTokens = toNonNegativeFiniteNumber(record.inputTokens);
    const outputTokens = toNonNegativeFiniteNumber(record.outputTokens);
    const totalTokens = toNonNegativeFiniteNumber(record.totalTokens);

    if (
        inputTokens === undefined
        || outputTokens === undefined
        || totalTokens === undefined
    ) {
        return undefined;
    }

    const inputTokenDetails = parseInputTokenDetails(record, inputTokens);
    const outputTokenDetails = parseOutputTokenDetails(record, outputTokens);
    const cachedInputTokens = toNonNegativeFiniteNumber(record.cachedInputTokens);
    const reasoningTokens = toNonNegativeFiniteNumber(record.reasoningTokens);

    return {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens,
        usage: {
            inputTokens,
            outputTokens,
            totalTokens,
            ...(inputTokenDetails ? { inputTokenDetails } : {}),
            ...(outputTokenDetails ? { outputTokenDetails } : {}),
            ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
            ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
            ...('raw' in record ? { raw: record.raw } : {}),
        },
    };
};

const isFinishChunk = (chunk: TMastraStreamChunk): chunk is TMastraFinishChunk => chunk.type === 'finish';

const extractFinishTokenSnapshot = (chunk: TMastraStreamChunk): TDoneTokenSnapshot | undefined =>
    isFinishChunk(chunk)
        ? parseDoneTokenSnapshot(chunk.payload.output?.usage)
        : undefined;

const createDoneOutputEvent = (
    result: string,
    tokenSnapshot?: TDoneTokenSnapshot,
): Extract<TAgentRuntimeOutputEvent, { type: 'done' }> => ({
    type: 'done',
    result,
    ...(tokenSnapshot?.promptTokens !== undefined ? { promptTokens: tokenSnapshot.promptTokens } : {}),
    ...(tokenSnapshot?.completionTokens !== undefined ? { completionTokens: tokenSnapshot.completionTokens } : {}),
    ...(tokenSnapshot?.totalTokens !== undefined ? { totalTokens: tokenSnapshot.totalTokens } : {}),
    ...(tokenSnapshot?.usage ? { usage: tokenSnapshot.usage } : {}),
});

const isOmDataChunk = (chunk: TMastraStreamChunk): chunk is TOmDataChunk =>
    chunk.type === 'data-om-activation' || chunk.type === 'data-om-observation-end';

const createOmMemoryCompressedEventDraft = (chunk: TMastraStreamChunk): TOmMemoryCompressedEventDraft | null => {
    if (!isOmDataChunk(chunk)) {
        return null;
    }

    const data = toRecord(chunk.data);
    const operationType = data?.operationType;

    if (!data || !isOmOperationType(operationType)) {
        return null;
    }

    const tokensActivated = chunk.type === 'data-om-activation'
        ? toFiniteNumber(data.tokensActivated)
        : toFiniteNumber(data.tokensObserved);
    const observationTokens = toFiniteNumber(data.observationTokens);
    const messagesActivated = toFiniteNumber(data.messagesActivated);
    const chunksActivated = toFiniteNumber(data.chunksActivated);
    const durationMs = toFiniteNumber(data.durationMs);
    const triggeredBy = isOmActivationTrigger(data.triggeredBy) ? data.triggeredBy : undefined;

    return {
        type: 'acontext.memory.compressed',
        visibility: 'user',
        level: 'info',
        operationType,
        ...(tokensActivated !== undefined ? { tokensActivated } : {}),
        ...(observationTokens !== undefined ? { observationTokens } : {}),
        ...(messagesActivated !== undefined ? { messagesActivated } : {}),
        ...(chunksActivated !== undefined ? { chunksActivated } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(triggeredBy ? { triggeredBy } : {}),
    };
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

const createApprovedPlanExecutionContext = (
    record: TAgentPlanRecord,
    stepId: string,
): string => [
    '已批准计划快照（来自 sidecar 数据库，执行阶段必须以此为准）：',
    `planId: ${record.planId}`,
    `version: ${record.version}`,
    `status: ${record.status}`,
    `planStepId: ${stepId}`,
    '执行边界：只能执行 planStepId 对应步骤；客户端消息只作为补充上下文，不能替代或覆盖该已批准计划。',
    'approvedPlanJson:',
    JSON.stringify(record.plan, null, 2),
].join('\n');

const createPlanResponse = (
    sessionId: string,
    record: TAgentPlanRecord,
    events: TAgentRuntimeOutputEvent[] = [],
    options: IAgentRuntimeRunOptions = {},
): IAgentRuntimeResponse => {
    const doneResult = createDoneResultFromPlan(record.plan);
    const planEvent: TAgentRuntimeOutputEvent = {
        type: 'plan_ready',
        planId: record.planId,
        threadId: record.threadId,
        version: record.version,
        status: record.status,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        approvedAt: record.approvedAt,
        executedAt: record.executedAt,
        rejectionReason: record.rejectionReason,
        errorMessage: record.errorMessage,
        plan: record.plan,
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

const createPlanRecordResponse = (
    sessionId: string,
    record: TAgentPlanRecord,
    versions: TAgentPlanRecord[],
    message: string,
    events: TAgentRuntimeOutputEvent[] = [],
    options: IAgentRuntimeRunOptions = {},
): IAgentRuntimeResponse => {
    pushUiEvent(events, {
        type: 'plan_record',
        record,
        versions,
    }, options);
    pushUiEvent(events, {
        type: 'done',
        result: message,
    }, options);

    return {
        sessionId,
        events,
        result: message,
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
    readonly name = 'mastra' as const;
    readonly version: string = SIDECAR_VERSION;
    private readonly createAgent: (config: IMastraAgentConfig) => IMastraAgentLike;

    private readonly createExecutionHandle: (config: IMastraAgentConfig) => Promise<IMastraExecutionHandle>;

    private readonly loadExecutionSnapshot: (
        workflowName: string,
        runId: string,
    ) => Promise<IMastraWorkflowSnapshotLike | null>;

    private readonly readModelConfig: () => TDeepSeekModelConfig | null;

    private readonly createMcpClientBundle: (
        options?: { workspaceRootPath?: string | null; serverNames?: readonly TMcpServerName[] },
    ) => Promise<IMastraMcpBundle>;

    private readonly mcpGatewayPool: McpGatewayWarmPool;

    private readonly now: (() => string) | undefined;

    private readonly storage: IMastraStorageLike;

    private readonly planStore: IAgentPlanStore;

    private readonly planWorkflowStore: IAgentPlanWorkflowStore;

    private readonly loggerRef: IMastraLogToolsRef;

    private readonly pendingApprovals = new Map<string, IMastraPendingApproval>();

    constructor(deps: IMastraRuntimeDeps = {}) {
        this.createAgent = deps.createAgent ?? defaultCreateAgent;
        this.storage = deps.createStorage ? deps.createStorage() : defaultCreateStorage();
        this.planStore = deps.createPlanStore ? deps.createPlanStore() : createAgentPlanStore();
        this.planWorkflowStore = deps.createPlanWorkflowStore
            ? deps.createPlanWorkflowStore()
            : createAgentPlanWorkflowStore();
        this.loggerRef = createMastraLoggerRef();
        this.createExecutionHandle = deps.createExecutionHandle
            ?? ((config) => defaultCreateExecutionHandle(config, this.storage, this.loggerRef));
        this.loadExecutionSnapshot = deps.loadExecutionSnapshot
            ?? (async (workflowName, runId) => {
                const workflowStore = await this.storage.getStore('workflows');
                return workflowStore?.loadWorkflowSnapshot({ workflowName, runId }) ?? null;
            });
        this.readModelConfig = deps.readModelConfig ?? createDeepSeekModelConfigFromEnv;
        this.createMcpClientBundle = deps.createMcpClientBundle ?? createMastraMcpClientBundle;
        this.mcpGatewayPool = createMcpGatewayWarmPool({
            createBundle: this.createMcpClientBundle,
        });
        if (!deps.createMcpClientBundle && !isNodeTestProcess()) {
            void this.mcpGatewayPool.primeCatalog().catch(() => undefined);
        }
        this.now = deps.now;
    }

    private registerPendingApproval(
        sessionId: string,
        agent: IMastraAgentLike,
        bundle: IMastraMcpBundle,
        chunk: TMastraToolCallApprovalChunk,
        workspace?: AnyWorkspace,
        browser?: MastraBrowser,
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
            ...(workspace ? { workspace } : {}),
            ...(browser ? { browser } : {}),
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
        createRuntimeEvent?: TRuntimeEventFactory,
        workspace?: AnyWorkspace,
        browser?: MastraBrowser,
        workflowTracker?: IPlanWorkflowStepTracker,
    ): Promise<IMastraTextStreamSummary> {
        let visibleText = '';
        let emittedVisibleText = '';
        let streamErrorMessage: string | null = null;
        let pendingApproval = false;
        let releaseResources = true;
        let doneTokenSnapshot: TDoneTokenSnapshot | undefined;
        const pendingToolCallIdsByName = new Map<string, string[]>();

        for await (const rawChunk of stream.fullStream) {
            const chunk = rawChunk as TMastraStreamChunk;
            const finishTokenSnapshot = extractFinishTokenSnapshot(chunk);
            if (finishTokenSnapshot) {
                doneTokenSnapshot = aggregateDoneTokenSnapshot(doneTokenSnapshot, finishTokenSnapshot);
                continue;
            }

            const memoryCompressedEvent = createOmMemoryCompressedEventDraft(chunk);
            if (memoryCompressedEvent) {
                if (createRuntimeEvent) {
                    pushUiEvent(events, createRuntimeEvent(memoryCompressedEvent), options);
                }
                continue;
            }

            const reasoningDelta = getReasoningDelta(chunk);
            if (reasoningDelta) {
                if (createRuntimeEvent) {
                    pushUiEvent(events, createRuntimeEvent({
                        type: 'agent.reasoning.delta',
                        visibility: 'user',
                        level: 'info',
                        text: redactForStream(reasoningDelta),
                    }), options);
                }
                continue;
            }

            if (isTextDeltaChunk(chunk)) {
                const nextText = getTextDelta(chunk);
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

            if (chunk.type === 'tool-call' && isToolCallChunk(chunk)) {
                if (workflowTracker) {
                    await this.planWorkflowStore.heartbeat({
                        planId: workflowTracker.planId,
                        version: workflowTracker.version,
                        stepId: workflowTracker.stepId,
                        phase: 'before_tool',
                    });
                }

                const input = chunk.payload.args === undefined ? null : toJsonValue(chunk.payload.args);
                const pendingToolCallIds = pendingToolCallIdsByName.get(chunk.payload.toolName) ?? [];
                pendingToolCallIds.push(chunk.payload.toolCallId);
                pendingToolCallIdsByName.set(chunk.payload.toolName, pendingToolCallIds);

                if (createRuntimeEvent) {
                    const inputPreview = chunk.payload.args === undefined
                        ? ''
                        : createRuntimePreview(chunk.payload.args);

                    pushUiEvent(events, createRuntimeEvent({
                        type: 'agent.tool.started',
                        visibility: 'user',
                        level: 'info',
                        toolName: chunk.payload.toolName,
                        toolUseId: chunk.payload.toolCallId,
                        ...(inputPreview ? { inputPreview } : {}),
                    }), options);
                }

                pushUiEvent(events, {
                    type: 'tool_start',
                    toolName: chunk.payload.toolName,
                    input,
                }, options);
                continue;
            }

            if (isToolResultChunk(chunk)) {
                if (workflowTracker) {
                    await this.planWorkflowStore.heartbeat({
                        planId: workflowTracker.planId,
                        version: workflowTracker.version,
                        stepId: workflowTracker.stepId,
                        phase: 'after_tool',
                    });
                }

                const output = toJsonValue(chunk.payload.result);
                const pendingToolCallIds = pendingToolCallIdsByName.get(chunk.payload.toolName) ?? [];
                const toolUseId = chunk.payload.toolCallId ?? pendingToolCallIds.shift();

                if (createRuntimeEvent) {
                    const resultPreview = createRuntimePreview(chunk.payload.result);

                    pushUiEvent(events, createRuntimeEvent({
                        type: 'agent.tool.completed',
                        visibility: 'user',
                        level: 'info',
                        toolName: chunk.payload.toolName,
                        ok: true,
                        ...(toolUseId ? { toolUseId } : {}),
                        ...(resultPreview ? { resultPreview } : {}),
                    }), options);
                }

                pushUiEvent(events, {
                    type: 'tool_result',
                    toolName: chunk.payload.toolName,
                    output,
                }, options);
                continue;
            }

            if (chunk.type === 'tool-call-approval' && isToolCallChunk(chunk)) {
                pendingApproval = true;
                const pendingRequestId = this.registerPendingApproval(
                    sessionId,
                    agent,
                    bundle,
                    chunk,
                    workspace,
                    browser,
                );

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
                const errorMessage = normalizeMastraError(chunk.payload.error);

                if (createRuntimeEvent) {
                    pushUiEvent(events, createRuntimeEvent({
                        type: 'agent.tool.completed',
                        visibility: 'user',
                        level: 'error',
                        toolName: chunk.payload.toolName,
                        ok: false,
                        errorMessage,
                    }), options);
                }

                pushUiEvent(events, {
                    type: 'tool_result',
                    toolName: chunk.payload.toolName,
                    output: toJsonValue({
                        error: errorMessage,
                    }),
                }, options);
                continue;
            }

            if (isErrorChunk(chunk)) {
                streamErrorMessage = normalizeMastraError(chunk.payload.error);
                continue;
            }

            if (chunk.type === 'abort') {
                streamErrorMessage = 'Mastra Agent 执行已中止。';
            }
        }

        return {
            pendingApproval,
            releaseResources,
            streamErrorMessage,
            visibleText,
            ...(doneTokenSnapshot ? { doneTokenSnapshot } : {}),
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
            toolStats,
            mcpGatewayMetrics,
            workspace,
            browser,
        } = await loadMastraMcpTools(
            this.mcpGatewayPool,
            normalizedInput.workspaceRootPath,
            this.loggerRef,
            normalizedInput.context ?? [],
            normalizedInput.mode === 'agent' ? 'write' : 'readonly',
            normalizedInput,
        );
        const hasAgentTools = hasTools || Boolean(workspace) || Boolean(browser);
        const requestedRunId = options.context?.requestId ?? createSessionId(`${sessionPrefix}-run`);
        const memory = createMastraMemoryReference(createMastraMemoryScope(normalizedInput, sessionId));
        const agentMemory = createMastraMemoryForModel(modelConfig);
        const systemPrompt = buildSystemPrompt(normalizedInput, modelConfig.modelId);
        const payloadEventSink = createDeepSeekPayloadEventSink(events, options);
        let shouldDisconnectBundle = true;

        try {
            return await runWithDeepSeekReasoningContext({
                sessionId,
                runId: requestedRunId,
                onRequestPayload: payloadEventSink.onRequestPayload,
            }, async () => {
                const agent = this.createAgent({
                    id: 'calamex-agent-sidecar',
                    name: 'Calamex Agent Sidecar',
                    instructions: systemPrompt,
                    model: createMastraModelConfig(modelConfig),
                    memory: agentMemory,
                    ...(hasTools ? { tools: mastraTools } : {}),
                    ...(workspace ? { workspace } : {}),
                    ...(browser ? { browser } : {}),
                });
                const toolChoice: IMastraGenerateOptions['toolChoice'] = hasAgentTools ? 'auto' : 'none';
                const streamOptions: IMastraGenerateOptions = {
                    maxSteps: hasAgentTools ? 10 : 1,
                    toolChoice,
                    memory,
                    ...(options.context?.signal ? { abortSignal: options.context.signal } : {}),
                    ...(options.context?.requestId ? { runId: requestedRunId } : {}),
                };
                const mastraMessages = buildMastraMessages(normalizedInput);
                const stream = await agent.stream(mastraMessages, {
                    ...streamOptions,
                });
                const createRuntimeEvent = createRuntimeEventFactory({
                    runId: stream.runId ?? requestedRunId,
                    sessionId,
                    agentId: DEFAULT_EXECUTION_AGENT_ID,
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
                    memoryEnabled: true,
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

    async plan(
        input: IAgentRuntimeInput,
        options: IAgentRuntimeRunOptions = {},
    ): Promise<IAgentRuntimeResponse> {
        const sessionId = input.sessionId ?? createSessionId('mastra-plan');
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
        const memory = createMastraMemoryReference(createMastraMemoryScope(input, sessionId));
        const agentMemory = createMastraMemoryForModel(modelConfig);
        const payloadEventSink = createDeepSeekPayloadEventSink(events, options);

        try {
            return await runWithDeepSeekReasoningContext({
                sessionId,
                runId: requestedRunId,
                onRequestPayload: payloadEventSink.onRequestPayload,
            }, async () => {
                const systemPrompt = buildSystemPrompt(planInput, modelConfig.modelId);
                const agent = this.createAgent({
                    id: 'calamex-agent-sidecar-plan',
                    name: 'Calamex Agent Plan Sidecar',
                    instructions: systemPrompt,
                    model: createMastraModelConfig(modelConfig),
                    memory: agentMemory,
                    ...(hasTools ? { tools: mastraTools } : {}),
                    ...(workspace ? { workspace } : {}),
                    ...(browser ? { browser } : {}),
                });
                const toolChoice: IMastraGenerateOptions['toolChoice'] = hasAgentTools ? 'auto' : 'none';
                const generateOptions: IMastraGenerateOptions = {
                    maxSteps: hasAgentTools ? 10 : 1,
                    toolChoice,
                    structuredOutput: {
                        schema: agentPlanGenerationSchema,
                        ...(hasAgentTools ? { jsonPromptInjection: true } : {}),
                    },
                    memory,
                    ...(options.context?.signal ? { abortSignal: options.context.signal } : {}),
                    runId: requestedRunId,
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
                    maxSteps: generateOptions.maxSteps ?? 1,
                    toolChoice,
                })), options);
                const generated = await agent.generate(mastraMessages, generateOptions);
                const parsedPlan = normalizeGeneratedAgentPlan(generated.object, input.goal);

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
            await mcpBundle.disconnectAll();
            await destroyMastraWorkspace(workspace);
            await destroyMastraBrowser(browser);
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

    async validatePlan(
        input: IAgentRuntimeInput,
        options: IAgentRuntimeRunOptions = {},
    ): Promise<IAgentRuntimeResponse> {
        const sessionId = input.sessionId ?? createSessionId('mastra-plan-validate');
        const events: TAgentRuntimeOutputEvent[] = [];
        const planId = toNonEmptyString(input.planId);
        const planVersion = input.planVersion;

        if (!planId || !Number.isInteger(planVersion) || Number(planVersion) <= 0) {
            return createErrorResponse(
                sessionId,
                '计划验证需要 planId 和 planVersion。',
                events,
                options,
            );
        }

        const modelConfig = this.readModelConfig();

        if (!modelConfig) {
            return createErrorResponse(
                sessionId,
                'DeepSeek 未配置：请在 Node sidecar 环境设置 DEEPSEEK_API_KEY。',
                events,
                options,
            );
        }

        const record = await this.planStore.getPlan({
            planId,
            version: Number(planVersion),
        });
        let workflow = await this.planWorkflowStore.createForPlan({ record });
        if (record.status !== 'pending_approval' && record.status !== 'rejected') {
            workflow = await this.planWorkflowStore.approvePlan(record);
        }
        const workflowEvents = await this.planWorkflowStore.listEvents({
            planId,
            version: Number(planVersion),
        });
        const memoryInput: IAgentRuntimeInput = {
            ...input,
            threadId: input.threadId ?? record.threadId,
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
            memoryInput,
        );
        const requestedRunId = options.context?.requestId ?? createSessionId('mastra-plan-validator-run');
        const memory = createMastraMemoryReference(createMastraMemoryScope(memoryInput, sessionId));
        const agentMemory = createMastraMemoryForModel(modelConfig);
        const payloadEventSink = createDeepSeekPayloadEventSink(events, options);

        try {
            return await runWithDeepSeekReasoningContext({
                sessionId,
                runId: requestedRunId,
                onRequestPayload: payloadEventSink.onRequestPayload,
            }, async () => {
                const systemPrompt = [
                    '你是 Plan Mode 的 Validator Agent。',
                    '你只能验证已批准计划的执行结果，不允许修改文件，不允许提出无关重构。',
                    '优先依据 workflow event log、计划验收标准、用户目标和只读工具结果判断是否完成。',
                    '必须返回 json object，并严格匹配结构化输出 schema。',
                ].join('\n');
                const agent = this.createAgent({
                    id: DEFAULT_VALIDATOR_AGENT_ID,
                    name: 'Calamex Plan Validator',
                    instructions: systemPrompt,
                    model: createMastraModelConfig(modelConfig),
                    memory: agentMemory,
                    ...(hasTools ? { tools: mastraTools } : {}),
                    ...(workspace ? { workspace } : {}),
                    ...(browser ? { browser } : {}),
                });
                const prompt = [
                    '请验证这个已执行计划的结果，返回 json object。',
                    `用户补充目标：${input.goal}`,
                    'approvedPlanJson:',
                    JSON.stringify(record.plan, null, 2),
                    'workflowStateJson:',
                    JSON.stringify(workflow.state, null, 2),
                    'workflowEventsJson:',
                    JSON.stringify(workflowEvents.map((event) => event.event), null, 2),
                ].join('\n');
                const toolChoice: IMastraGenerateOptions['toolChoice'] =
                    hasTools || Boolean(workspace) || Boolean(browser) ? 'auto' : 'none';
                const generateOptions: IMastraGenerateOptions = {
                    maxSteps: hasTools || Boolean(workspace) || Boolean(browser) ? 8 : 1,
                    toolChoice,
                    structuredOutput: {
                        schema: agentPlanValidationReportSchema,
                    },
                    memory,
                    ...(options.context?.signal ? { abortSignal: options.context.signal } : {}),
                    runId: requestedRunId,
                };
                const mastraMessages: TMastraChatMessage[] = [{ role: 'user', content: prompt }];
                const createRuntimeEvent = createRuntimeEventFactory({
                    runId: requestedRunId,
                    sessionId,
                    agentId: DEFAULT_VALIDATOR_AGENT_ID,
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
                    maxSteps: generateOptions.maxSteps ?? 1,
                    toolChoice,
                })), options);
                const generated = await agent.generate(mastraMessages, generateOptions);
                const report = parseValidationReport(generated.object);

                if (!report) {
                    return createErrorResponse(
                        sessionId,
                        'Validator 没有返回有效验证报告。',
                        events,
                        options,
                    );
                }

                const projectedWorkflow = await this.planWorkflowStore.reportValidator({
                    planId,
                    version: Number(planVersion),
                    report,
                });
                const result = report.needsReplan
                    ? `验证完成：${report.summary}，需要重新规划。`
                    : `验证完成：${report.summary}`;

                pushUiEvent(events, {
                    type: 'tool_result',
                    toolName: 'plan_validator',
                    output: toJsonValue({
                        report,
                        workflowPhase: projectedWorkflow.phase,
                        workflowStatus: projectedWorkflow.status,
                    }),
                }, options);
                pushUiEvent(events, createDoneOutputEvent(result), options);

                return {
                    sessionId,
                    events,
                    result,
                };
            });
        } catch (error) {
            return createErrorResponse(
                sessionId,
                `Validator 执行失败：${normalizeMastraError(error)}`,
                events,
                options,
            );
        } finally {
            evictDeepSeekReasoningByPrefix(createDeepSeekReasoningRunPrefix(sessionId, requestedRunId));
            await mcpBundle.disconnectAll();
            await destroyMastraWorkspace(workspace);
            await destroyMastraBrowser(browser);
        }
    }

    async replanPlan(
        input: IAgentRuntimeInput,
        options: IAgentRuntimeRunOptions = {},
    ): Promise<IAgentRuntimeResponse> {
        const sessionId = input.sessionId ?? createSessionId('mastra-plan-replan');
        const events: TAgentRuntimeOutputEvent[] = [];
        const planId = toNonEmptyString(input.planId);
        const planVersion = input.planVersion;

        if (!planId || !Number.isInteger(planVersion) || Number(planVersion) <= 0) {
            return createErrorResponse(
                sessionId,
                '重新规划需要 planId 和 planVersion。',
                events,
                options,
            );
        }

        const modelConfig = this.readModelConfig();

        if (!modelConfig) {
            return createErrorResponse(
                sessionId,
                'DeepSeek 未配置：请在 Node sidecar 环境设置 DEEPSEEK_API_KEY。',
                events,
                options,
            );
        }

        const record = await this.planStore.getPlan({
            planId,
            version: Number(planVersion),
        });
        let workflow = await this.planWorkflowStore.createForPlan({ record });
        if (record.status !== 'pending_approval' && record.status !== 'rejected') {
            workflow = await this.planWorkflowStore.approvePlan(record);
        }
        const workflowEvents = await this.planWorkflowStore.listEvents({
            planId,
            version: Number(planVersion),
        });
        const memoryInput: IAgentRuntimeInput = {
            ...input,
            threadId: input.threadId ?? record.threadId,
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
            memoryInput,
        );
        const requestedRunId = options.context?.requestId ?? createSessionId('mastra-plan-replanner-run');
        const memory = createMastraMemoryReference(createMastraMemoryScope(memoryInput, sessionId));
        const agentMemory = createMastraMemoryForModel(modelConfig);
        const payloadEventSink = createDeepSeekPayloadEventSink(events, options);

        try {
            return await runWithDeepSeekReasoningContext({
                sessionId,
                runId: requestedRunId,
                onRequestPayload: payloadEventSink.onRequestPayload,
            }, async () => {
                const systemPrompt = [
                    '你是 Plan Mode 的 Replanner Agent。',
                    '你只输出最小 delta plan，不重写已完成且仍然有效的步骤。',
                    'stepId 必须稳定：保留已有语义步骤 id，新步骤使用语义化 id，不使用数组下标含义。',
                    '必须返回 json object，并严格匹配结构化输出 schema。',
                ].join('\n');
                const agent = this.createAgent({
                    id: DEFAULT_REPLANNER_AGENT_ID,
                    name: 'Calamex Plan Replanner',
                    instructions: systemPrompt,
                    model: createMastraModelConfig(modelConfig),
                    memory: agentMemory,
                    ...(hasTools ? { tools: mastraTools } : {}),
                    ...(workspace ? { workspace } : {}),
                    ...(browser ? { browser } : {}),
                });
                const prompt = [
                    '请基于验证结果生成最小 delta plan，返回 json object。',
                    `重新规划要求：${input.goal}`,
                    'originalPlanJson:',
                    JSON.stringify(record.plan, null, 2),
                    'workflowStateJson:',
                    JSON.stringify(workflow.state, null, 2),
                    'workflowEventsJson:',
                    JSON.stringify(workflowEvents.map((event) => event.event), null, 2),
                ].join('\n');
                const toolChoice: IMastraGenerateOptions['toolChoice'] =
                    hasTools || Boolean(workspace) || Boolean(browser) ? 'auto' : 'none';
                const generateOptions: IMastraGenerateOptions = {
                    maxSteps: hasTools || Boolean(workspace) || Boolean(browser) ? 8 : 1,
                    toolChoice,
                    structuredOutput: {
                        schema: agentPlanDeltaSchema,
                    },
                    memory,
                    ...(options.context?.signal ? { abortSignal: options.context.signal } : {}),
                    runId: requestedRunId,
                };
                const mastraMessages: TMastraChatMessage[] = [{ role: 'user', content: prompt }];
                const createRuntimeEvent = createRuntimeEventFactory({
                    runId: requestedRunId,
                    sessionId,
                    agentId: DEFAULT_REPLANNER_AGENT_ID,
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
                    maxSteps: generateOptions.maxSteps ?? 1,
                    toolChoice,
                })), options);
                const generated = await agent.generate(mastraMessages, generateOptions);
                const delta = parsePlanDelta(generated.object);

                if (!delta) {
                    return createErrorResponse(
                        sessionId,
                        'Replanner 没有返回有效 delta plan。',
                        events,
                        options,
                    );
                }

                const nextPlan = applyAgentPlanDelta(record.plan, delta);

                if (!nextPlan) {
                    return createErrorResponse(
                        sessionId,
                        'Replanner 生成的 delta plan 无法应用到当前计划。',
                        events,
                        options,
                    );
                }

                const nextRecord = await this.planStore.createPendingPlan({
                    planId: record.planId,
                    threadId: record.threadId,
                    userRequest: input.goal,
                    plan: nextPlan,
                });
                await this.planWorkflowStore.createForPlan({
                    record: nextRecord,
                    parentRunId: workflow.workflowRunId,
                    replanOfVersion: record.version,
                });
                await this.planWorkflowStore.issueReplan({
                    planId,
                    version: Number(planVersion),
                    toVersion: nextRecord.version,
                    delta,
                });

                pushUiEvent(events, {
                    type: 'tool_result',
                    toolName: 'plan_replanner',
                    output: toJsonValue({
                        fromVersion: record.version,
                        toVersion: nextRecord.version,
                        delta,
                    }),
                }, options);

                return createPlanResponse(sessionId, nextRecord, events, options);
            });
        } catch (error) {
            return createErrorResponse(
                sessionId,
                `Replanner 执行失败：${normalizeMastraError(error)}`,
                events,
                options,
            );
        } finally {
            evictDeepSeekReasoningByPrefix(createDeepSeekReasoningRunPrefix(sessionId, requestedRunId));
            await mcpBundle.disconnectAll();
            await destroyMastraWorkspace(workspace);
            await destroyMastraBrowser(browser);
        }
    }

    async execute(
        input: IAgentRuntimeInput,
        options: IAgentRuntimeRunOptions = {},
    ): Promise<IAgentRuntimeResponse> {
        const normalizedInput: IAgentRuntimeInput = {
            ...input,
            mode: 'agent',
        };
        const sessionId = normalizedInput.sessionId ?? createSessionId('mastra-execute');
        const events: TAgentRuntimeOutputEvent[] = [];
        const planId = toNonEmptyString(normalizedInput.planId);
        const planStepId = toNonEmptyString(normalizedInput.planStepId);
        const planVersion = normalizedInput.planVersion;
        const requestedRunId = options.context?.requestId ?? createSessionId('mastra-run');

        if (!planId || !planStepId || !Number.isInteger(planVersion) || Number(planVersion) <= 0) {
            return createErrorResponse(
                sessionId,
                'Agent 执行需要已批准计划的 planId、planVersion 和 planStepId。',
                events,
                options,
            );
        }

        let approvedPlanRecord: TAgentPlanRecord;
        try {
            const gate = await this.planStore.prepareExecution({
                planId,
                version: Number(planVersion),
                stepId: planStepId,
            });
            approvedPlanRecord = gate.record;
            await this.planWorkflowStore.createForPlan({ record: approvedPlanRecord });
            await this.planWorkflowStore.approvePlan(approvedPlanRecord);
            await this.planWorkflowStore.startStep({
                planId,
                version: Number(planVersion),
                stepId: planStepId,
                mastraRunId: requestedRunId,
            });
        } catch (error) {
            return createErrorResponse(
                sessionId,
                `Plan 执行门禁失败：${normalizeMastraError(error)}`,
                events,
                options,
            );
        }

        const memoryInput: IAgentRuntimeInput = {
            ...normalizedInput,
            threadId: normalizedInput.threadId ?? approvedPlanRecord.threadId,
        };

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
            toolStats,
            mcpGatewayMetrics,
            workspace,
            browser,
        } = await loadMastraMcpTools(
            this.mcpGatewayPool,
            normalizedInput.workspaceRootPath,
            this.loggerRef,
            normalizedInput.context ?? [],
            'write',
            memoryInput,
        );
        const hasAgentTools = hasTools || Boolean(workspace) || Boolean(browser);
        const memory = createMastraMemoryReference(createMastraMemoryScope(memoryInput, sessionId));
        const agentMemory = createMastraMemoryForModel(modelConfig);
        const createRequestedRunEvent = createRuntimeEventFactory({
            runId: requestedRunId,
            sessionId,
            agentId: DEFAULT_EXECUTION_AGENT_ID,
            ...(this.now ? { now: this.now } : {}),
        });
        const systemPrompt = [
            buildSystemPrompt(memoryInput, modelConfig.modelId),
            createApprovedPlanExecutionContext(approvedPlanRecord, planStepId),
        ].join('\n\n');
        const payloadEventSink = createDeepSeekPayloadEventSink(events, options);
        let shouldDisconnectBundle = true;
        let streamCleanup: (() => void) | undefined;

        try {
            return await runWithDeepSeekReasoningContext({
                sessionId,
                runId: requestedRunId,
                onRequestPayload: payloadEventSink.onRequestPayload,
            }, async () => {
                const toolChoice: IMastraGenerateOptions['toolChoice'] = hasAgentTools ? 'auto' : 'none';
                const executionHandle = await this.createExecutionHandle({
                    id: DEFAULT_EXECUTION_AGENT_ID,
                    name: DEFAULT_EXECUTION_AGENT_NAME,
                    instructions: systemPrompt,
                    model: createMastraModelConfig(modelConfig),
                    memory: agentMemory,
                    ...(hasTools ? { tools: mastraTools } : {}),
                    ...(workspace ? { workspace } : {}),
                    ...(browser ? { browser } : {}),
                });
                const stream = await executionHandle.agent.stream(
                    buildMastraMessages(memoryInput),
                    {
                        maxSteps: hasAgentTools ? 10 : 1,
                        toolChoice,
                        memory,
                        ...(options.context?.signal ? { abortSignal: options.context.signal } : {}),
                        runId: requestedRunId,
                        requestContext: createExecutionRequestContext(
                            memoryInput,
                            systemPrompt,
                            memory,
                            approvedPlanRecord,
                        ),
                    },
                );
                streamCleanup = stream.cleanup;
                const checkpointRunId = stream.runId ?? requestedRunId;
                const createCheckpointEvent = checkpointRunId === requestedRunId
                    ? createRequestedRunEvent
                    : createRuntimeEventFactory({
                        runId: checkpointRunId,
                        sessionId,
                        agentId: DEFAULT_EXECUTION_AGENT_ID,
                        ...(this.now ? { now: this.now } : {}),
                    });

                payloadEventSink.attachRuntimeEventFactory(createCheckpointEvent);
                attachMcpGatewayMetrics(mcpGatewayMetrics, console);
                pushUiEvent(events, createCheckpointEvent(createAcontextTokenEventDraft({
                    systemPrompt,
                    messages: buildMastraMessages(memoryInput),
                    contextReferences: normalizedInput.context ?? [],
                    tools: mastraTools,
                    toolStats,
                    workspaceEnabled: Boolean(workspace),
                    browserEnabled: Boolean(browser),
                    memoryEnabled: true,
                    maxSteps: hasAgentTools ? 10 : 1,
                    toolChoice,
                })), options);
                pushUiEvent(events, createCheckpointEvent({
                    type: 'rollback.checkpoint.created',
                    visibility: 'user',
                    level: 'info',
                    snapshotId: checkpointRunId,
                }), options);

                const streamSummary = await this.consumeTextStream(
                    executionHandle.agent,
                    mcpBundle,
                    sessionId,
                    stream,
                    events,
                    options,
                    createCheckpointEvent,
                    workspace,
                    browser,
                    {
                        planId,
                        version: Number(planVersion),
                        stepId: planStepId,
                    },
                );
                shouldDisconnectBundle = streamSummary.releaseResources;

                if (streamSummary.streamErrorMessage) {
                    await this.planWorkflowStore.failStep({
                        planId,
                        version: Number(planVersion),
                        stepId: planStepId,
                        error: streamSummary.streamErrorMessage,
                        retryable: true,
                    });
                    return createErrorResponse(
                        sessionId,
                        `Mastra Agent 执行失败：${streamSummary.streamErrorMessage}`,
                        events,
                        options,
                    );
                }

                if (streamSummary.pendingApproval) {
                    await this.planWorkflowStore.suspend({
                        planId,
                        version: Number(planVersion),
                        reason: 'tool_external_wait',
                        payload: {
                            stepId: planStepId,
                            runId: checkpointRunId,
                        },
                        allowedFields: ['decision', 'requestId'],
                    });
                    return {
                        sessionId,
                        events,
                        result: null,
                    };
                }

                const result = streamSummary.visibleText.trim().length > 0
                    ? streamSummary.visibleText
                    : 'Agent 已完成。';

                await this.planWorkflowStore.completeStep({
                    planId,
                    version: Number(planVersion),
                    stepId: planStepId,
                    resultRef: checkpointRunId,
                });

                pushUiEvent(events, createDoneOutputEvent(result, streamSummary.doneTokenSnapshot), options);

                return {
                    sessionId,
                    events,
                    result,
                };
            });
        } catch (error) {
            await this.planWorkflowStore.failStep({
                planId,
                version: Number(planVersion),
                stepId: planStepId,
                error: normalizeMastraError(error),
                retryable: true,
            }).catch(() => undefined);
            pushUiEvent(events, createRequestedRunEvent({
                type: 'rollback.checkpoint.failed',
                visibility: 'user',
                level: 'error',
                snapshotId: requestedRunId,
                errorMessage: normalizeMastraError(error),
            }), options);

            return createErrorResponse(
                sessionId,
                `Mastra Agent 执行失败：${normalizeMastraError(error)}`,
                events,
                options,
            );
        } finally {
            if (shouldDisconnectBundle) {
                evictDeepSeekReasoningByPrefix(createDeepSeekReasoningRunPrefix(sessionId, requestedRunId));
                streamCleanup?.();
                await mcpBundle.disconnectAll();
                await destroyMastraWorkspace(workspace);
                await destroyMastraBrowser(browser);
            }
        }
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
            await destroyMastraWorkspace(pending.workspace);
            await destroyMastraBrowser(pending.browser);
            return this.createFallbackApprovalResponse(input, sessionId, options);
        }

        const events: TAgentRuntimeOutputEvent[] = [];
        const payloadEventSink = createDeepSeekPayloadEventSink(events, options);
        let shouldDisconnectBundle = true;
        let streamCleanup: (() => void) | undefined;

        try {
            return await runWithDeepSeekReasoningContext({
                sessionId,
                runId: decodedRequest.runId,
                onRequestPayload: payloadEventSink.onRequestPayload,
            }, async () => {
                const stream = await continueStream({
                    runId: decodedRequest.runId,
                    toolCallId: decodedRequest.toolCallId,
                    ...(options.context?.signal ? { abortSignal: options.context.signal } : {}),
                });
                streamCleanup = stream.cleanup;
                const createRuntimeEvent = createRuntimeEventFactory({
                    runId: stream.runId ?? decodedRequest.runId,
                    sessionId,
                    agentId: DEFAULT_EXECUTION_AGENT_ID,
                    ...(this.now ? { now: this.now } : {}),
                });
                payloadEventSink.attachRuntimeEventFactory(createRuntimeEvent);
                const streamSummary = await this.consumeTextStream(
                    pending.agent,
                    pending.bundle,
                    sessionId,
                    stream,
                    events,
                    options,
                    createRuntimeEvent,
                    pending.workspace,
                    pending.browser,
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
            });
        } catch (error) {
            return createErrorResponse(
                sessionId,
                `Mastra Approval 执行失败：${normalizeMastraError(error)}`,
                events,
                options,
            );
        } finally {
            if (shouldDisconnectBundle) {
                evictDeepSeekReasoningByPrefix(
                    createDeepSeekReasoningRunPrefix(sessionId, decodedRequest.runId),
                );
                streamCleanup?.();
                await pending.bundle.disconnectAll();
                await destroyMastraWorkspace(pending.workspace);
                await destroyMastraBrowser(pending.browser);
            }
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
        const modelConfig = this.readModelConfig();

        if (!modelConfig) {
            return createErrorResponse(
                sessionId,
                'DeepSeek 未配置：请在 Node sidecar 环境设置 DEEPSEEK_API_KEY。',
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
