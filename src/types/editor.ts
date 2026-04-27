export type TDocumentEncoding =
  | 'utf-8'
  | 'utf-8-bom'
  | 'gbk'
  | 'gb18030'
  | 'utf-16le'
  | 'utf-16be';

export type TDocumentKind = 'text' | 'image';
export type TExecutorKind = 'wsl';
export type TLogLevel = 'info' | 'success' | 'error';
export type TRunLogScope = 'run' | 'workspace' | 'editor' | 'system';
export type TScriptDiagnosticSeverity = 'error' | 'warning' | 'info' | 'style';
export type TRunHistoryStatus = 'success' | 'failed' | 'canceled';

export interface IEditorDocument {
  id: string;
  path: string | null;
  name: string;
  kind: TDocumentKind;
  content: string;
  encoding: TDocumentEncoding;
  savedContent: string;
  savedEncoding: TDocumentEncoding;
  isDirty: boolean;
  lineCount: number;
  charCount: number;
}

export interface ICommandTemplate {
  id: string;
  title: string;
  category: string;
  description: string;
  snippet: string;
  cursorOffset?: number;
}

export interface IExecutionOption {
  type: TExecutorKind;
  label: string;
  available: boolean;
  description: string;
  commandPath: string | null;
}

export interface IExecutionEnvironment {
  recommended: TExecutorKind;
  hasAny: boolean;
  executors: IExecutionOption[];
}

export interface IRunLogEntry {
  id: string;
  level: TLogLevel;
  title: string;
  detail: string;
  createdAt: string;
  scope?: TRunLogScope;
  runId?: string | null;
  code?: string | null;
}

export interface IActiveRunSummary {
  runId: string;
  documentName: string;
  documentPath: string | null;
  commandLine: string;
  executor: TExecutorKind;
  executorLabel: string;
  startedAt: string;
  usedTempFile: boolean;
}

export interface IEditorSelectionSummary {
  text: string;
  startLine: number;
  endLine: number;
}

export interface IRunHistoryEntry {
  id: string;
  status: TRunHistoryStatus;
  documentName: string;
  documentPath: string | null;
  commandLine: string;
  executor: TExecutorKind;
  executorLabel: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  usedTempFile: boolean;
}

export interface IWorkspaceEntry {
  path: string;
  name: string;
  kind: 'directory' | 'file';
  hasChildren: boolean;
}

export interface IWorkspaceDirectoryPayload {
  rootPath: string;
  rootName: string;
  entries: IWorkspaceEntry[];
}

export interface IWorkspacePathCreateRequest {
  parentPath: string;
  rootPath: string;
  name: string;
  kind: 'directory' | 'file';
}

export interface IWorkspacePathCreatePayload {
  path: string;
  name: string;
  kind: 'directory' | 'file';
}

export interface IWorkspacePathRenameRequest {
  path: string;
  rootPath: string;
  newName: string;
}

export interface IWorkspacePathRenamePayload {
  oldPath: string;
  newPath: string;
  name: string;
}

export interface IWorkspacePathDeleteRequest {
  path: string;
  rootPath: string;
}

export interface IWorkspacePathDeletePayload {
  path: string;
}

export interface IRunResult {
  runId: string | null;
  success: boolean;
  stdout: string;
  stderr: string;
  combinedOutput: string;
  exitCode: number | null;
  executor: TExecutorKind;
  executorLabel: string;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  commandLine: string;
  logPath: string | null;
  usedTempFile: boolean;
}

export interface IScriptDiagnostic {
  line: number;
  endLine: number;
  column: number;
  endColumn: number;
  level: TScriptDiagnosticSeverity;
  code: string;
  message: string;
}

export interface IAnalyzeScriptRequest {
  path: string | null;
  name?: string | null;
  content: string;
}

export interface IAnalyzeScriptPayload {
  available: boolean;
  message: string | null;
  dialect: string;
  diagnostics: IScriptDiagnostic[];
}

export interface IImageAssetPayload {
  path: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  byteSize: number;
}

export interface IScriptFilePayload {
  path: string;
  name: string;
  content: string;
  encoding: TDocumentEncoding;
  lineCount: number;
  charCount: number;
}

export interface ISaveScriptRequest {
  path: string;
  content: string;
  encoding: TDocumentEncoding;
}

export interface IFormatScriptRequest {
  path: string | null;
  content: string;
  encoding: TDocumentEncoding;
}

export interface IFormatScriptPayload {
  content: string;
  encoding: TDocumentEncoding;
  lineCount: number;
  charCount: number;
}
