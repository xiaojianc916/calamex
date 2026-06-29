import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type {
  ITerminalBufferDiagnostic,
  ITerminalDataEvent,
  ITerminalRunHandle,
  ITerminalSessionStateChangedPayload,
  ITerminalVisualWritePayload,
  TTerminalDataSource,
  TTerminalInputRoute,
  TTerminalRuntimeState,
} from '@/types/terminal';

export type { TTerminalInputRoute };

// ---------------------------------------------------------------------------
// Public diagnostic shapes
// ---------------------------------------------------------------------------

export interface ITerminalFrameDiagnostic {
  index: number;
  at: string;
  source: TTerminalDataSource | 'unknown';
  seq: number | null;
  runId: string | null;
  runSeq: number | null;
  bytes: number;
  preview: string;
}

export interface ITerminalFlowDiagnostics {
  terminalDataChunks: number;
  terminalDataBytes: number;
  visualWriteChunks: number;
  visualWriteBytes: number;
  injectedResetEvents: number;
  injectedSeparatorEvents: number;
  lastTerminalDataSeq: number | null;
  recentTerminalData: ITerminalFrameDiagnostic[];
  recentVisualWrites: ITerminalFrameDiagnostic[];
  bufferDiagnostics: ITerminalBufferDiagnostic[];
  preRunTerminalData: ITerminalFrameDiagnostic[];
  preRunVisualWrites: ITerminalFrameDiagnostic[];
  preRunBufferDiagnostics: ITerminalBufferDiagnostic[];
  inputEvents: number;
  droppedInputEvents: number;
  lastInputRoute: TTerminalInputRoute | null;
  lastEventName: string | null;
  lastEventAt: string | null;
  lastRunId: string | null;
  lastExitCode: number | null;
  lastCompletedAt: string | null;
  cancelRequestedAt: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RECENT_FRAMES = 12;
const MAX_BUFFER_DIAGNOSTICS = 24;
const FRAME_PREVIEW_MAX_LENGTH = 120;

const INJECTED_RESET_SOURCE: TTerminalDataSource = 'injected_reset';
const INJECTED_SEPARATOR_SOURCE: TTerminalDataSource = 'injected_separator';

const ANSI_ESCAPE_CHARACTER_PATTERN = new RegExp(String.fromCharCode(27), 'gu');

const textEncoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const nowIso = (): string => new Date().toISOString();

const numericOrNull = (value: unknown): number | null => (typeof value === 'number' ? value : null);

const measureBytes = (value: string | Uint8Array): number => {
  if (value instanceof Uint8Array) {
    return value.byteLength;
  }
  return textEncoder.encode(value).length;
};

const previewFrameData = (value: string): string =>
  value
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replace(ANSI_ESCAPE_CHARACTER_PATTERN, '\\x1b')
    .slice(0, FRAME_PREVIEW_MAX_LENGTH);

/** Push `item` then trim the head to keep `target.length <= maxSize`. */
const appendCapped = <T>(target: T[], item: T, maxSize: number): void => {
  target.push(item);
  if (target.length > maxSize) {
    target.splice(0, target.length - maxSize);
  }
};

const createFrameDiagnostic = (
  payload: ITerminalDataEvent | ITerminalVisualWritePayload,
  index: number,
): ITerminalFrameDiagnostic => ({
  index,
  at: nowIso(),
  source: payload.source ?? 'unknown',
  seq: numericOrNull(payload.seq),
  runId: payload.runId ?? null,
  runSeq: numericOrNull(payload.runSeq),
  bytes: measureBytes(payload.data),
  preview: previewFrameData(payload.data),
});

const pushRecentFrame = (
  target: ITerminalFrameDiagnostic[],
  payload: ITerminalDataEvent | ITerminalVisualWritePayload,
  index: number,
): void => {
  appendCapped(target, createFrameDiagnostic(payload, index), MAX_RECENT_FRAMES);
};

const mergeRunHandle = (
  current: ITerminalRunHandle,
  next: ITerminalRunHandle,
): ITerminalRunHandle => ({
  runId: next.runId,
  sessionId: next.sessionId || current.sessionId,
  cwd: next.cwd || current.cwd,
  commandLine: next.commandLine || current.commandLine,
  // Only adopt next.usedTempFile if next carries fresh command/cwd context.
  usedTempFile: next.commandLine || next.cwd ? next.usedTempFile : current.usedTempFile,
  startedAt: next.startedAt || current.startedAt,
  startedAtMs: next.startedAtMs ?? current.startedAtMs,
  pid: next.pid ?? current.pid ?? null,
});

const createEmptyDiagnostics = (): ITerminalFlowDiagnostics => ({
  terminalDataChunks: 0,
  terminalDataBytes: 0,
  visualWriteChunks: 0,
  visualWriteBytes: 0,
  injectedResetEvents: 0,
  injectedSeparatorEvents: 0,
  lastTerminalDataSeq: null,
  recentTerminalData: [],
  recentVisualWrites: [],
  bufferDiagnostics: [],
  preRunTerminalData: [],
  preRunVisualWrites: [],
  preRunBufferDiagnostics: [],
  inputEvents: 0,
  droppedInputEvents: 0,
  lastInputRoute: null,
  lastEventName: null,
  lastEventAt: null,
  lastRunId: null,
  lastExitCode: null,
  lastCompletedAt: null,
  cancelRequestedAt: null,
});

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useTerminalRuntimeStore = defineStore('terminal-runtime', () => {
  // -- state -----------------------------------------------------------------

  const state = ref<TTerminalRuntimeState>('booting');
  const interactiveReady = ref(false);
  const showRunSeparator = ref(true);
  const deepDiagnosticsEnabled = ref(false);
  const diagnostics = ref<ITerminalFlowDiagnostics>(createEmptyDiagnostics());
  /**
   * 每会话运行态镜像 (P0 多会话地基)。后端按 session_id 发
   * `terminal:session-state-changed`,前端按会话存储,供多标签 UI 与
   * per-session 输入路由消费。全局 `state` 作为重载恢复 / 首事件到达前的回退
   * FSM 与之并存(由 `applyStateChanged` 驱动,事件源不同),本切片不动。
   */
  const sessionStates = ref<Map<string, TTerminalRuntimeState>>(new Map());
  /**
   * 每会话活动运行句柄镜像 —— 运行态的唯一事实源 (FE-1 多会话)。按 run 归属的
   * session_id 存句柄,使每个会话的输入路由读到「自己的」运行;多开并发运行时
   * 互不覆盖,不会把会话 A 的输入误投到会话 B 的 run stdin。
   *
   * 全局 `activeRun` 不再单独存一份句柄,而是由本 map + `activeRunSessionId`
   * 指针派生(见下),彻底消除「全局 ref / per-session map」双写。
   *
   * 对照 VSCode ptyService.ts:每个 PersistentTerminalProcess 各自持有运行/交互态,
   * input/resize 全按 id 路由,不存在跨会话共享的单一活动运行。
   */
  const sessionActiveRuns = ref<Map<string, ITerminalRunHandle>>(new Map());
  /**
   * 「最近活动运行」所属的会话编号。全局 `activeRun` 派生自它 + `sessionActiveRuns`,
   * 仅在缺少显式会话上下文时(routeInput 回退、迁移期消费方)用作指针。该会话的
   * 运行被移除 / 会话被清理时会被收敛为 null,全局随之回落,不残留陈旧句柄。
   */
  const activeRunSessionId = ref<string | null>(null);

  // -- getters ---------------------------------------------------------------

  const isRunning = computed(() => state.value === 'running');

  /**
   * 全局活动运行句柄。派生自 `sessionActiveRuns`(唯一事实源),指向
   * `activeRunSessionId` 记录的会话;指针为空或该会话已无运行时为 null。
   */
  const activeRun = computed<ITerminalRunHandle | null>(() =>
    activeRunSessionId.value
      ? (sessionActiveRuns.value.get(activeRunSessionId.value) ?? null)
      : null,
  );

  // -- diagnostic markers ----------------------------------------------------

  const markEvent = (eventName: string): void => {
    if (!deepDiagnosticsEnabled.value) return;
    diagnostics.value.lastEventName = eventName;
    diagnostics.value.lastEventAt = nowIso();
  };

  // -- per-session active run helpers (FE-1 多会话) ---------------------------

  /** 写入/更新某会话的活动运行镜像。Vue 对 Map.set/delete 有响应性，原地更新即可触发依赖它的 computed/watcher。 */
  const setSessionActiveRun = (run: ITerminalRunHandle): void => {
    sessionActiveRuns.value.set(run.sessionId, run);
  };

  /** 按 runId 移除活动运行镜像（运行完成/派发失败）。 */
  const removeSessionActiveRunByRunId = (runId: string): void => {
    const current = sessionActiveRuns.value;
    for (const [sessionId, handle] of current) {
      if (handle.runId === runId) {
        current.delete(sessionId);
      }
    }
  };

  const getSessionActiveRun = (sessionId: string): ITerminalRunHandle | null =>
    sessionActiveRuns.value.get(sessionId) ?? null;

  // -- interactive lifecycle -------------------------------------------------

  const markInteractiveReady = (): void => {
    interactiveReady.value = true;
    markEvent('terminal:interactive-ready');
  };

  const markInteractiveExited = (): void => {
    interactiveReady.value = false;
    markEvent('terminal:interactive-exited');
  };

  // -- run lifecycle ---------------------------------------------------------

  const markRunStarted = (run: ITerminalRunHandle): void => {
    const current = activeRun.value;
    // Same run id arriving again — patch the handle and bump diagnostics.
    if (current?.runId === run.runId) {
      const merged = mergeRunHandle(current, run);
      setSessionActiveRun(merged);
      activeRunSessionId.value = merged.sessionId;
      diagnostics.value.lastRunId = run.runId;
      markEvent('terminal:run-started');
      return;
    }

    // New run — snapshot current "recent" buffers as the pre-run history,
    // then start fresh diagnostics.
    const preRunTerminalData = diagnostics.value.recentTerminalData.slice();
    const preRunVisualWrites = diagnostics.value.recentVisualWrites.slice();
    const preRunBufferDiagnostics = diagnostics.value.bufferDiagnostics.slice();

    setSessionActiveRun(run);
    activeRunSessionId.value = run.sessionId;
    diagnostics.value = {
      ...createEmptyDiagnostics(),
      preRunTerminalData,
      preRunVisualWrites,
      preRunBufferDiagnostics,
      lastRunId: run.runId,
      lastEventName: 'terminal:run-started',
      lastEventAt: nowIso(),
    };
  };

  const updateActiveRun = (run: ITerminalRunHandle): void => {
    const current = activeRun.value;
    if (current?.runId !== run.runId) return;
    const merged = mergeRunHandle(current, run);
    setSessionActiveRun(merged);
    activeRunSessionId.value = merged.sessionId;
  };

  const markRunCompleted = (runId: string, exitCode: number | null, finishedAt: string): void => {
    if (activeRun.value?.runId === runId) {
      activeRunSessionId.value = null;
    }
    removeSessionActiveRunByRunId(runId);
    diagnostics.value.lastRunId = runId;
    diagnostics.value.lastExitCode = exitCode;
    diagnostics.value.lastCompletedAt = finishedAt;
    markEvent('terminal:run-completed');
  };

  const markRunDispatchFailed = (runId: string): void => {
    if (activeRun.value?.runId === runId) {
      activeRunSessionId.value = null;
    }
    removeSessionActiveRunByRunId(runId);
    diagnostics.value.lastRunId = runId;
    diagnostics.value.lastExitCode = null;
    diagnostics.value.lastCompletedAt = null;
    markEvent('terminal:run-dispatch-failed');
  };

  const applyStateChanged = (payload: {
    from: TTerminalRuntimeState;
    to: TTerminalRuntimeState;
    atMs: number;
  }): void => {
    state.value = payload.to;
    if (payload.to === 'idle_interactive') {
      interactiveReady.value = true;
    } else if (payload.to === 'booting') {
      interactiveReady.value = false;
    }
    markEvent(`terminal:state-changed:${payload.from}->${payload.to}`);
  };

  // -- per-session state (P0 多会话地基) ---------------------------------------

  /**
   * 收到某会话的状态转移。Vue 对 Map.set/delete 有响应性,原地更新即可触发
   * 依赖 sessionStates 的 computed / watcher。后端仅在发生合法转移时发事件,
   * 所以这里不再校验转移合法性,只记录目标态。
   */
  const applySessionStateChanged = (payload: ITerminalSessionStateChangedPayload): void => {
    sessionStates.value.set(payload.sessionId, payload.to);
    markEvent(`terminal:session-state-changed:${payload.sessionId}:${payload.from}->${payload.to}`);
  };

  /** 会话退出 / 关闭时清除其镜像态,避免遗留陈旧会话。 */
  const clearSessionState = (sessionId: string): void => {
    sessionStates.value.delete(sessionId);
    // 同步清理该会话的活动运行镜像 (FE-1)：会话退出后其运行不可能再收输入。
    sessionActiveRuns.value.delete(sessionId);
    // 全局指针指向已清理会话时同步收敛,使派生的 activeRun 回落为 null。
    if (activeRunSessionId.value === sessionId) {
      activeRunSessionId.value = null;
    }
  };

  const getSessionState = (sessionId: string): TTerminalRuntimeState | null =>
    sessionStates.value.get(sessionId) ?? null;

  // -- raw data ingest -------------------------------------------------------

  const recordTerminalData = (payload: ITerminalDataEvent): void => {
    if (!deepDiagnosticsEnabled.value) return;

    diagnostics.value.terminalDataChunks += 1;
    diagnostics.value.terminalDataBytes += measureBytes(payload.data);
    diagnostics.value.lastTerminalDataSeq = numericOrNull(payload.seq);

    pushRecentFrame(
      diagnostics.value.recentTerminalData,
      payload,
      diagnostics.value.terminalDataChunks,
    );

    if (payload.source === INJECTED_RESET_SOURCE) {
      diagnostics.value.injectedResetEvents += 1;
    } else if (payload.source === INJECTED_SEPARATOR_SOURCE) {
      diagnostics.value.injectedSeparatorEvents += 1;
    }

    markEvent(payload.source ? `terminal:data:${payload.source}` : 'terminal:data');
  };

  const recordVisualWrite = (payload: ITerminalVisualWritePayload): void => {
    if (!deepDiagnosticsEnabled.value) return;

    diagnostics.value.visualWriteChunks += 1;
    diagnostics.value.visualWriteBytes += measureBytes(payload.data);

    pushRecentFrame(
      diagnostics.value.recentVisualWrites,
      payload,
      diagnostics.value.visualWriteChunks,
    );

    markEvent(payload.source ? `xterm:write:${payload.source}` : 'xterm:write');
  };

  const recordBufferDiagnostic = (payload: ITerminalBufferDiagnostic): void => {
    if (!deepDiagnosticsEnabled.value) return;
    appendCapped(diagnostics.value.bufferDiagnostics, payload, MAX_BUFFER_DIAGNOSTICS);
    markEvent(`xterm:buffer:${payload.label}`);
  };

  const recordCancelRequested = (): void => {
    if (!deepDiagnosticsEnabled.value) return;
    diagnostics.value.cancelRequestedAt = nowIso();
    markEvent('cancel_terminal_run');
  };

  const recordInputRoute = (route: TTerminalInputRoute, data: Uint8Array): void => {
    if (!deepDiagnosticsEnabled.value) return;
    diagnostics.value.inputEvents += 1;
    diagnostics.value.lastInputRoute = route;
    if (route === 'dropped') {
      diagnostics.value.droppedInputEvents += 1;
    }
    markEvent(`terminal:input:${route}:${measureBytes(data)}`);
  };

  // -- toggles & reset -------------------------------------------------------

  const setRunSeparatorVisible = (visible: boolean): void => {
    showRunSeparator.value = visible;
    markEvent(visible ? 'terminal:separator-visible' : 'terminal:separator-hidden');
  };

  const setDeepDiagnosticsEnabled = (enabled: boolean): void => {
    deepDiagnosticsEnabled.value = enabled;
    // markEvent is gated by the flag, so this only stamps when enabling.
    markEvent('terminal:diagnostics-enabled');
  };

  const reset = (): void => {
    state.value = 'booting';
    activeRunSessionId.value = null;
    interactiveReady.value = false;
    sessionStates.value = new Map();
    sessionActiveRuns.value = new Map();
    diagnostics.value = createEmptyDiagnostics();
  };

  return {
    state,
    activeRun,
    interactiveReady,
    showRunSeparator,
    deepDiagnosticsEnabled,
    diagnostics,
    sessionStates,
    sessionActiveRuns,
    isRunning,
    markInteractiveReady,
    markInteractiveExited,
    markRunStarted,
    updateActiveRun,
    markRunCompleted,
    markRunDispatchFailed,
    applyStateChanged,
    applySessionStateChanged,
    clearSessionState,
    getSessionState,
    getSessionActiveRun,
    recordTerminalData,
    recordVisualWrite,
    recordBufferDiagnostic,
    recordCancelRequested,
    recordInputRoute,
    setRunSeparatorVisible,
    setDeepDiagnosticsEnabled,
    reset,
  };
});
