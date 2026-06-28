import type { z } from 'zod';

import type { IAiContextReference, IAiImageAttachmentPreview } from '@/types/ai/context';
import type { IAiAgentPatchSummary } from '@/types/ai/patch';
import type {
  aiAgentConfirmationStateSchema,
  aiApplyPatchMetadataSchema,
  aiChatMessageActionSchema,
  aiChatMessageSchema,
  aiChatMessageStreamSnapshotSchema,
  aiChatMessageToolCallSchema,
  aiChatRequestSchema,
  aiChatStreamPayloadSchema,
  aiConfigPayloadSchema,
  aiConversationTitlePayloadSchema,
  aiConversationTitleRequestSchema,
  aiCredentialStatusPayloadSchema,
  aiLanguageModelUsageSchema,
  aiModelEndpointConfigPayloadSchema,
  aiPatchSetSchema,
  aiProviderConnectionPayloadSchema,
  aiProviderConnectionRequestSchema,
  aiProviderTestPayloadSchema,
  aiSaveCredentialsRequestSchema,
  aiSuggestionPoolPayloadSchema,
  aiSuggestionPoolRequestSchema,
} from '@/types/ai/schema';
import type { IAiThreadAssistantChunk, IAiThreadToolCall } from '@/types/ai/thread';

/* ============================================================================
 * Plain enums / unions (no schema needed — primitive literal unions)
 * ========================================================================== */

export type TAiProviderType = 'mastra';
export type TAiModelRole = 'main' | 'narrator';
export type TAiStatus = 'idle' | 'generating' | 'streaming' | 'error';
export type TAiChatRole = 'user' | 'assistant' | 'system' | 'tool';

/* ============================================================================
 * Re-exports from sibling type files
 * ========================================================================== */

export type {
  IAiAgentClassifyTaskPayload,
  IAiAgentClassifyTaskRequest,
  IAiAgentListRunsPayload,
  IAiAgentNetworkPermissionPayload,
  IAiAgentPermissionState,
  IAiAgentPlanMetadata,
  IAiAgentPlanReference,
  IAiAgentPlanVersionSummary,
  IAiAgentResolveToolConfirmationRequest,
  IAiAgentRun,
  IAiAgentRunIdRequest,
  IAiAgentRunPayload,
  IAiAgentRunPlanRequest,
  IAiAgentRunStepRequest,
  IAiAgentSetNetworkPermissionRequest,
  IAiAgentStepDetail,
  IAiAgentStepFinalAnswer,
  IAiAgentStepToolResultSummary,
  IAiAgentStepWebSourceSummary,
  IAiAgentTimelineItem,
  IAiTaskPlanStep,
  IAiToolConfirmationOption,
  IAiToolConfirmationRequest,
  TAiAgentNetworkPermission,
  TAiAgentPlanRiskLevel,
  TAiAgentPlanStepKind,
  TAiAgentPlanStepStatus,
  TAiAgentRunStatus,
  TAiAgentTaskClassification,
  TAiAgentTimelineItemStatus,
  TAiAgentTimelineItemType,
  TAiToolConfirmationDecision,
  TAiToolConfirmationOptionId,
  TAiToolConfirmationOptionTone,
} from '@/types/ai/agent';

/**
 * Runtime const arrays backing the agent literal-union types above.
 *
 * 这些必须用 **值** 形式 re-export(不能并入上面的 `export type` 块),
 * 否则 `as const` 数组会在构建期被擦除,运行期 `import { AI_* } from '@/types/ai'`
 * 直接抛 "does not provide an export named ..."。barrel 作为唯一公共入口,
 * 需同时承载类型与其背后的值。
 */
