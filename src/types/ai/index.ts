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
  aiChatStreamEventPayloadSchema,
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
export type IAiChatStreamEventPayload = z.infer<typeof aiChatStreamEventPayloadSchema>;

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
 *
 * 这两个字段**绝对不要**发到 IPC。store 把 `IAiChatMessage[]` 赋给
 * `IAiChatRequest.messages`(`IAiChatMessageWire[]`)时,structural subtyping
 * 自动接受;schema parse 时会 strip 这两个字段,backend 不感知。
 */
export interface IAiChatMessage extends IAiChatMessageWire {
  patches?: IAiPatchSet[];
  changedFilesSummary?: IAiAgentPatchSummary;
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
