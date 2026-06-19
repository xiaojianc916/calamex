export const DEFAULT_TERMINAL_SESSION_ID = 'main-terminal';

export type TTerminalConnectionState = 'connecting' | 'ready' | 'error' | 'closed';
export type TTerminalRuntimeState =
  | 'booting'
  | 'idle_interactive'
  | 'switching_to_run'
  | 'running'
  | 'switching_to_idle';
export type TTerminalInputRoute = 'interactive' | 'run' | 'buffered' | 'dropped';
export type TTerminalDataSource = 'interactive' | 'run' | 'injected_reset' | 'injected_separator';

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
  workspaceRootPath: string | null;
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

export interface IHeartbeatTerminalSessionRequest {
  sessionId: string;
}

export interface ICancelTerminalRunRequest {
  runId: string;
}

/**
 * 重载恢复：某会话当前活动运行的快照，随 ensureTerminalSession 复用分支回传。
 * 页面重载后运行态镜像被重置，据此复原「运行中 / 取消」UI。pid / startedAtMs
 * 在 RunStarted 事件到达后才有值，故可空。
 */
export interface ITerminalActiveRunSnapshot {
  runId: string;
  pid: number | null;
  startedAtMs: number | null;
}

export interface ITerminalSessionPayload {
  sessionId: string;
  cwd: string;
  shellLabel: string;
  created: boolean;
  initialOutput?: string | null;
  /** 复用既有会话且该会话仍有活动运行时带回其快照；否则为 null/缺省。 */
  activeRun?: ITerminalActiveRunSnapshot | null;
  /** 该会话当前的每会话运行态，供重载后复原全局 / 会话态镜像。 */
  sessionState?: TTerminalRuntimeState;
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
  source?: TTerminalDataSource;
  seq?: number;
  runId?: string;
  runSeq?: number;
}

export interface ITerminalExitEvent {
  sessionId: string;
  exitCode: number | null;
}

export interface ITerminalStatusChangePayload {
  state: TTerminalConnectionState;
  message: string;
}

export interface ITerminalRunCompletedPayload {
  sessionId: string;
  runId: string;
  exitCode: number | null;
  finishedAt: string;
}

export interface ITerminalRunStartedPayload {
  sessionId: string;
  runId: string;
  startedAtMs: number;
  pid: number;
}

/**
 * 每会话状态转移事件 (`terminal:session-state-changed`)：带 `sessionId`,
 * 后端按会话定向发射,前端按会话存储——P0 多会话地基。
 */
export interface ITerminalSessionStateChangedPayload {
  sessionId: string;
  from: TTerminalRuntimeState;
  to: TTerminalRuntimeState;
  atMs: number;
}

export interface ITerminalInputRoutePayload {
  route: TTerminalInputRoute;
  data: Uint8Array;
}

export interface ITerminalVisualWritePayload {
  sessionId: string;
  data: string;
  source?: TTerminalDataSource;
  seq?: number;
  runId?: string;
  runSeq?: number;
}

export interface ITerminalBufferDiagnostic {
  label: string;
  at: string;
  cursorX: number;
  cursorY: number;
  baseY: number;
  viewportY: number;
  rows: number;
  cols: number;
  bufferLength: number;
  visible: boolean;
  activeRunId: string | null;
  pendingWriteChars: number;
  hiddenBacklogChars: number;
  hostWidth: number | null;
  hostHeight: number | null;
  writePreview: string | null;
  lastLines: string[];
}

export interface ITerminalRunHandle {
  runId: string;
  sessionId: string;
  cwd: string;
  commandLine: string;
  usedTempFile: boolean;
  startedAt: string;
  startedAtMs?: number;
  pid?: number | null;
}
