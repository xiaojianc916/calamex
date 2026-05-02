import type { IAiContextReference } from '@/types/ai-context';

export type TAiProviderType =
  | 'litellm';
export type TAiStatus = 'idle' | 'generating' | 'streaming' | 'error';
export type TAiChatRole = 'user' | 'assistant' | 'system' | 'tool';
export type {
  IAiContextRange,
  IAiContextReference,
  TAiContextKind,
} from '@/types/ai-context';

export type {
  IAiWebFetchInput,
  IAiWebFetchPayload,
  IAiWebFetchResult,
  IAiWebActivity,
  IAiWebSearchInput,
  IAiWebSearchPayload,
  IAiWebSearchResult,
  IAiWebSourceEntry,
  TAiWebSearchIntent,
  TAiWebSearchRecency,
  TAiWebActivityState,
  TAiWebSourceEntryStatus,
  TAiWebSourceType,
} from '@/types/ai-web';

export type {
  IAiAgentChangedFile,
  IAiAgentPatchSummary,
  IAiDiffHunkPreview,
  IAiDiffEditorPreview,
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
  IAiAgentApprovePlanPayload,
  IAiAgentApprovePlanRequest,
  IAiAgentClassifyTaskPayload,
  IAiAgentClassifyTaskRequest,
  IAiAgentNetworkPermissionPayload,
  IAiAgentPermissionState,
  IAiAgentPlanPayload,
  IAiAgentPlanReference,
  IAiAgentPlanRequest,
  IAiAgentListRunsPayload,
  IAiTaskPlanStep,
  IAiAgentRun,
  IAiAgentRunIdRequest,
  IAiAgentRunPayload,
  IAiAgentRunPlanRequest,
  IAiAgentRunStepRequest,
  IAiAgentResolveToolConfirmationRequest,
  IAiAgentSetNetworkPermissionRequest,
  IAiAgentStepDetail,
  IAiAgentStepFinalAnswer,
  IAiAgentStepToolResultSummary,
  IAiAgentStepWebSourceSummary,
  IAiAgentTimelineItem,
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
  status: 'streaming' | 'completed' | 'cancelled';
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

export interface IAiChatMessage {
  id: string;
  role: TAiChatRole;
  content: string;
  createdAt: string;
  references: IAiContextReference[];
  toolCalls?: IAiToolCall[];
  actions?: IAiChatMessageAction[];
  agentConfirmation?: IAiAgentConfirmationState;
  stream?: IAiChatStreamRenderState;
}

export interface IAiToolCall {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'denied';
  summary: string;
  targetPreview?: string;
  elapsedMs?: number;
}

export interface IAiToolDefinitionPayload {
  name: string;
  readOnly: boolean;
  destructive: boolean;
  requiresConfirmation: boolean;
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
}

export interface IAiSaveConfigRequest {
  providerType: TAiProviderType;
  selectedModel: string | null;
  baseUrl: string | null;
  inlineCompletionEnabled: boolean;
  chatEnabled: boolean;
  agentEnabled: boolean;
}

export interface IAiSaveCredentialsRequest {
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

export interface IAiChatPayload {
  message: IAiChatMessage;
  providerType: TAiProviderType;
  model: string;
}

export interface IAiConversationTitleRequest {
  userMessage: string;
  assistantMessage: string;
}

export interface IAiConversationTitlePayload {
  title: string;
  model: string;
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
  name: string;
  providerType: TAiProviderType;
  selectedModel: string | null;
  baseUrl: string | null;
  inlineCompletionEnabled: boolean;
  chatEnabled: boolean;
  agentEnabled: boolean;
  hasCredentials: boolean;
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

export interface IAiBuildIndexRequest {
  workspaceRootPath: string;
}

export interface IAiBuildIndexPayload {
  rootPath: string;
  indexedFileCount: number;
  skippedFileCount: number;
}

export interface IAiQueryIndexRequest {
  workspaceRootPath: string;
  query: string;
  limit?: number;
}

export interface IAiIndexResultPayload {
  path: string;
  lineNumber: number | null;
  preview: string;
  score: number;
}

export interface IAiQueryIndexPayload {
  rootPath: string;
  results: IAiIndexResultPayload[];
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