export {
  AI_AGENT_NETWORK_PERMISSIONS,
  AI_AGENT_PERMISSION_SCOPES,
  AI_AGENT_PLAN_REFERENCE_TYPES,
  AI_AGENT_PLAN_RISK_LEVELS,
  AI_AGENT_PLAN_STEP_KINDS,
  AI_AGENT_PLAN_STEP_STATUSES,
  AI_AGENT_RUN_STATUSES,
  AI_AGENT_TASK_CLASSIFICATIONS,
  AI_AGENT_TIMELINE_ITEM_STATUSES,
  AI_AGENT_TIMELINE_ITEM_TYPES,
  AI_TOOL_CONFIRMATION_DECISIONS,
  AI_TOOL_CONFIRMATION_OPTION_IDS,
  AI_TOOL_CONFIRMATION_OPTION_TONES,
} from '@/types/ai/agent';

export type {
  IAiContextRange,
  IAiContextReference,
  IAiImageAttachmentPreview,
  TAiContextKind,
} from '@/types/ai/context';

export type {
  IAiAgentChangedFile,
  IAiAgentPatchSummary,
  IAiDiffEditorPreview,
  IAiDiffHunkPreview,
  IAiDiffPreviewLine,
  TAiAgentChangedFileStatus,
  TAiDiffPreviewLineKind,
} from '@/types/ai/patch';

export type {
  IAiAgentStreamErrorPayload,
  IAiToolActivityInline,
  TAiAgentStreamEndReason,
  TAiAgentStreamEvent,
  TAiToolActivityState,
} from '@/types/ai/stream';
export type {
  IAiWebActivity,
  IAiWebFetchInput,
  IAiWebFetchPayload,
  IAiWebFetchResult,
  IAiWebSearchInput,
  IAiWebSearchPayload,
  IAiWebSearchResult,
  IAiWebSourceEntry,
  TAiWebActivityState,
  TAiWebSearchIntent,
  TAiWebSearchRecency,
  TAiWebSourceEntryStatus,
  TAiWebSourceType,
} from '@/types/ai/web';

/* ============================================================================
 * Schema-inferred wire types (single source of truth = ai.schema.ts)
 *
 * RFC-style 规范:所有跨 IPC / 事件 wire 边界的类型必须从 schema 推断,
 * 严禁与 schema 并存的手写定义。需要 UI 层衍生字段时,通过 interface
 * extension 加在 wire 类型之上,见下方 `IAiChatMessage`。
 * ========================================================================== */

/**
 * Language model token 使用量。
 *
 * **不要**从 `'ai'` 包直接 import `LanguageModelUsage`:
 * - 该类型跟随 SDK 版本变化,与本项目 wire 协议形状不一致
 * - 本项目额外携带 `inputTokenDetails / outputTokenDetails / raw` 字段
 *
 * 如需在 UI 层与 `'ai'` SDK 互操作,在调用点显式做一次形状映射。
 */
export type IAiLanguageModelUsage = z.infer<typeof aiLanguageModelUsageSchema>;

export type IAiChatStreamRenderState = z.infer<typeof aiChatMessageStreamSnapshotSchema>;

export type IAiToolCall = z.infer<typeof aiChatMessageToolCallSchema>;

export type IAiChatMessageAction = z.infer<typeof aiChatMessageActionSchema>;
export type TAiChatMessageActionId = IAiChatMessageAction['id'];

export type IAiAgentConfirmationState = z.infer<typeof aiAgentConfirmationStateSchema>;

/**
 * Wire-side chat message — 跨 IPC 边界使用。
 *
 * 不要在此类型上添加 UI-only 衍生字段(如 `patches`、`changedFilesSummary`)。
 * 那些字段属于 UI 状态层,请通过 `IAiChatMessage` 继承。
 */
export type IAiChatMessageWire = z.infer<typeof aiChatMessageSchema>;

export type IAiModelEndpointConfigPayload = z.infer<typeof aiModelEndpointConfigPayloadSchema>;
export type IAiCredentialStatusPayload = z.infer<typeof aiCredentialStatusPayloadSchema>;
export type IAiConfigPayload = z.infer<typeof aiConfigPayloadSchema>;

export type IAiChatRequest = z.infer<typeof aiChatRequestSchema>;
export type IAiConversationTitleRequest = z.infer<typeof aiConversationTitleRequestSchema>;
export type IAiConversationTitlePayload = z.infer<typeof aiConversationTitlePayloadSchema>;
export type IAiSuggestionPoolRequest = z.infer<typeof aiSuggestionPoolRequestSchema>;
export type IAiSuggestionPoolPayload = z.infer<typeof aiSuggestionPoolPayloadSchema>;

