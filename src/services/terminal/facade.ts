import { storeToRefs } from 'pinia';
import { type DeepReadonly, type Ref, readonly } from 'vue';

import { tauriService } from '@/services/tauri';
import { getTerminalEventBus, type ITerminalEventBus } from '@/services/terminal/eventBus';
import { createTerminalRunStore, type TerminalRunStore } from '@/services/terminal/runStore';
import { useTerminalRuntimeStore } from '@/services/terminal/state';
import type { ITauriService } from '@/types/tauri';
import {
  DEFAULT_TERMINAL_SESSION_ID,
  type IDispatchTerminalScriptRequest,
  type ITerminalDataEvent,
  type ITerminalRunHandle,
  type ITerminalRunStartedPayload,
  type TTerminalCancelMode,
  type TTerminalRuntimeState,
} from '@/types/terminal';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 28;
const SWITCHING_INPUT_BUFFER_MS = 200;

/** 模块级共享,避免每次 writeInput 都重建 (高频键盘输入路径)。 */
const sharedInputDecoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TTerminalDataHandler = (payload: ITerminalDataEvent) => void;
export type TTerminalUnsubscribe = () => void;

export interface ITerminalFacade {
  ensureView(): Promise<void>;
  dispatchScript(spec: IDispatchTerminalScriptRequest): Promise<ITerminalRunHandle>;
  cancelRun(runId: string, mode: TTerminalCancelMode): Promise<void>;
  writeInput(sessionId: string, data: Uint8Array): Promise<void>;
  writeInputForCurrentState(data: Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  routeInput(state: TTerminalRuntimeState, activeRun: ITerminalRunHandle | null): string | null;
  onTerminalData(handler: TTerminalDataHandler): TTerminalUnsubscribe;
  dispose(): void;
  readonly state: DeepReadonly<Ref<TTerminalRuntimeState>>;
  readonly activeRun: DeepReadonly<Ref<ITerminalRunHandle | null>>;
  readonly interactiveReady: DeepReadonly<Ref<boolean>>;
}

export interface ITerminalFacadeOptions {
  tauri?: Pick<
    ITauriService,
    | 'ensureTerminalSession'
    | 'dispatchScriptToTerminal'
    | 'cancelTerminalRun'
    | 'writeTerminalInput'
    | 'resizeTerminalSession'
  >;
  eventBus?: ITerminalEventBus;
  runStore?: TerminalRunStore;
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

export const useTerminalFacade = (options: ITerminalFacadeOptions = {}): ITerminalFacade => {
  const runtimeStore = useTerminalRuntimeStore();
  const { state, activeRun, interactiveReady } = storeToRefs(runtimeStore);

  const tauri = options.tauri ?? tauriService;
  const eventBus = options.eventBus ?? getTerminalEventBus();
  const runStore = options.runStore ?? createTerminalRunStore();
  const interactiveSessionId = options.sessionId ?? DEFAULT_TERMINAL_SESSION_ID;

  const terminalDataHandlers = new Set<TTerminalDataHandler>();
  const switchingInputBuffer: Uint8Array[] = [];

  let eventBridgeStarted = false;
  let inputBufferTimerId: number | null = null;

  let terminalDataUnlisten: TTerminalUnsubscribe | null = null;
  let runChunkUnlisten: TTerminalUnsubscribe | null = null;
  let runStartedUnlisten: TTerminalUnsubscribe | null = null;
  let runCompletedUnlisten: TTerminalUnsubscribe | null = null;
  let interactiveReadyUnlisten: TTerminalUnsubscribe | null = null;
  let interactiveExitedUnlisten: TTerminalUnsubscribe | null = null;
  let stateChangedUnlisten: TTerminalUnsubscribe | null = null;
  let eventBridgePromise: Promise<void> | null = null;

  /**
   * 两端同步协议:
   *
   *  - `pendingRunHandles`:dispatch IPC 返回后塞入,直到 run-started 事件
   *    到达且完成 activate 后才删除。
   *  - `pendingRunStartedPayloads`:run-started 事件到达**但 dispatch 还没
   *    返回**时缓存。dispatch 返回后,如果发现这里已有 payload,就用完整
   *    handle + cached payload 一次性 activate,**不会**用空占位先启动一次。
   *
   * 关键不变量:`runStore.startRun(handle)` 在一次 run 的生命周期里**最多
   * 被调用一次**,且 handle 永远是完整 (来自 dispatch IPC 的真实数据)。
   */
  const pendingRunHandles = new Map<string, ITerminalRunHandle>();
  const pendingRunStartedPayloads = new Map<string, ITerminalRunStartedPayload>();

  const buildRunStartedHandle = (
    payload: ITerminalRunStartedPayload,
    pendingHandle: ITerminalRunHandle,
  ): ITerminalRunHandle => ({
    runId: payload.runId,
    sessionId: payload.sessionId,
    cwd: pendingHandle.cwd,
    commandLine: pendingHandle.commandLine,
    usedTempFile: pendingHandle.usedTempFile,
    startedAt: pendingHandle.startedAt,
    startedAtMs: payload.startedAtMs,
    pid: payload.pid,
  });

  /**
   * 数据齐全后启动 run。要求 pending handle 已存在 (即 dispatch IPC 已返回)。
   * 单次入口,确保 runStore.startRun + markRunStarted 各调用一次。
   */
  const activateStartedRun = (payload: ITerminalRunStartedPayload): void => {
    const pendingHandle = pendingRunHandles.get(payload.runId);
    if (!pendingHandle) {
      // 不应该走到这里:onRunStarted 在没有 pending 时只缓存不激活;
      // 真到了这里说明协议被绕过了 (例如外部调 activate),记录但不崩。
      console.warn(
        '[terminal-facade] activateStartedRun called without pending handle',
        payload.runId,
      );
      return;
    }
    const handle = buildRunStartedHandle(payload, pendingHandle);
    runStore.startRun(handle);
    runtimeStore.markRunStarted(handle);
    pendingRunStartedPayloads.delete(payload.runId);
  };

  const clearInputBufferTimer = (): void => {
    if (inputBufferTimerId === null) {
      return;
    }
    window.clearTimeout(inputBufferTimerId);
    inputBufferTimerId = null;
  };

  const flushSwitchingInputBuffer = async (): Promise<void> => {
    clearInputBufferTimer();
    const targetSessionId = routeInput(state.value, activeRun.value);
    if (!targetSessionId) {
      switchingInputBuffer.length = 0;
      console.warn('[terminal-facade] switching 状态超过缓冲窗口,已丢弃输入。');
      return;
    }
    const queued = switchingInputBuffer.splice(0);
    for (const item of queued) {
      await writeInput(targetSessionId, item);
    }
  };

  const scheduleSwitchingInputFlush = (): void => {
    clearInputBufferTimer();
    inputBufferTimerId = window.setTimeout(() => {
      void flushSwitchingInputBuffer();
    }, SWITCHING_INPUT_BUFFER_MS);
  };

  /** 单条 handler 抛错隔离,防止一个订阅者把所有人一起拉下水。 */
  const emitTerminalData = (payload: ITerminalDataEvent): void => {
    for (const handler of terminalDataHandlers) {
      try {
        handler(payload);
      } catch (error) {
        console.error('[terminal-facade] data handler 抛错,已隔离', error);
      }
    }
  };

  const ensureEventBridge = async (): Promise<void> => {
    if (eventBridgeStarted) {
      return;
    }
    if (eventBridgePromise) {
      return eventBridgePromise;
    }

    if (!terminalDataUnlisten) {
      terminalDataUnlisten = eventBus.onTerminalData(emitTerminalData);
    }
    if (!runChunkUnlisten) {
      runChunkUnlisten = eventBus.onRunChunk((payload) => {
        runtimeStore.recordRunChunk(payload.runId, payload.data);
        runStore.appendChunk(payload);
      });
    }
    if (!runStartedUnlisten) {
      runStartedUnlisten = eventBus.onRunStarted((payload) => {
        // R1+R2 修复:只在 dispatch 已返回 (pending handle 存在) 时才
        // activate;否则只缓存 payload,等 dispatchScript 完成后处理。
        if (pendingRunHandles.has(payload.runId)) {
          activateStartedRun(payload);
        } else {
          pendingRunStartedPayloads.set(payload.runId, payload);
        }
      });
    }
    if (!runCompletedUnlisten) {
      runCompletedUnlisten = eventBus.onRunCompleted((payload) => {
        runStore.completeRun(payload);
        runtimeStore.markRunCompleted(payload.runId, payload.exitCode, payload.finishedAt);
        pendingRunHandles.delete(payload.runId);
        pendingRunStartedPayloads.delete(payload.runId);
      });
    }
    if (!interactiveReadyUnlisten) {
      interactiveReadyUnlisten = eventBus.onInteractiveReady(() => {
        runtimeStore.markInteractiveReady();
      });
    }
    if (!interactiveExitedUnlisten) {
      interactiveExitedUnlisten = eventBus.onInteractiveExited((payload) => {
        if (payload.sessionId === interactiveSessionId) {
          runtimeStore.markInteractiveExited();
        }
      });
    }
    if (!stateChangedUnlisten) {
      stateChangedUnlisten = eventBus.onStateChanged((payload) => {
        runtimeStore.applyStateChanged(payload);
        if (switchingInputBuffer.length > 0 && routeInput(state.value, activeRun.value)) {
          void flushSwitchingInputBuffer();
        }
      });
    }

    eventBridgePromise = eventBus
      .start()
      .then(() => {
        eventBridgeStarted = true;
      })
      .catch((error: unknown) => {
        terminalDataUnlisten?.();
        runChunkUnlisten?.();
        runStartedUnlisten?.();
        runCompletedUnlisten?.();
        interactiveReadyUnlisten?.();
        interactiveExitedUnlisten?.();
        stateChangedUnlisten?.();
        terminalDataUnlisten = null;
        runChunkUnlisten = null;
        runStartedUnlisten = null;
        runCompletedUnlisten = null;
        interactiveReadyUnlisten = null;
        interactiveExitedUnlisten = null;
        stateChangedUnlisten = null;
        throw error;
      })
      .finally(() => {
        eventBridgePromise = null;
      });

    return eventBridgePromise;
  };

  const ensureView = async (): Promise<void> => {
    await ensureEventBridge();
    await tauri.ensureTerminalSession({
      sessionId: interactiveSessionId,
      cwd: null,
      cols: DEFAULT_TERMINAL_COLS,
      rows: DEFAULT_TERMINAL_ROWS,
    });
  };

  const dispatchScript = async (
    spec: IDispatchTerminalScriptRequest,
  ): Promise<ITerminalRunHandle> => {
    await ensureEventBridge();
    try {
      const payload = await tauri.dispatchScriptToTerminal(spec);
      const handle: ITerminalRunHandle = {
        runId: spec.runId,
        sessionId: payload.sessionId,
        cwd: payload.cwd,
        commandLine: payload.commandLine,
        usedTempFile: payload.usedTempFile,
        startedAt: payload.startedAt,
      };
      pendingRunHandles.set(spec.runId, handle);

      // R1+R2 修复:不在此处调用 runStore.startRun。等 run-started 事件
      // 到达后,activateStartedRun 才是唯一的 startRun 入口。
      const startedPayload = pendingRunStartedPayloads.get(spec.runId);
      if (startedPayload) {
        // 事件先到达 (已缓存),现在 handle 齐了 → 立即 activate。
        activateStartedRun(startedPayload);
      } else {
        // 事件还没到。让 UI 先知道有个 pending run,等事件到再 markRunStarted。
        runtimeStore.updateActiveRun(handle);
      }

      return handle;
    } catch (error) {
      // dispatch IPC 失败:run 从未真正 started。这里 markRunCompleted
      // 的语义是"清掉 UI 中的 pending 态"。如果 runtimeStore 把它视作
      // 一次"完成的 run"并记入历史,该改成专用的 markRunDispatchFailed。
      // 当前保持原行为。
      runtimeStore.markRunCompleted(spec.runId, null, new Date().toISOString());
      pendingRunHandles.delete(spec.runId);
      pendingRunStartedPayloads.delete(spec.runId);
      throw error;
    }
  };

  const cancelRun = (runId: string, mode: TTerminalCancelMode): Promise<void> => {
    runtimeStore.recordCancelRequested(mode);
    return tauri.cancelTerminalRun({ runId, mode });
  };

  const writeInput = async (sessionId: string, data: Uint8Array): Promise<void> => {
    await tauri.writeTerminalInput({
      sessionId,
      data: sharedInputDecoder.decode(data),
    });
  };

  const routeInput = (
    currentState: TTerminalRuntimeState,
    currentActiveRun: ITerminalRunHandle | null,
  ): string | null => {
    if (currentState === 'idle_interactive') {
      return interactiveSessionId;
    }
    if (currentState === 'running') {
      return currentActiveRun?.sessionId ?? null;
    }
    return null;
  };

  const writeInputForCurrentState = async (data: Uint8Array): Promise<void> => {
    const targetSessionId = routeInput(state.value, activeRun.value);
    if (targetSessionId) {
      runtimeStore.recordInputRoute(state.value === 'running' ? 'run' : 'interactive', data);
      await writeInput(targetSessionId, data);
      return;
    }
    if (state.value === 'switching_to_run' || state.value === 'switching_to_idle') {
      runtimeStore.recordInputRoute('buffered', data);
      switchingInputBuffer.push(data);
      scheduleSwitchingInputFlush();
      return;
    }
    runtimeStore.recordInputRoute('dropped', data);
    console.warn('[terminal-facade] 终端尚未 ready,已丢弃输入。');
  };

  const resize = (cols: number, rows: number): Promise<void> =>
    tauri.resizeTerminalSession({
      sessionId: interactiveSessionId,
      cols,
      rows,
    });

  const onTerminalData = (handler: TTerminalDataHandler): TTerminalUnsubscribe => {
    terminalDataHandlers.add(handler);
    return () => {
      terminalDataHandlers.delete(handler);
    };
  };

  /**
   * 释放本 facade 实例。
   *
   * **不会**调用 `eventBus.stop()`——eventBus 是 module-level 单例,可能被
   * 其他 facade 实例共享 (多窗口、AI Agent 终端等)。本 facade 只清理自己
   * 注册的 handler,让 eventBus 的生命周期跟随应用本身。
   */
  const dispose = (): void => {
    clearInputBufferTimer();
    switchingInputBuffer.length = 0;
    terminalDataHandlers.clear();
    terminalDataUnlisten?.();
    runChunkUnlisten?.();
    runStartedUnlisten?.();
    runCompletedUnlisten?.();
    interactiveReadyUnlisten?.();
    interactiveExitedUnlisten?.();
    stateChangedUnlisten?.();
    terminalDataUnlisten = null;
    runChunkUnlisten = null;
    runStartedUnlisten = null;
    runCompletedUnlisten = null;
    interactiveReadyUnlisten = null;
    interactiveExitedUnlisten = null;
    stateChangedUnlisten = null;
    pendingRunHandles.clear();
    pendingRunStartedPayloads.clear();
    eventBridgeStarted = false;
    eventBridgePromise = null;
    // 故意不调用 eventBus.stop() —— 见上方 jsdoc。
  };

  return {
    ensureView,
    dispatchScript,
    cancelRun,
    writeInput,
    writeInputForCurrentState,
    resize,
    routeInput,
    onTerminalData,
    dispose,
    state: readonly(state),
    activeRun: readonly(activeRun),
    interactiveReady: readonly(interactiveReady),
  };
};
