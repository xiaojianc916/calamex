import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Agent, type ToolsInput } from '@mastra/core/agent';
import { createDurableAgent, DurableStepIds } from '@mastra/core/agent/durable';
import type { MastraModelConfig } from '@mastra/core/llm';
import { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { toStandardSchema } from '@mastra/core/schema';
import type {
    TextDeltaPayload,
    ToolCallPayload,
} from '@mastra/core/stream';
import { createTool } from '@mastra/core/tools';
import {
    LocalFilesystem,
    LocalSandbox,
    Workspace,
    WORKSPACE_TOOLS,
    type AnyWorkspace,
    type LSPConfig,
    type WorkspaceToolsConfig,
} from '@mastra/core/workspace';
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
} from '../models/deepseek-reasoning-fetch.js';
import type { TJsonValue } from '../schemas/events.js';
import { agentPlanSchema, type TAgentPlan } from '../schemas/plan.js';
import { redactForStream } from '../streaming/stream-redaction.js';
import {
    createAgentRuntimeEvent,
    type IAgentRuntimeEventContext,
    type TAgentRuntimeEventDraft,
} from '../streaming/stream-types.js';
import {
    createMastraFileLogger,
    createMastraLoggerRef,
    createMastraLogTools,
    type IMastraLogToolsRef,
} from '../tools/log.js';
import { createMastraMcpClientBundle } from '../tools/mcp.js';
import { createMastraTimeTools } from '../tools/time.js';
import { buildSystemPrompt } from './agent-runtime-helpers.js';
import {
    createMastraMemoryReference,
    createMastraMemoryScope,
    resolveMastraStorageUrl,
} from './mastra-memory.js';
import { createAgentPlanStore, type IAgentPlanStore, type TAgentPlanRecord } from './plan-store.js';
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
const RUNTIME_TOOL_PREVIEW_CHARS = 1200;
const WORKSPACE_OPERATION_TIMEOUT_MS = 30_000;
const WORKSPACE_LSP_DIAGNOSTIC_TIMEOUT_MS = 5_000;
const WORKSPACE_LSP_INIT_TIMEOUT_MS = 15_000;
const SIDECAR_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const PROJECT_ROOT = resolve(SIDECAR_ROOT, '..');
const DEFAULT_ROLLBACK_STEP: TRollbackStepPath = [
    DurableStepIds.AGENTIC_EXECUTION,
    DurableStepIds.LLM_EXECUTION,
];

type TMastraRequestContextValues = Record<string, unknown>;
type TMastraRequestContext = RequestContext<TMastraRequestContextValues>;

type TMastraChatMessage = {
    role: 'user' | 'assistant';
    content: string;
};

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
    tools?: ToolsInput;
    workspace?: AnyWorkspace;
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
    createExecutionHandle?: (config: IMastraAgentConfig) => Promise<IMastraExecutionHandle>;
    createStorage?: () => IMastraStorageLike;
    loadExecutionSnapshot?: (
        workflowName: string,
        runId: string,
    ) => Promise<IMastraWorkflowSnapshotLike | null>;
    readModelConfig?: () => TDeepSeekModelConfig | null;
    createMcpClientBundle?: (
        options?: { workspaceRootPath?: string | null },
    ) => Promise<IMastraMcpBundle>;
    createPlanStore?: () => IAgentPlanStore;
    now?: () => string;
}

interface IMastraPendingApproval {
    agent: IMastraAgentLike;
    bundle: IMastraMcpBundle;
    runId: string;
    sessionId: string;
    toolCallId: string;
    workspace?: AnyWorkspace;
}

interface IMastraTextStreamSummary {
    pendingApproval: boolean;
    releaseResources: boolean;
    streamErrorMessage: string | null;
    visibleText: string;
}

type TRuntimeEventFactory = (draft: TAgentRuntimeEventDraft) => TAgentRuntimeOutputEvent;
type TMastraToolProfile = 'readonly' | 'write';

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

