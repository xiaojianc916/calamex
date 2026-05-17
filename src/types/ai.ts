import type { TAgentRuntimeEvent } from '@/types/agent-sidecar';
import type { IAiContextReference, IAiImageAttachmentPreview } from '@/types/ai-context';
import type { IAiAgentPatchSummary } from '@/types/ai-patch';
import type { LanguageModelUsage } from 'ai';

export type TAiProviderType = 'mastra';
export type TAiModelRole = 'main' | 'narrator';
export type TAiStatus = 'idle' | 'generating' | 'streaming' | 'error';
export type TAiChatRole = 'user' | 'assistant' | 'system' | 'tool';
export type {
  IAiContextRange,
  IAiContextReference,
  IAiImageAttachmentPreview,
  TAiContextKind,
} from '@/types/ai-context';

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
} from '@/types/ai-web';

export type {
  IAiAgentChangedFile,
  IAiAgentPatchSummary,
  IAiDiffEditorPreview,
  IAiDiffHunkPreview,
  IAiDiffPreviewLine,
  TAiAgentChangedFileStatus,
  TAiDiffPreviewLineKind,
} from '@/types/ai-patch';

export type {
  IAiAgentStreamErrorPayload,
  IAiToolActivityInline,
  TAiAgentStreamEndReason,
  TAiAgentStreamEvent,
  TAiToolActivityState,
} from '@/types/ai-stream';

export type {
  IAiAgentClassifyTaskPayload,
  IAiAgentClassifyTaskRequest,
  IAiAgentListRunsPayload,
  IAiAgentNetworkPermissionPayload,
  IAiAgentPlanMetadata,
  IAiAgentPlanVersionSummary,
  IAiAgentPermissionState,
  IAiAgentPlanReference,
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
} from '@/types/ai-agent';

export interface IAiChatStreamRenderState {
  status: 'streaming' | 'waiting-confirmation' | 'completed' | 'cancelled';
  activityText?: string;
  runtimeEvents?: TAgentRuntimeEvent[];
  finalAnswerStarted?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  usage?: LanguageModelUsage;
}

export type TAiChatMessageActionId = 'allow-agent-execution';

export interface IAiChatMessageAction {
  id: TAiChatMessageActionId;
  label: string;
  disabled?: boolean;
}

export interface IAiAgentConfirmationState {
  goal: string;
  references: IAiContextReference[];
  status: 'pending' | 'running';
}

export interface IAiAttachedFile {
  id: string;
  name: string;
  sizeLabel: string;
  kind: 'text' | 'image';
  detailLabel?: string;
  preview?: IAiImageAttachmentPreview;
  reference: IAiContextReference;
}

export interface IAiChatMessage {
  id: string;
  role: TAiChatRole;
  content: string;
  createdAt: string;
  references: IAiContextReference[];
  toolCalls?: IAiToolCall[];
  actions?: IAiChatMessageAction[];
  agentConfirmation?: IAiAgentConfirmationState;
  patches?: IAiPatchSet[];
  changedFilesSummary?: IAiAgentPatchSummary;
  stream?: IAiChatStreamRenderState;
}

export interface IAiToolCall {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'denied';
  summary: string;
  targetPreview?: string;
  detailItems?: string[];
  elapsedMs?: number;
}

export interface IAiModelEndpointConfigPayload {
  providerType: TAiProviderType;
  selectedModel: string | null;
  baseUrl: string | null;
  activeProfileId: string | null;
  isBaseUrlConfigured: boolean;
  hasCredentials: boolean;
  isConfigured: boolean;
}

export interface IAiConfigPayload {
  providerType: TAiProviderType;
  selectedModel: string | null;
  baseUrl: string | null;
  activeProfileId: string | null;
  isBaseUrlConfigured: boolean;
  hasCredentials: boolean;
  isConfigured: boolean;
  inlineCompletionEnabled: boolean;
  chatEnabled: boolean;
  agentEnabled: boolean;
  narrator: IAiModelEndpointConfigPayload;
}

export interface IAiSaveConfigRequest {
  role?: TAiModelRole;
  providerType: TAiProviderType;
  selectedModel: string | null;
  baseUrl: string | null;
  inlineCompletionEnabled: boolean;
  chatEnabled: boolean;
  agentEnabled: boolean;
}

export interface IAiSaveCredentialsRequest {
  role?: TAiModelRole;
  providerType: TAiProviderType;
  apiKey: string;
}

export interface IAiProviderConnectionRequest extends IAiSaveConfigRequest {
  apiKey: string | null;
}

export interface IAiProviderSettingsActionFeedback {
  onSuccess(message?: string): void;
  onError(message: string): void;
}

export interface IAiChatRequest {
  threadId: string | null;
  messages: IAiChatMessage[];
  references: IAiContextReference[];
}

export interface IAiConversationTitleRequest {
  userMessage: string;
  assistantMessage: string;
}

export interface IAiConversationTitlePayload {
  title: string;
  model: string;
}

export interface IAiSuggestionPoolRequest {
  count: number;
  locale: string;
  topics: string[];
}

export interface IAiSuggestionPoolPayload {
  suggestions: string[];
  model: string;
  generatedAt: string;
}

export interface IAiChatStreamPayload {
  streamId: string;
  assistantMessageId: string;
  providerType: TAiProviderType;
  model: string;
}

export interface IAiChatStreamEventPayload {
  streamId: string;
  assistantMessageId: string;
  kind: 'start' | 'delta' | 'done' | 'error' | 'cancelled';
  delta: string | null;
  message: string | null;
  model: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  usage?: LanguageModelUsage | null;
}

export interface IAiCancelRequest {
  streamId: string;
}

export interface IAiProviderTestPayload {
  ok: boolean;
  code: string;
  message: string;
}

export interface IAiProviderConnectionPayload {
  config: IAiConfigPayload;
  test: IAiProviderTestPayload;
}

export interface IAiProviderProfilePayload {
  id: string;
  role: TAiModelRole;
  name: string;
  providerType: TAiProviderType;
  selectedModel: string | null;
  baseUrl: string | null;
  inlineCompletionEnabled: boolean;
  chatEnabled: boolean;
  agentEnabled: boolean;
  hasCredentials: boolean;
  isConnected: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface IAiProviderProfileDetailPayload {
  profile: IAiProviderProfilePayload;
  apiKey: string | null;
}

export interface IAiProviderProfileSwitchRequest {
  profileId: string;
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

export interface IAiPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface IAiPatchFile {
  path: string;
  originalHash: string;
  originalModifiedAtMs?: number | null;
  hunks: IAiPatchHunk[];
}

export interface IAiPatchSet {
  summary: string;
  files: IAiPatchFile[];
}

export interface IAiCodeActionResult {
  explanation: string;
  suggestedPatch: IAiPatchSet | null;
  testSuggestion: string | null;
  followUpQuestions: string[];
}

export interface IAiCodeActionRequest {
  kind:
    | 'explain_selection'
    | 'rewrite_selection'
    | 'generate_tests'
    | 'fix_diagnostic'
    | 'extract_function'
    | 'add_error_handling'
    | 'add_docs'
    | 'simplify_code'
    | 'convert_style';
  filePath: string | null;
  language: string;
  selection: string;
  diagnostics: string[];
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

export interface IAiApplyPatchMetadata {
  taskId?: string | null;
  turnId?: string | null;
  reason?: string | null;
  toolCallId?: string | null;
  confirmedByUser?: boolean | null;
  agentRunId?: string | null;
  agentStepId?: string | null;
  workspaceRootPath?: string | null;
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
