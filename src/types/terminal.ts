export const DEFAULT_TERMINAL_SESSION_ID = 'main-terminal';

export type TTerminalConnectionState = 'connecting' | 'ready' | 'error' | 'closed';

export interface IEnsureTerminalSessionRequest {
  sessionId: string;
  cwd: string | null;
  cols: number;
  rows: number;
}

export interface IWriteTerminalInputRequest {
  sessionId: string;
  data: string;
}

export interface IDispatchTerminalScriptRequest {
  sessionId: string;
  path: string | null;
  content: string;
  isDirty: boolean;
  runId: string;
}

export interface IResizeTerminalSessionRequest {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface ICloseTerminalSessionRequest {
  sessionId: string;
}

export interface ITerminalSessionPayload {
  sessionId: string;
  cwd: string;
  shellLabel: string;
  created: boolean;
}

export interface IDispatchTerminalScriptPayload {
  sessionId: string;
  cwd: string;
  commandLine: string;
  usedTempFile: boolean;
  startedAt: string;
}

export interface ITerminalDataEvent {
  sessionId: string;
  data: string;
}

export interface ITerminalRunOutputEvent {
  sessionId: string;
  runId: string;
  data: string;
}

export interface ITerminalExitEvent {
  sessionId: string;
  exitCode: number | null;
}

export interface ITerminalStatusChangePayload {
  state: TTerminalConnectionState;
  message: string;
}

export interface ITerminalRunCompletePayload {
  sessionId: string;
  runId: string;
  exitCode: number | null;
  finishedAt: string;
}