const extractMcpErrorMessage = (value: unknown): string | null => {
    const record = toRecord(value);

    if (record?.isError !== true) {
        return null;
    }

    const content = Array.isArray(record.content) ? record.content : [];
    const text = content
        .map((item) => toNonEmptyString(toRecord(item)?.text))
        .filter((item): item is string => Boolean(item))
        .join('\n')
        .trim();

    return text || 'MCP tool returned an error result.';
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

const createWorkspaceSearchPaths = (workspaceRoot: string): string[] => {
    const searchPaths = [workspaceRoot, SIDECAR_ROOT, PROJECT_ROOT, process.cwd()];
    const seen = new Set<string>();

    return searchPaths.flatMap((path) => {
        const resolvedPath = resolveWorkspaceDirectory(path);

        if (!resolvedPath || seen.has(resolvedPath)) {
            return [];
        }

        seen.add(resolvedPath);
        return [resolvedPath];
    });
};

const createWorkspaceLspConfig = (workspaceRoot: string): LSPConfig => ({
    root: workspaceRoot,
    diagnosticTimeout: WORKSPACE_LSP_DIAGNOSTIC_TIMEOUT_MS,
    initTimeout: WORKSPACE_LSP_INIT_TIMEOUT_MS,
    searchPaths: createWorkspaceSearchPaths(workspaceRoot),
});

const createWorkspaceToolsConfig = (profile: TMastraToolProfile): WorkspaceToolsConfig => ({
    enabled: false,
    requireApproval: false,
    [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: {
        enabled: true,
        name: 'view',
        maxOutputTokens: 6_000,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.GREP]: {
        enabled: true,
    },
    ...(profile === 'write' ? {
        [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: {
            enabled: true,
            name: 'string_replace_lsp',
            requireReadBeforeWrite: true,
        },
        [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
            enabled: true,
            name: 'write_file',
            requireReadBeforeWrite: true,
        },
        [WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT]: {
            enabled: true,
            requireReadBeforeWrite: true,
        },
    } : {}),
    [WORKSPACE_TOOLS.LSP.LSP_INSPECT]: {
        enabled: true,
    },
});

const createMastraWorkspace = (
    workspaceRootPath?: string | null,
    profile: TMastraToolProfile = 'write',
): AnyWorkspace | undefined => {
    const workspaceRoot = resolveWorkspaceDirectory(workspaceRootPath);

    if (!workspaceRoot) {
        return undefined;
    }

    const workspaceId = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 24);

    return new Workspace({
        id: `sidecar-${workspaceId}`,
        name: 'Xiaojianc Agent Workspace',
        filesystem: new LocalFilesystem({
            basePath: workspaceRoot,
            contained: true,
        }),
        sandbox: new LocalSandbox({
            workingDirectory: workspaceRoot,
            timeout: WORKSPACE_OPERATION_TIMEOUT_MS,
        }),
        lsp: createWorkspaceLspConfig(workspaceRoot),
        tools: createWorkspaceToolsConfig(profile),
        operationTimeout: WORKSPACE_OPERATION_TIMEOUT_MS,
    });
};

const destroyMastraWorkspace = async (workspace: AnyWorkspace | undefined): Promise<void> => {
    if (!workspace || workspace.status === 'destroyed') {
        return;
    }

    await workspace.destroy().catch(() => undefined);
};

const createMastraModelConfig = (
    model: TDeepSeekModelConfig,
): MastraModelConfig => model;

const defaultCreateAgent = (config: IMastraAgentConfig): IMastraAgentLike => {
    const agent = new Agent({
        id: config.id,
        name: config.name,
        instructions: config.instructions,
        model: config.model,
        ...(config.tools ? { tools: config.tools } : {}),
        ...(config.workspace ? { workspace: config.workspace } : {}),
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
        ...(config.tools ? { tools: config.tools } : {}),
        ...(config.workspace ? { workspace: config.workspace } : {}),
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
                    ...(options?.requestContext ? { requestContext: options.requestContext } : {}),
                });

                return {
                    fullStream: streamResult.fullStream as unknown as AsyncIterable<unknown>,
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
                    fullStream: streamResult.fullStream as unknown as AsyncIterable<unknown>,
                    runId: streamResult.runId,
                    cleanup: streamResult.cleanup,
                };
            },
            declineToolCall: async ({ runId }) => {
                const streamResult = await registeredAgent.resume(runId, { approved: false });

                return {
                    fullStream: streamResult.fullStream as unknown as AsyncIterable<unknown>,
                    runId: streamResult.runId,
                    cleanup: streamResult.cleanup,
                };
            },
        },
        workflow: registeredAgent.getWorkflow(),
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

            const result = await client.callTool(tool, toJsonValue(inputData));
            const errorMessage = extractMcpErrorMessage(result);

            if (errorMessage) {
                throw new Error(errorMessage);
            }

            return toJsonValue(result);
        },
    })]),
);

const FILESYSTEM_MCP_TOOL_NAMES = new Set([
    'read_file',
    'read_text_file',
    'read_media_file',
    'read_multiple_files',
    'write_file',
    'edit_file',
    'create_directory',
    'list_directory',
    'list_directory_with_sizes',
    'directory_tree',
    'move_file',
    'search_files',
    'get_file_info',
    'list_allowed_directories',
]);

