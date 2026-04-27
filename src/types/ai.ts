import type { IAiCodeBlock } from '@/types/ai-code';

export type TAiProviderType =
  | 'mock'
  | 'openai'
  | 'deepseek'
  | 'moonshot'
  | 'dashscope'
  | 'zhipu'
  | 'siliconflow'
  | 'openai-compatible'
  | 'claude-compatible'
  | 'local'
  | 'custom-gateway';
export type TAiStatus = 'idle' | 'generating' | 'streaming' | 'error';
export type TAiChatRole = 'user' | 'assistant' | 'system' | 'tool';
export type TAiContextKind =
  | 'current-file'
  | 'selection'
  | 'cursor-window'
  | 'diagnostics'
  | 'git-diff'
  | 'terminal-log'
  | 'search-result'
  | 'symbol-definition'
  | 'symbol-references'
  | 'project-tree';

export interface IAiContextReference {
  id: string;
  kind: TAiContextKind;
  label: string;
  path: string | null;
  range: { startLine: number; endLine: number } | null;
  contentPreview: string;
  redacted: boolean;
}

export interface IAiChatStreamRenderState {
  stableContent: string;
  openBlock: IAiCodeBlock | null;
  status: 'streaming' | 'completed' | 'cancelled';
}

export interface IAiChatMessage {
  id: string;
  role: TAiChatRole;
  content: string;
  createdAt: string;
  references: IAiContextReference[];
  toolCalls?: IAiToolCall[];
  stream?: IAiChatStreamRenderState;
}

export interface IAiToolCall {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'denied';
  summary: string;
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

export interface IAiTaskPlanStep {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'requires-confirmation';
}

export interface IAiAgentPlanRequest {
  goal: string;
  context: IAiContextReference[];
}

export interface IAiAgentPlanPayload {
  steps: IAiTaskPlanStep[];
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

export interface IAiApplyPatchRequest {
  patch: IAiPatchSet;
}

export interface IAiApplyPatchPayload {
  appliedFiles: Array<{
    path: string;
    byteSize: number;
  }>;
}
