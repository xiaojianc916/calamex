export type TDocumentEncoding =
  | 'utf-8'
  | 'utf-8-bom'
  | 'gbk'
  | 'gb18030'
  | 'utf-16le'
  | 'utf-16be';

export type TExecutorKind = 'auto' | 'wsl' | 'git-bash' | 'bash';
export type TLogLevel = 'info' | 'success' | 'error';

export interface IEditorDocument {
  id: string;
  path: string | null;
  name: string;
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
  type: Exclude<TExecutorKind, 'auto'>;
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

export interface IRunResult {
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

export interface IRunScriptRequest {
  path: string | null;
  content: string;
  encoding: TDocumentEncoding;
  executor: TExecutorKind;
  isDirty: boolean;
}
