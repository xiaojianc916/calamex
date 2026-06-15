import { DurableStepIds } from '@mastra/core/agent/durable';
import type { ToolsInput } from '@mastra/core/agent';
import type { MastraBrowser } from '@mastra/core/browser';
import type { MastraModelConfig } from '@mastra/core/llm';
import type { InputProcessorOrWorkflow, OutputProcessorOrWorkflow } from '@mastra/core/processors';
import { RequestContext } from '@mastra/core/request-context';
import type { AgentChunkType, DataChunkType, DynamicToolResultPayload, ReasoningDeltaPayload, ToolResultPayload } from '@mastra/core/stream';
import { WORKSPACE_TOOLS, type AnyWorkspace } from '@mastra/core/workspace';
import type { IMastraResolvedModelConfig } from '../models/config.js';
import type { TAgentRuntimeEventDraft } from '../streaming/stream-types.js';
import type { IMcpGatewayBundle, TMcpGatewayToolProfile } from '../tools/mcp-gateway.js';
import type { TMcpServerName } from '../tools/mcp.js';
import type { createMastraAgentMemory } from './context/memory.js';
import type { IAgentPlanStore, TAgentPlanRecord } from './plan/plan-store.js';
import type { IAgentPlanWorkflowStore } from './plan/plan-workflow-store.js';
import type { IAgentTokenUsageSnapshot, TAgentRuntimeOutputEvent } from './contracts/runtime-contracts.js';
import type { TRollbackStepPath } from './contracts/runtime-input.js';
import type { TAskUserResult } from './tools/ask-user.js';

export const DEFAULT_MASTRA_LOG_FILE = './.agent-sidecar/mastra.log';
export const DEFAULT_EXECUTION_AGENT_ID = 'calamex-agent-sidecar';
export const DEFAULT_EXECUTION_AGENT_NAME = 'Calamex Agent Sidecar';
export const DEFAULT_VALIDATOR_AGENT_ID = 'calamex-agent-sidecar-validator';
export const DEFAULT_REPLANNER_AGENT_ID = 'calamex-agent-sidecar-replanner';
export const RUNTIME_TOOL_PREVIEW_CHARS = 1200;
export const CURRENT_FILE_TOOL_CONTENT_MAX_CHARS = 2_000;
export const CURRENT_FILE_TOOL_MODEL_OUTPUT_MAX_CHARS = 2_600;
export const EXPLICIT_CONTEXT_MESSAGE_LIMIT = 12;
export const TOOL_PREVIEW_REDACTED_TEXT = '[工具参数已收敛显示]';
export const MAX_CONSECUTIVE_SIMILAR_TOOL_ERRORS = 3;
export const MASTRA_GUARDRAIL_MODEL = 'openrouter/openai/gpt-oss-safeguard-20b';
export const MASTRA_WORKSPACE_REDACTED_PREVIEW_TOOL_NAMES = new Set<string>([
    WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
    WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
    WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT,
    WORKSPACE_TOOLS.FILESYSTEM.DELETE,
    WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
]);
export const WINDOWS_POWERSHELL_RELATIVE_PATH = 'System32\\WindowsPowerShell\\v1.0\\powershell.exe';
export const WINDOWS_POWERSHELL_CORE_RELATIVE_PATH = 'PowerShell\\7\\pwsh.exe';
export const DEFAULT_ROLLBACK_STEP: TRollbackStepPath = [
    DurableStepIds.AGENTIC_EXECUTION,
    DurableStepIds.LLM_EXECUTION,
];
export type TMastraRequestContextValues = Record<string, unknown>;
export type TMastraRequestContext = RequestContext<TMastraRequestContextValues>;
export type IMcpGatewayMetricLogger = {
    info(data: object, msg?: string): void;
    warn(data: object, msg?: string): void;
};
export type TMastraTextPart = {
    type: 'text';
    text: string;
};
export type TMastraImagePart = {
    type: 'image';
    image: string | URL;
    mediaType?: string;
};
export type TMastraFilePart = {
    type: 'file';
    data: string | URL;
    mediaType: string;
    filename?: string;
};
export type TMastraUserContent = string | Array<TMastraTextPart | TMastraImagePart | TMastraFilePart>;
export type TMastraChatMessage =
    | {
        role: 'user';
        content: TMastraUserContent;
    }
    | {
        role: 'assistant';
        content: string;
    };

