import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type {
  ITerminalBufferDiagnostic,
  ITerminalDataEvent,
  ITerminalRunHandle,
  ITerminalSessionStateChangedPayload,
  ITerminalStateChangedPayload,
  ITerminalVisualWritePayload,
  TTerminalCancelMode,
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
  runChunkCount: number;
  runChunkBytes: number;
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
  cancelMode: TTerminalCancelMode | null;
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

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const nowIso = (): string => new Date().toISOString();

const numericOrNull = (value: unknown): number | null => (typeof value === 'number' ? value : null);

const measureBytes = (value: string | Uint8Array): number => {
  if (value instanceof Uint8Array) {
    return value.byteLength;
  }
  return textEncoder ? textEncoder.encode(value).length : value.length;
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
  runChunkCount: 0,
  runChunkBytes: 0,
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
  cancelMode: null,
});

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useTerminalRuntimeStore = defineStore('terminal-runtime', () => {
  // -- state -----------------------------------------------------------------

  const state = ref<TTerminalRuntimeState>('booting');
  const activeRun = ref<ITerminalRunHandle | null>(null);
  const interactiveReady = ref(false);
  const showRunSeparator = ref(true);
  const deepDiagnosticsEnabled = ref(false);
  const diagnostics = ref<ITerminalFlowDiagnostics>(createEmptyDiagnostics());
  /**
   * 每会话运行态镜像 (P0 多会话地基)。后端按 session_id 发
   * `terminal:session-state-changed`,前端按会话存储,供未来多标签 UI 与
   * per-session 输入路由消费。与全局 `state` 并存——全局态会在后续 slice 退役。
   */
  const sessionStates = ref<Map<string, TTerminalRuntimeState>>(new Map());
  /**
   * 每会话活动运行句柄镜像 (FE-1 多会话)。全局 `activeRun` 仅能表达「最后一个」
   * 运行,多开并发运行时会互相覆盖,导致 routeInput 把会话 A 的输入误投到会话 B 的
   * run stdin。这里按 run 归属的 session_id 存句柄,使每个会话的输入路由读到「自己的」
   * 运行。与全局 `activeRun` 并存——全局态会在后续 slice 退役。
   *
   * 对照 VSCode ptyService.ts:每个 PersistentTerminalProcess 各自持有运行/交互态,
   * input/resize 全按 id 路由,不存在跨会话共享的单一活动运行。
   */
  const sessionActiveRuns = ref<Map<string, ITerminalRunHandle>>(new Map());

  // -- getters ---------------------------------------------------------------

  const isRunning = computed(() => state.value === 'running');

  // -- diagnostic markers ----------------------------------------------------

  const markEvent = (eventName: string): void => {
    if (!deepDiagnosticsEnabled.value) return;
    diagnostics.value.lastEventName = eventName;
    diagnostics.value.lastEventAt = nowIso();
  };

  // -- per-session active run helpers (FE-1 多会话) ---------------------------

  /** 写入/更新某会话的活动运行镜像。重新赋值 Map 以可靠触发依赖它的 computed/watcher。 */
  const setSessionActiveRun = (run: ITerminalRunHandle): void => {
    const next = new Map(sessionActiveRuns.value);
    next.set(run.sessionId, run);
    sessionActiveRuns.value = next;
  };

  /** 按 runId 移除活动运行镜像（运行完成/派发失败）。 */
  const removeSessionActiveRunByRunId = (runId: string): void => {
    let mutated = false;
    const next = new Map(sessionActiveRuns.value);
    for (const [sessionId, handle] of next) {
      if (handle.runId === runId) {
        next.delete(sessionId);
        mutated = true;
      }
    }
    if (mutated) {
      sessionActiveRuns.value = next;
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

  const markSwitchingToRun = (): void => {
    state.value = 'switching_to_run';
    markEvent('terminal:switching-to-run');
  };

  const markRunStarted = (run: ITerminalRunHandle): void => {
    // Same run id arriving again — patch the handle and bump diagnostics.
    if (activeRun.value?.runId === run.runId) {
      activeRun.value = mergeRunHandle(activeRun.value, run);
      setSessionActiveRun(activeRun.value);
      diagnostics.value.lastRunId = run.runId;
      markEvent('terminal:run-started');
      return;
    }

    // New run — snapshot current "recent" buffers as the pre-run history,
    // then start fresh diagnostics.
    const preRunTerminalData = diagnostics.value.recentTerminalData.slice();
    const preRunVisualWrites = diagnostics.value.recentVisualWrites.slice();
    const preRunBufferDiagnostics = diagnostics.value.bufferDiagnostics.slice();

    activeRun.value = run;
    setSessionActiveRun(run);
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
    if (activeRun.value?.runId !== run.runId) return;
    activeRun.value = mergeRunHandle(activeRun.value, run);
    setSessionActiveRun(activeRun.value);
  };

  const markSwitchingToIdle = (): void => {
    if (!activeRun.value) return;
    state.value = 'switching_to_idle';
    markEvent('terminal:switching-to-idle');
  };

  const markRunCompleted = (runId: string, exitCode: number | null, finishedAt: string): void => {
    if (activeRun.value?.runId === runId) {
      activeRun.value = null;
    }
    removeSessionActiveRunByRunId(runId);
    diagnostics.value.lastRunId = runId;
    diagnostics.value.lastExitCode = exitCode;
    diagnostics.value.lastCompletedAt = finishedAt;
    markEvent('terminal:run-completed');
  };

  const markRunDispatchFailed = (runId: string): void => {
    if (activeRun.value?.runId === runId) {
      activeRun.value = null;
    }
    removeSessionActiveRunByRunId(runId);
    diagnostics.value.lastRunId = runId;
    diagnostics.value.lastExitCode = null;
    diagnostics.value.lastCompletedAt = null;
    markEvent('terminal:run-dispatch-failed');
  };

  const applyStateChanged = (payload: ITerminalStateChangedPayload): void => {
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
   * 收到某会话的状态转移。重新赋值新 Map,确保依赖 sessionStates 的
   * computed / watcher 可靠触发。后端仅在发生合法转移时发事件,所以这
   * 里不再校验转移合法性,只记录目标态。
   */
  const applySessionStateChanged = (payload: ITerminalSessionStateChangedPayload): void => {
    const next = new Map(sessionStates.value);
    next.set(payload.sessionId, payload.to);
    sessionStates.value = next;
    markEvent(`terminal:session-state-changed:${payload.sessionId}:${payload.from}->${payload.to}`);
  };

  /** 会话退出 / 关闭时清除其镜像态,避免遗留陈旧会话。 */
  const clearSessionState = (sessionId: string): void => {
    if (sessionStates.value.has(sessionId)) {
      const next = new Map(sessionStates.value);
      next.delete(sessionId);
      sessionStates.value = next;
    }
    // 同步清理该会话的活动运行镜像 (FE-1)：会话退出后其运行不可能再收输入。
    if (sessionActiveRuns.value.has(sessionId)) {
      const nextRuns = new Map(sessionActiveRuns.value);
      nextRuns.delete(sessionId);
      sessionActiveRuns.value = nextRuns;
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

  const recordRunChunk = (runId: string, data: string): void => {
    if (!deepDiagnosticsEnabled.value) return;
    diagnostics.value.lastRunId = runId;
    diagnostics.value.runChunkCount += 1;
    diagnostics.value.runChunkBytes += measureBytes(data);
    markEvent('terminal:run-chunk');
  };

  const recordCancelRequested = (mode: TTerminalCancelMode): void => {
    if (!deepDiagnosticsEnabled.value) return;
    diagnostics.value.cancelMode = mode;
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
    activeRun.value = null;
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
    markSwitchingToRun,
    markRunStarted,
    updateActiveRun,
    markSwitchingToIdle,
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
    recordRunChunk,
    recordCancelRequested,
    recordInputRoute,
    setRunSeparatorVisible,
    setDeepDiagnosticsEnabled,
    reset,
  };
});
