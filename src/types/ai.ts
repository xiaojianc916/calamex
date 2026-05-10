import type { TAgentRuntimeEvent } from '@/types/agent-sidecar';
import type { IAiContextReference, IAiImageAttachmentPreview } from '@/types/ai-context';
import type { LanguageModelUsage } from 'ai';

export type TAiProviderType = 'litellm';
export type TAiModelRole = 'main' | 'narrator';
export type TAiStatus = 'idle' | 'generating' | 'streaming' | 'error';
export type TAiChatRole = 'user' | 'assistant' | 'system' | 'tool';
export type TActivityNoteTone = 'plan' | 'progress' | 'decision' | 'repair' | 'warning' | 'summary';
export type TActivityNoteTrigger =
  | 'run_started'
  | 'plan_ready'
  | 'plan_approved'
  | 'context_checked'
  | 'search_done'
  | 'files_read'
  | 'file_batch_read'
  | 'web_search_done'
  | 'time_checked'
  | 'edit_done'
  | 'edit_batch_done'
  | 'patch_failed'
  | 'verification_started'
  | 'verification_failed'
  | 'test_failed'
  | 'verification_done'
  | 'git_checked'
  | 'git_diff_ready'
  | 'git_commit_ready'
  | 'git_done'
  | 'final_summary';
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
  IAiAgentApprovePlanPayload,
  IAiAgentApprovePlanRequest,
  IAiAgentClassifyTaskPayload,
  IAiAgentClassifyTaskRequest,
  IAiAgentListRunsPayload,
  IAiAgentNetworkPermissionPayload,
  IAiAgentPlanMetadata,
  IAiAgentPlanVersionSummary,
  IAiAgentPermissionState,
  IAiAgentPlanPayload,
  IAiAgentPlanReference,
  IAiAgentPlanRequest,
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
  status: 'streaming' | 'completed' | 'cancelled';
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

export interface IAiToolDefinitionPayload {
  name: string;
  readOnly: boolean;
  destructive: boolean;
  requiresConfirmation: boolean;
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

export interface IAiChatPayload {
  message: IAiChatMessage;
  providerType: TAiProviderType;
  model: string;
  usage?: LanguageModelUsage | null;
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

export interface IAiNarratorChangedFile {
  path: string;
  additions?: number;
  deletions?: number;
}

export interface IAiNarratorReadFile {
  path: string;
  range?: string;
}

export interface IAiNarratorSearchSummary {
  query: string;
  resultCount?: number;
}

export interface IAiNarratorFacts {
  userGoal: string;
  trigger: TActivityNoteTrigger;
  recentActions: string[];
  changedFiles: IAiNarratorChangedFile[];
  readFiles: IAiNarratorReadFile[];
  searchSummary?: IAiNarratorSearchSummary;
  errorSummary?: string;
  currentFinding?: string;
  nextAction?: string;
  previousNarrations: string[];
}

export interface IAiNarratorRequest {
  runId: string;
  messageId: string;
  turnId?: string | null;
  factsHash: string;
  sequence: number;
  facts: IAiNarratorFacts;
}

export interface IAiNarratorResponse {
  runId: string;
  messageId: string;
  turnId?: string | null;
  factsHash: string;
  sequence: number;
  trigger: TActivityNoteTrigger;
  shouldShow: boolean;
  tone: TActivityNoteTone;
  text: string;
  relatedFiles: string[];
  confidence?: 'low' | 'medium' | 'high' | null;
  model: string;
}

export interface IAiNarratorStreamPayload {
  streamId: string;
  runId: string;
  messageId: string;
  turnId?: string | null;
  factsHash: string;
  sequence: number;
  trigger: TActivityNoteTrigger;
  model: string;
}

export interface IAiNarratorStreamEventPayload {
  streamId: string;
  runId: string;
  messageId: string;
  turnId?: string | null;
  factsHash: string;
  sequence: number;
  trigger: TActivityNoteTrigger;
  kind: 'start' | 'delta' | 'done' | 'error' | 'cancelled';
  delta: string | null;
  message: string | null;
  shouldShow?: boolean | null;
  tone?: TActivityNoteTone | null;
  text?: string | null;
  relatedFiles?: string[];
  confidence?: 'low' | 'medium' | 'high' | null;
  model: string | null;
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