const READONLY_MCP_TOOL_DENY_PATTERN =
    /(?:^|[_-])(write|edit|create|move|delete|remove|run|exec|execute|shell|install|apply|commit|checkout|reset|add|stage|unstage|discard|drop|push|pull|merge|rebase|stash|upload|send|post|put|patch|update|insert|replace)(?:$|[_-])/iu;

const filterMcpToolsForWorkspace = (
    tools: readonly IMcpToolLike[],
    workspace: AnyWorkspace | undefined,
): IMcpToolLike[] => {
    if (!workspace) {
        return [...tools];
    }

    return tools.filter((tool) => !FILESYSTEM_MCP_TOOL_NAMES.has(tool.name));
};

const filterMcpToolsForProfile = (
    tools: readonly IMcpToolLike[],
    profile: TMastraToolProfile,
): IMcpToolLike[] => {
    if (profile === 'write') {
        return [...tools];
    }

    return tools.filter((tool) => !READONLY_MCP_TOOL_DENY_PATTERN.test(tool.name));
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
            description: 'Read the current editor file only when the user asks about the current file. Takes no arguments.',
            inputSchema: z.object({}).passthrough(),
            execute: async () => ({
                path: currentFile.path,
                label: currentFile.label,
                range: currentFile.range,
                redacted: currentFile.redacted,
                content: currentFile.contentPreview,
            }),
        }),
    };
};