export type TMastraAgentChunk = AgentChunkType<undefined>;
export type TMastraStreamChunk = TMastraAgentChunk | DataChunkType;
export type TMastraTextDeltaChunk = Extract<TMastraAgentChunk, { type: 'text-delta' }>;
export type TMastraReasoningDeltaChunk = Extract<TMastraAgentChunk, { type: 'reasoning-delta' }>;
export type TMastraToolCallApprovalChunk = Extract<TMastraAgentChunk, { type: 'tool-call-approval' }>;
export type TMastraToolCallSuspendedChunk = Extract<TMastraAgentChunk, { type: 'tool-call-suspended' }>;
export type TMastraToolErrorChunk = Extract<TMastraAgentChunk, { type: 'tool-error' }>;
export type TMastraErrorChunk = Extract<TMastraAgentChunk, { type: 'error' }>;
export type TMastraFinishChunk = Extract<TMastraAgentChunk, { type: 'finish' }>;
/**
 * 工具级 suspend 的恢复负载。审批类工具走 `{ approved }`（approve/decline 二元裁决）；
 * ask_user 反向提问走 {@link TAskUserResult}（outcome + 结构化 answers，即 ask_user 工具
 * resumeSchema 的形状）。二者结构互斥，resumeStream 据实际传入的成员分发；新增成员时此处
 * 扩展联合即可，调用方按结构匹配（见 approval-client/client.ts 的 resolveApproval / resolveAskUser）。
 */
export type TMastraToolResumeData = { approved: boolean } | TAskUserResult;
export type TOmDataChunk = DataChunkType & {
    type: 'data-om-activation' | 'data-om-observation-end';
};
export type TSandboxDataChunk = DataChunkType & {
    type: 'data-sandbox-command' | 'data-sandbox-stdout' | 'data-sandbox-stderr' | 'data-sandbox-exit';
    data: {
        toolCallId?: string;
        command?: string;
        output?: string;
        exitCode?: number;
        success?: boolean;
        executionTimeMs?: number;
        killed?: boolean;
        pid?: string;
    };
};
export type TCompatibleReasoningDeltaChunk = TMastraReasoningDeltaChunk & {
    payload: ReasoningDeltaPayload & {
        reasoning?: string;
        delta?: string;
        reasoning_content?: string;
        reasoningContent?: string;
    };
};
export type TCompatibleToolResultPayload = ToolResultPayload | DynamicToolResultPayload;

export interface IMastraAgentStreamLike {
    fullStream: AsyncIterable<unknown>;
    runId?: string;
    /**
     * Mastra 官方 trace id（来自 `agent.stream()` 返回值）。
     * 仅在 Mastra 提供时存在；透传给运行时事件供前端深链 observability。
     */
    traceId?: string;
    /**
     * 结构化输出的承诺式访问入口，对应 Mastra `MastraModelOutput.object`
     * （由 `agent.stream()` 返回）：仅当传入 `structuredOutput.schema` 时有意义，解析为
     * 符合该 schema 的对象；未配置 schema 时为 undefined。须在 `fullStream` 消费完成后再
     * await（计划模式据此取最终计划对象，见 plan.ts），与官方“先消费流、再读 promise
     * 属性”的用法一致。
     */
    object?: Promise<unknown>;
    cleanup?: () => void;
}

export interface IMastraApprovalOptions {
    runId: string;
    toolCallId?: string;
    abortSignal?: AbortSignal | undefined;
}