export type IAiChatStreamPayload = z.infer<typeof aiChatStreamPayloadSchema>;

export type IAiSaveCredentialsRequest = z.infer<typeof aiSaveCredentialsRequestSchema>;
export type IAiProviderConnectionRequest = z.infer<typeof aiProviderConnectionRequestSchema>;
export type IAiProviderTestPayload = z.infer<typeof aiProviderTestPayloadSchema>;
export type IAiProviderConnectionPayload = z.infer<typeof aiProviderConnectionPayloadSchema>;

export type IAiPatchSet = z.infer<typeof aiPatchSetSchema>;
/** 从 IAiPatchSet narrow 出 file / hunk 元素类型,保持单一来源。 */
export type IAiPatchFile = IAiPatchSet['files'][number];
export type IAiPatchHunk = IAiPatchFile['hunks'][number];

export type IAiApplyPatchMetadata = z.infer<typeof aiApplyPatchMetadataSchema>;

/* ============================================================================
 * UI-only types (no schema; UI state layer only — never sent over IPC)
 * ========================================================================== */

/**
 * UI 层的 chat message:在 wire 形状之上挂载渲染所需的衍生字段。
 *
 * - `patches`:UI 当前显示的已应用 patch 列表
 * - `changedFilesSummary`:Agent 改动文件汇总,sidebar / diff viewer 渲染用
 * - `acpToolCalls`:ACP openWorld 后端(如 Kimi)的工具调用投影,由 from-acp-*
 *   累加器从 `tool_call` / `tool_call_update` UI 事件归一到协议 VM;渲染层经
 *   适配器复用同一工具调用渲染管线。
 *
 * 这些字段**绝对不要**发到 IPC。store 把 `IAiChatMessage[]` 赋给
 * `IAiChatRequest.messages`(`IAiChatMessageWire[]`)时,structural subtyping
 * 自动接受;schema parse 时会 strip 这些字段,backend 不感知。
 */
export interface IAiChatMessage extends IAiChatMessageWire {
  patches?: IAiPatchSet[];
  changedFilesSummary?: IAiAgentPatchSummary;
  acpToolCalls?: IAiThreadToolCall[];
  /**
   * 思维链(reasoning / 思考过程)纯文本:assistant 思考通道(thought chunks)折叠而成,
   * 仅 UI 状态层使用、绝不发到 IPC(schema parse 时被 strip)。承载 entries <-> messages
   * 往返中的 thought 通道,使任何经 legacyMessageToEntries / threadEntriesToMessages 的
   * 回写都不再丢失思考过程(修复「AI 回复结束后思考过程文本/UI 消失」)。
   */
  reasoning?: string;
  /**
   * assistant chunks 流原样快照（message / thought / tool_call 的交织序列）：仅 UI 状态层使用、
   * 绝不发到 IPC（schema parse 时被 strip）。承载 entries <-> messages 往返中的交织顺序与 ACP
   * 工具 chunk，使收尾/水合回写不再丢失工具调用与思考/正文的真实交错。
   */
  chunks?: IAiThreadAssistantChunk[];
}

export type TAiAttachmentStatus = 'processing' | 'ready' | 'failed';

export interface IAiAttachedFile {
  id: string;
  name: string;
  sizeLabel: string;
  kind: 'text' | 'image';
  status?: TAiAttachmentStatus;
  errorMessage?: string;
  detailLabel?: string;
  preview?: IAiImageAttachmentPreview;
  reference: IAiContextReference;
}

export interface IAiProviderSettingsActionFeedback {
  onSuccess(message?: string): void;
  onError(message: string): void;
}

/* ============================================================================
 * Handwritten request / response types (no schema yet — TODO: align)
 *
 * 这些类型暂无对应 schema(可能因为 backend 直接拼 JSON 没走 zod 校验)。
 * 长期目标:每一个跨 IPC / event 边界的类型都应该有 schema。
 * ========================================================================== */