const loadMastraMcpTools = async (
    createBundle: (
        options?: { workspaceRootPath?: string | null },
    ) => Promise<IMastraMcpBundle>,
    workspaceRootPath?: string,
    loggerRef?: IMastraLogToolsRef,
    contextReferences: readonly IAgentContextReferenceInput[] = [],
    profile: TMastraToolProfile = 'write',
): Promise<{
    bundle: IMastraMcpBundle;
    tools: ToolsInput;
    hasTools: boolean;
    workspace: AnyWorkspace | undefined;
}> => {
    const bundle = await createBundle(workspaceRootPath
        ? { workspaceRootPath }
        : {});
    const workspace = createMastraWorkspace(workspaceRootPath, profile);
    const mcpTools = filterMcpToolsForProfile(
        filterMcpToolsForWorkspace(bundle.tools, workspace),
        profile,
    );
    const tools: ToolsInput = {
        ...createMastraMcpTools(mcpTools),
        ...createUiContextTools(contextReferences),
        ...createMastraTimeTools(),
        ...(loggerRef ? createMastraLogTools(loggerRef) : {}),
    };

    return {
        bundle,
        tools,
        hasTools: Object.keys(tools).length > 0,
        workspace,
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

const getStringField = (
    record: Record<string, unknown> | null,
    fields: readonly string[],
): string | null => {
    if (!record) {
        return null;
    }

    for (const field of fields) {
        const value = record[field];
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }

    return null;
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

const getReasoningDelta = (chunk: unknown): string | null => {
    const record = toRecord(chunk);
    const chunkType = getStringField(record, ['type']);
    const reasoningFields = [
        'textDelta',
        'text',
        'delta',
        'reasoning',
        'reasoning_content',
        'reasoningContent',
    ] as const;

    if (
        chunkType !== 'reasoning'
        && chunkType !== 'reasoning-delta'
        && chunkType !== 'reasoning_delta'
    ) {
        return null;
    }

    return getStringField(record, reasoningFields)
        ?? getStringField(toRecord(record?.payload), reasoningFields)
        ?? getStringField(toRecord(record?.delta), reasoningFields);
};

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
): chunk is { type: 'tool-result'; payload: { toolName: string; toolCallId?: string; result: unknown } } => {
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
    private readonly createAgent: (config: IMastraAgentConfig) => IMastraAgentLike;

    private readonly createExecutionHandle: (config: IMastraAgentConfig) => Promise<IMastraExecutionHandle>;

    private readonly loadExecutionSnapshot: (
        workflowName: string,
        runId: string,
    ) => Promise<IMastraWorkflowSnapshotLike | null>;

    private readonly readModelConfig: () => TDeepSeekModelConfig | null;

    private readonly createMcpClientBundle: (
        options?: { workspaceRootPath?: string | null },
    ) => Promise<IMastraMcpBundle>;

    private readonly now: (() => string) | undefined;

    private readonly storage: IMastraStorageLike;

    private readonly planStore: IAgentPlanStore;

    private readonly loggerRef: IMastraLogToolsRef;

    private readonly pendingApprovals = new Map<string, IMastraPendingApproval>();

    readonly name = 'mastra';

    constructor(deps: IMastraRuntimeDeps = {}) {
        this.createAgent = deps.createAgent ?? defaultCreateAgent;
        this.storage = deps.createStorage ? deps.createStorage() : defaultCreateStorage();
        this.planStore = deps.createPlanStore ? deps.createPlanStore() : createAgentPlanStore();
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
        this.now = deps.now;
    }

    private registerPendingApproval(
        sessionId: string,
        agent: IMastraAgentLike,
        bundle: IMastraMcpBundle,
        chunk: { type: 'tool-call-approval'; payload: ToolCallPayload },
        workspace?: AnyWorkspace,
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
    ): Promise<IMastraTextStreamSummary> {
        let visibleText = '';
        let emittedVisibleText = '';
        let streamErrorMessage: string | null = null;
        let pendingApproval = false;
        let releaseResources = true;
        const pendingToolCallIdsByName = new Map<string, string[]>();

        for await (const chunk of stream.fullStream) {
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

            if (isChunkWithType(chunk, 'tool-call-approval') && isToolCallChunk(chunk)) {
                pendingApproval = true;
                const pendingRequestId = this.registerPendingApproval(
                    sessionId,
                    agent,
                    bundle,
                    chunk,
                    workspace,
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
            workspace,
        } = await loadMastraMcpTools(
            this.createMcpClientBundle,
            normalizedInput.workspaceRootPath,
            this.loggerRef,
            normalizedInput.context ?? [],
        );
        const hasAgentTools = hasTools || Boolean(workspace);
        const requestedRunId = options.context?.requestId ?? createSessionId(`${sessionPrefix}-run`);
        const memory = createMastraMemoryReference(createMastraMemoryScope(normalizedInput, sessionId));
        let shouldDisconnectBundle = true;

        try {
            return await runWithDeepSeekReasoningContext({ sessionId, runId: requestedRunId }, async () => {
                const agent = this.createAgent({
                    id: 'calamex-agent-sidecar',
                    name: 'Calamex Agent Sidecar',
                    instructions: buildSystemPrompt(normalizedInput, modelConfig.modelId),
                    model: createMastraModelConfig(modelConfig),
                    ...(hasTools ? { tools: mastraTools } : {}),
                    ...(workspace ? { workspace } : {}),
                });
                const toolChoice: IMastraGenerateOptions['toolChoice'] = hasAgentTools ? 'auto' : 'none';
                const streamOptions: IMastraGenerateOptions = {
                    maxSteps: hasAgentTools ? 10 : 1,
                    toolChoice,
                    memory,
                    ...(options.context?.signal ? { abortSignal: options.context.signal } : {}),
                    ...(options.context?.requestId ? { runId: requestedRunId } : {}),
                };
                const stream = await agent.stream(buildMastraMessages(normalizedInput), {
                    ...streamOptions,
                });
                const createRuntimeEvent = createRuntimeEventFactory({
                    runId: stream.runId ?? requestedRunId,
                    sessionId,
                    agentId: DEFAULT_EXECUTION_AGENT_ID,
                    ...(this.now ? { now: this.now } : {}),
                });
                const streamSummary = await this.consumeTextStream(
                    agent,
                    mcpBundle,
                    sessionId,
                    stream,
                    events,
                    options,
                    createRuntimeEvent,
                    workspace,
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
            workspace,
        } = await loadMastraMcpTools(
            this.createMcpClientBundle,
            input.workspaceRootPath,
            this.loggerRef,
            input.context ?? [],
            'readonly',
        );
        const hasAgentTools = hasTools || Boolean(workspace);
        const requestedRunId = options.context?.requestId ?? createSessionId('mastra-plan-run');
        const memory = createMastraMemoryReference(createMastraMemoryScope(input, sessionId));

        try {
            return await runWithDeepSeekReasoningContext({ sessionId, runId: requestedRunId }, async () => {
                const agent = this.createAgent({
                    id: 'calamex-agent-sidecar-plan',
                    name: 'Calamex Agent Plan Sidecar',
                    instructions: buildSystemPrompt({
                        ...input,
                        mode: 'plan',
                    }, modelConfig.modelId),
                    model: createMastraModelConfig(modelConfig),
                    ...(hasTools ? { tools: mastraTools } : {}),
                    ...(workspace ? { workspace } : {}),
                });
                const toolChoice: IMastraGenerateOptions['toolChoice'] = hasAgentTools ? 'auto' : 'none';
                const generateOptions: IMastraGenerateOptions = {
                    maxSteps: hasAgentTools ? 10 : 1,
                    toolChoice,
                    structuredOutput: {
                        schema: agentPlanSchema,
                    },
                    memory,
                    ...(options.context?.signal ? { abortSignal: options.context.signal } : {}),
                    runId: requestedRunId,
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

                const record = await this.planStore.createPendingPlan({
                    ...(input.planId ? { planId: input.planId } : {}),
                    threadId: input.threadId ?? sessionId,
                    userRequest: input.goal,
                    plan: parsedPlan.data,
                });

                return createPlanResponse(sessionId, record, [], options);
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
        }
    }

    async approvePlan(
        input: IPlanApprovalInput,
        options: IAgentRuntimeRunOptions = {},
    ): Promise<IAgentRuntimeResponse> {
        const sessionId = input.sessionId ?? createSessionId('mastra-plan-approve');

        try {
            const record = await this.planStore.approvePlan(input);
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
        } catch (error) {
            return createErrorResponse(
                sessionId,
                `Plan 执行门禁失败：${normalizeMastraError(error)}`,
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

        const {
            bundle: mcpBundle,
            tools: mastraTools,
            hasTools,
            workspace,
        } = await loadMastraMcpTools(
            this.createMcpClientBundle,
            normalizedInput.workspaceRootPath,
            this.loggerRef,
            normalizedInput.context ?? [],
        );
        const hasAgentTools = hasTools || Boolean(workspace);
        const requestedRunId = options.context?.requestId ?? createSessionId('mastra-run');
        const memory = createMastraMemoryReference(createMastraMemoryScope(normalizedInput, sessionId));
        const createRequestedRunEvent = createRuntimeEventFactory({
            runId: requestedRunId,
            sessionId,
            agentId: DEFAULT_EXECUTION_AGENT_ID,
            ...(this.now ? { now: this.now } : {}),
        });
        const systemPrompt = [
            buildSystemPrompt(normalizedInput, modelConfig.modelId),
            createApprovedPlanExecutionContext(approvedPlanRecord, planStepId),
        ].join('\n\n');
        let shouldDisconnectBundle = true;
        let streamCleanup: (() => void) | undefined;

        try {
            return await runWithDeepSeekReasoningContext({ sessionId, runId: requestedRunId }, async () => {
                const toolChoice: IMastraGenerateOptions['toolChoice'] = hasAgentTools ? 'auto' : 'none';
                const executionHandle = await this.createExecutionHandle({
                    id: DEFAULT_EXECUTION_AGENT_ID,
                    name: DEFAULT_EXECUTION_AGENT_NAME,
                    instructions: systemPrompt,
                    model: createMastraModelConfig(modelConfig),
                    ...(hasTools ? { tools: mastraTools } : {}),
                    ...(workspace ? { workspace } : {}),
                });
                const stream = await executionHandle.agent.stream(
                    buildMastraMessages(normalizedInput),
                    {
                        maxSteps: hasAgentTools ? 10 : 1,
                        toolChoice,
                        memory,
                        ...(options.context?.signal ? { abortSignal: options.context.signal } : {}),
                        runId: requestedRunId,
                        requestContext: createExecutionRequestContext(
                            normalizedInput,
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
            return this.createFallbackApprovalResponse(input, sessionId, options);
        }

        const events: TAgentRuntimeOutputEvent[] = [];
        let shouldDisconnectBundle = true;
        let streamCleanup: (() => void) | undefined;

        try {
            return await runWithDeepSeekReasoningContext({ sessionId, runId: decodedRequest.runId }, async () => {
                const stream = await continueStream({
                    runId: decodedRequest.runId,
                    toolCallId: decodedRequest.toolCallId,
                    ...(options.context?.signal ? { abortSignal: options.context.signal } : {}),
                });
                streamCleanup = stream.cleanup;
                const streamSummary = await this.consumeTextStream(
                    pending.agent,
                    pending.bundle,
                    sessionId,
                    stream,
                    events,
                    options,
                    createRuntimeEventFactory({
                        runId: stream.runId ?? decodedRequest.runId,
                        sessionId,
                        agentId: DEFAULT_EXECUTION_AGENT_ID,
                        ...(this.now ? { now: this.now } : {}),
                    }),
                    pending.workspace,
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
            } = await loadMastraMcpTools(this.createMcpClientBundle, workspaceRootPath, this.loggerRef);

            try {
                const executionHandle = await this.createExecutionHandle({
                    id: DEFAULT_EXECUTION_AGENT_ID,
                    name: DEFAULT_EXECUTION_AGENT_NAME,
                    instructions: systemPrompt,
                    model: createMastraModelConfig(modelConfig),
                    ...(hasTools ? { tools: mastraTools } : {}),
                    ...(workspace ? { workspace } : {}),
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