export interface IMastraGenerateOptions {
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

export interface IMastraGenerateResultLike {
    object?: unknown;
    text?: string;
}

export interface IMastraAgentLike {
    stream(
        messages: TMastraChatMessage[],
        options?: IMastraGenerateOptions,
    ): Promise<IMastraAgentStreamLike>;
    generate(
        messages: TMastraChatMessage[],
        options?: IMastraGenerateOptions,
    ): Promise<IMastraGenerateResultLike>;
    resumeStream?: (
        resumeData: TMastraToolResumeData,
        options: IMastraApprovalOptions,
    ) => Promise<IMastraAgentStreamLike>;
    approveToolCall?: (options: IMastraApprovalOptions) => Promise<IMastraAgentStreamLike>;
    declineToolCall?: (options: IMastraApprovalOptions) => Promise<IMastraAgentStreamLike>;
}

export interface IMastraRegisteredAgentLike {
    stream(
        messages: TMastraChatMessage[],
        options?: IMastraGenerateOptions,
    ): Promise<{
        fullStream: AsyncIterable<unknown>;
        runId?: string;
        cleanup?: () => void;
    }>;
    generate(
        messages: TMastraChatMessage[],
        options?: IMastraGenerateOptions,
    ): Promise<IMastraGenerateResultLike>;
    resumeStream(
        resumeData: TMastraToolResumeData,
        options: IMastraApprovalOptions,
    ): Promise<{
        fullStream: AsyncIterable<unknown>;
        runId?: string;
        cleanup?: () => void;
    }>;
    approveToolCall(options: IMastraApprovalOptions): Promise<{
        fullStream: AsyncIterable<unknown>;
        runId?: string;
        cleanup?: () => void;
    }>;
    declineToolCall(options: IMastraApprovalOptions): Promise<{
        fullStream: AsyncIterable<unknown>;
        runId?: string;
        cleanup?: () => void;
    }>;
}

export interface IMastraWorkflowRunLike {
    timeTravel(options: {
        step: TRollbackStepPath;
        requestContext?: TMastraRequestContext;
        resumeData?: unknown;
    }): Promise<unknown>;
}

export interface IMastraWorkflowLike {
    id: string;
    createRun(options?: { runId?: string }): Promise<IMastraWorkflowRunLike>;
}

export interface IMastraExecutionHandle {
    agent: IMastraAgentLike;
    workflow: IMastraWorkflowLike;
}

export interface IMastraResumableAgentHandle {
    agent: IMastraAgentLike;
}

export interface IMastraWorkflowSnapshotLike {
    requestContext?: unknown;
    status?: string;
}

export interface IMastraWorkflowStoreLike {
    loadWorkflowSnapshot(options: {
        workflowName: string;
        runId: string;
    }): Promise<IMastraWorkflowSnapshotLike | null>;
}

export interface IMastraStorageLike {
    getStore(domain: 'workflows'): Promise<IMastraWorkflowStoreLike | null | undefined>;
}

export interface IMastraAgentConfig {
    id: string;
    name: string;
    instructions: string;
    model: MastraModelConfig;
    memory?: ReturnType<typeof createMastraAgentMemory>;
    tools?: ToolsInput;
    workspace?: AnyWorkspace;
    browser?: MastraBrowser;
    inputProcessors?: InputProcessorOrWorkflow[];
    outputProcessors?: OutputProcessorOrWorkflow[];
}

export type IMastraMcpBundle = IMcpGatewayBundle;

export interface IMastraRuntimeDeps {
    createAgent?: (config: IMastraAgentConfig) => IMastraAgentLike;
    createResumableAgentHandle?: (config: IMastraAgentConfig) => Promise<IMastraResumableAgentHandle>;
    createExecutionHandle?: (config: IMastraAgentConfig) => Promise<IMastraExecutionHandle>;
    createStorage?: () => IMastraStorageLike;
    loadExecutionSnapshot?: (
        workflowName: string,
        runId: string,
    ) => Promise<IMastraWorkflowSnapshotLike | null>;
    readModelConfig?: () => IMastraResolvedModelConfig | null;
    createMcpClientBundle?: (
        options?: { workspaceRootPath?: string | null; serverNames?: readonly TMcpServerName[] },
    ) => Promise<IMastraMcpBundle>;
    createPlanStore?: () => IAgentPlanStore;
    createPlanWorkflowStore?: () => IAgentPlanWorkflowStore;
    now?: () => string;
}

export interface IMastraPendingApproval {
    agent: IMastraAgentLike;
    bundle: IMastraMcpBundle;
    runId: string;
    sessionId: string;
    toolCallId: string;
    kind: 'approval' | 'suspended';
    approvedPath?: string | undefined;
    workspace?: AnyWorkspace;
    browser?: MastraBrowser;
}

export interface IMastraApprovalExecutionContext {
    pending: IMastraPendingApproval;
    systemPrompt: string;
    memory?: { thread: string; resource: string } | undefined;
    approvedPlanRecord?: TAgentPlanRecord | undefined;
}

export interface IMastraTextStreamSummary {
    pendingApproval: boolean;
    releaseResources: boolean;
    streamErrorMessage: string | null;
    visibleText: string;
    doneTokenSnapshot?: TDoneTokenSnapshot;
}

/**
 * 模型流抵达 `finish` chunk 时聚合得到的 token 用量快照。
 *
 * 它是规范类型 {@link IAgentTokenUsageSnapshot} 的别名：运行时从 `finish` chunk
 * 累积（见 `aggregateDoneTokenSnapshot`），并承载于 {@link IAgentRuntimeResponse.usage}，
 * 由 ACP egress 层据此投影出 `session/update` 的 `usage_update` 通知。它不再与任何
 * UI 事件变体耦合。
 */
export type TDoneTokenSnapshot = IAgentTokenUsageSnapshot;

export interface IPlanWorkflowStepTracker {
    planId: string;
    version: number;
    stepId: string;
}

export type TRuntimeEventFactory = (draft: TAgentRuntimeEventDraft) => TAgentRuntimeOutputEvent;
export type TOmMemoryCompressedEventDraft = Extract<TAgentRuntimeEventDraft, {
    type: 'acontext.memory.compressed';
}>;
export type TAcontextTokenEventDraft = Extract<TAgentRuntimeEventDraft, {
    type: 'acontext.token.checked';
}>;
export type TMastraToolProfile = TMcpGatewayToolProfile;

export interface IMastraToolLoadPlan {
    workspaceEnabled: boolean;
    browserEnabled: boolean;
    strategy: string;
}

export interface IMastraTextModeExecutionPlan {
    useTools: boolean;
    useMemory: boolean;
}

export interface IMastraToolBudgetStats {
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

export interface IMastraExecutableToolLike {
    execute: (inputData: unknown) => Promise<unknown> | unknown;
}

export interface IMastraDurableAgentLike {
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