export interface IAiSaveConfigRequest {
  role?: TAiModelRole;
  providerType: TAiProviderType;
  selectedModel: string | null;
  baseUrl: string | null;
  inlineCompletionEnabled: boolean;
  chatEnabled: boolean;
  agentEnabled: boolean;
}

export interface IAiCancelRequest {
  streamId: string;
  /**
   * ACP 取消按 thread 维度:`ai_cancel` 在 `acp_client` 下调用
   * `AcpRuntime.cancel_thread(thread_id)`(thread_id 为空则回退 stream_manager)。
   * 与生成绑定的 `Option<String>` 对齐,使用 `string | null`。
   */
  threadId: string | null;
}

/**
 * ACP 工具调用审批的回投决策(ADR-20260617 D6)。
 *
 * 由前端 approval UI 在用户选择后回投到 Rust `ai_resolve_approval`,唤醒被挂起的
 * 反向 `session/request_permission` JSON-RPC。`decision` 为用户所选 ACP 选项的
 * `optionId` 原文(VERBATIM),Rust / sidecar 不做语义解释,原样回传给外部 agent。
 * 与生成绑定 `AiResolveApprovalRequest` 结构一致(全 camelCase、全必填)。
 */
export interface IAiResolveApprovalRequest {
  sessionId: string;
  toolCallId: string;
  decision: string;
}

/**
 * ACP 会话握手请求（v3 · 唯一标准管线）。
 *
 * thread 维度；与生成绑定 AiEnsureAcpSessionRequest 结构一致（全 camelCase）。backend 指定后端
 * （builtin / kimi / codex），workspaceRootPath 为新建会话的 cwd。握手仅建立/复用会话（触发
 * agent 在 session/new 之后下发一次性 config_option_update 通知），不返回快照——配置项发现统一
 * 走 config_option_update 事件通道（取代旧 ai_get_session_config_options get-工作区）。
 */
export interface IAiEnsureAcpSessionRequest {
  threadId: string;
  backend: 'builtin' | 'kimi' | 'codex';
  workspaceRootPath?: string | null;
}

export interface IAiSetSessionConfigOptionRequest {
  threadId: string;
  configId: string;
  valueId: string;
}

export interface IAiSessionConfigOptionsPayload {
  configOptions: unknown;
}

/**
 * ACP 会话模式查询 / 切换请求与负载（session/set_mode 协议）。
 * thread 维度；与生成绑定 AiGetSessionModesRequest / AiSetSessionModeRequest /
 * AiSessionModesPayload 结构一致（全 camelCase、全必填）。modeId 为 ACP SessionModeId 原值
 * 逐字透传，跨层不做语义映射。modes 为 ACP SessionModeState（currentModeId + availableModes）
 * 原始负载逐字透传（形状 unknown），由前端 ACL（from-acp-session-modes）解析为选择器 VM。
 */
export interface IAiGetSessionModesRequest {
  threadId: string;
}

export interface IAiSetSessionModeRequest {
  threadId: string;
  modeId: string;
}

export interface IAiSessionModesPayload {
  modes: unknown;
}

export interface IAiInlineCompletionRequest {
  filePath: string;
  language: string;
  cursorOffset: number;
  prefix: string;
  suffix: string;
  recentEdits?: string[];
}

export interface IAiInlineCompletionResult {
  insertText: string;
  range: {
    startOffset: number;
    endOffset: number;
  };
  confidence: 'low' | 'medium' | 'high';
}

export interface IAiProposePatchRequest {
  path: string;
  originalContent: string;
  updatedContent: string;
  summary: string;
}

export interface IAiProposePatchPayload {
  patch: IAiPatchSet;
}

export interface IAiApplyPatchRequest {
  patch: IAiPatchSet;
  metadata?: IAiApplyPatchMetadata;
}

export interface IAiApplyPatchPayload {
  appliedFiles: Array<{
    path: string;
    byteSize: number;
  }>;
}
