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
import { createDisposableBag, createMutableDisposable } from '@/utils/core/disposable';
import { requestDisposableTimeout } from '@/utils/platform/dom-lifecycle';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 28;
const SWITCHING_INPUT_FLUSH_RETRY_MS = 50;
const SWITCHING_INPUT_BUFFER_MAX_BYTES = 64 * 1024;

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
  const inputDecodersBySession = new Map<string, TextDecoder>();
  const inputBufferTimer = createMutableDisposable();
  const eventBridgeListeners = createMutableDisposable();

  let eventBridgeStarted = false;
  let switchingInputBufferBytes = 0;
  let eventBridgePromise: Promise<void> | null = null;
  let eventBridgeVersion = 0;

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
    pendingRunHandles.delete(payload.runId);
    pendingRunStartedPayloads.delete(payload.runId);
  };

  const getInputDecoder = (sessionId: string): TextDecoder => {
    const existing = inputDecodersBySession.get(sessionId);
    if (existing) {
      return existing;
    }
    const decoder = new TextDecoder();
    inputDecodersBySession.set(sessionId, decoder);
    return decoder;
  };

  const clearInputDecoder = (sessionId: string): void => {
    inputDecodersBySession.delete(sessionId);
  };

  const clearInputBufferTimer = (): void => {
    inputBufferTimer.clear();
  };

  const scheduleSwitchingInputFlush = (): void => {
    clearInputBufferTimer();
    inputBufferTimer.set(
      requestDisposableTimeout(() => {
        inputBufferTimer.clearAndLeak();
        void flushSwitchingInputBuffer();
      }, SWITCHING_INPUT_FLUSH_RETRY_MS),
    );
  };

  const flushSwitchingInputBuffer = async (): Promise<void> => {
    clearInputBufferTimer();
    if (switchingInputBuffer.length === 0) {
      switchingInputBufferBytes = 0;
      return;
    }
    const targetSessionId = routeInput(currentSessionState(), activeRun.value);
    if (!targetSessionId) {
      scheduleSwitchingInputFlush();
      return;
    }

    const queued = switchingInputBuffer.splice(0);
    switchingInputBufferBytes = 0;
    for (let index = 0; index < queued.length; index += 1) {
      const item = queued[index];
      try {
        await writeInput(targetSessionId, item);
      } catch (error) {
        const remaining = queued.slice(index);
        switchingInputBuffer.unshift(...remaining);
        switchingInputBufferBytes += remaining.reduce(
          (total, chunk) => total + chunk.byteLength,
          0,
        );
        scheduleSwitchingInputFlush();
        throw error;
      }
    }
  };

  const queueSwitchingInput = (data: Uint8Array): boolean => {
    if (data.byteLength === 0) {
      return true;
    }
    const nextSize = switchingInputBufferBytes + data.byteLength;
    if (nextSize > SWITCHING_INPUT_BUFFER_MAX_BYTES) {
      console.error('[terminal-facade] switching 输入缓冲超过上限,已拒绝新的输入。', {
        currentBytes: switchingInputBufferBytes,
        incomingBytes: data.byteLength,
        maxBytes: SWITCHING_INPUT_BUFFER_MAX_BYTES,
      });
      return false;
    }
    switchingInputBuffer.push(data.slice());
    switchingInputBufferBytes = nextSize;
    scheduleSwitchingInputFlush();
    return true;
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

  const clearEventBridgeListeners = (): void => {
    eventBridgeVersion += 1;
    eventBridgeStarted = false;
    eventBridgeListeners.clear();
  };

  const ensureEventBridge = async (): Promise<void> => {
    if (eventBridgeStarted && eventBridgeListeners.value !== null) {
      return;
    }
    if (eventBridgePromise) {
      return eventBridgePromise;
    }

    const version = eventBridgeVersion;
    const listeners = createDisposableBag();
    listeners.add(eventBus.onTerminalData(emitTerminalData));
    listeners.add(
      eventBus.onRunChunk((payload) => {
        runtimeStore.recordRunChunk(payload.runId, payload.data);
        runStore.appendChunk(payload);
      }),
    );
    listeners.add(
      eventBus.onRunStarted((payload) => {
        // R1+R2 修复:只在 dispatch 已返回 (pending handle 存在) 时才
        // activate;否则只缓存 payload,等 dispatchScript 完成后处理。
        if (pendingRunHandles.has(payload.runId)) {
          activateStartedRun(payload);
        } else {
          pendingRunStartedPayloads.set(payload.runId, payload);
        }
      }),
    );
    listeners.add(
      eventBus.onRunCompleted((payload) => {
        runStore.completeRun(payload);
        runtimeStore.markRunCompleted(payload.runId, payload.exitCode, payload.finishedAt);
        pendingRunHandles.delete(payload.runId);
        pendingRunStartedPayloads.delete(payload.runId);
        clearInputDecoder(payload.sessionId);
      }),
    );
    listeners.add(
      eventBus.onInteractiveReady(() => {
        runtimeStore.markInteractiveReady();
      }),
    );
    listeners.add(
      eventBus.onInteractiveExited((payload) => {
        if (payload.sessionId === interactiveSessionId) {
          runtimeStore.markInteractiveExited();
        }
        runtimeStore.clearSessionState(payload.sessionId);
        clearInputDecoder(payload.sessionId);
      }),
    );
    listeners.add(
      eventBus.onStateChanged((payload) => {
        runtimeStore.applyStateChanged(payload);
        if (switchingInputBuffer.length > 0 && routeInput(currentSessionState(), activeRun.value)) {
          void flushSwitchingInputBuffer();
        }
      }),
    );
    listeners.add(
      eventBus.onSessionStateChanged((payload) => {
        // P0 多会话:按会话镜像运行态。输入路由的事实来源已迁到 per-session 态
        // (见 routeInput),故本会话切到可写态时也要补冲切换期缓冲的输入——多开时
        // 第二个并发运行只发 per-session 事件、不发全局事件,仅靠 onStateChanged
        // 无法触发补冲。仅响应「本 facade 自己会话」的转移,避免被其它会话误触发。
        runtimeStore.applySessionStateChanged(payload);
        if (
          payload.sessionId === interactiveSessionId &&
          switchingInputBuffer.length > 0 &&
          routeInput(currentSessionState(), activeRun.value)
        ) {
          void flushSwitchingInputBuffer();
        }
      }),
    );
    eventBridgeListeners.set(() => listeners.dispose());

    eventBridgePromise = eventBus
      .start()
      .then(() => {
        // `dispose()` may run while the shared event bus is still starting. Mirror
        // VS Code's version-token lifecycle guards: stale starts must not mark
        // this facade as started after its listeners were already disposed.
        if (eventBridgeVersion !== version || eventBridgeListeners.value === null) {
          return;
        }
        eventBridgeStarted = true;
      })
      .catch((error: unknown) => {
        if (eventBridgeVersion === version) {
          clearEventBridgeListeners();
        }
        throw error;
      })
      .finally(() => {
        if (eventBridgeVersion === version) {
          eventBridgePromise = null;
        }
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
      // dispatch IPC 失败表示 run 从未真正启动；使用专用状态标记避免把它
      // 误记成一次已完成运行。
      runtimeStore.markRunDispatchFailed(spec.runId);
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
      data: getInputDecoder(sessionId).decode(data, { stream: true }),
    });
  };

  const routeInput = (
    currentState: TTerminalRuntimeState,
    currentActiveRun: ITerminalRunHandle | null,
  ): string | null => {
    // P0 多会话:输入路由的事实来源迁到「本 facade 自己会话」的 per-session 态镜像,
    // 不再读单一全局 FSM(全局态无法同时表达多个会话:A 在 Running、B 在 Idle)。
    // 本会话的 per-session 镜像尚无记录时回退到全局态,保证迁移期 / 首个事件到达前的
    // 行为与改动前一致——与后端 get_session_state 无记录回退到全局 current_state 的语义
    // 对齐。对照 VSCode ptyService.ts:输入经 PtyService.input(id, data) 按 id 路由到对应
    // PersistentTerminalProcess,各进程依据自身交互 / 生命周期态收发,不存在跨会话共享的
    // 全局终端态。
    const sessionState = runtimeStore.getSessionState(interactiveSessionId) ?? currentState;
    if (sessionState === 'idle_interactive') {
      return interactiveSessionId;
    }
    if (sessionState === 'running') {
      // FE-1 多会话:优先读「本会话自己的」活动运行句柄,避免多开并发时全局
      // activeRun 被其它会话覆盖导致本会话输入被误投到别的会话的 run stdin。本会话
      // 尚无 per-session 运行镜像时回退到全局 activeRun,与改动前单会话语义一致。
      return (
        runtimeStore.getSessionActiveRun(interactiveSessionId)?.sessionId ??
        currentActiveRun?.sessionId ??
        null
      );
    }
    return null;
  };

  /**
   * 「本 facade 自己会话」的有效运行态:优先读 per-session 镜像,未命中回退全局态。
   * 与 routeInput 内部口径一致——全局 state 是单例,多开并发时会被其它会话覆盖,不能
   * 用来判定本会话的输入归属 / 缓冲。
   */
  const currentSessionState = (): TTerminalRuntimeState =>
    runtimeStore.getSessionState(interactiveSessionId) ?? state.value;

  const writeInputForCurrentState = async (data: Uint8Array): Promise<void> => {
    // FE-1 多会话:输入分流改用「本会话」有效态,不再读全局 state.value。否则会话 A 在
    // switching_to_run、而全局 state 已被会话 B 覆盖成别的态时,A 的输入会被错误丢弃 /
    // 错分流,而不是按 A 自己的切换态缓冲。
    const sessionState = currentSessionState();
    const targetSessionId = routeInput(sessionState, activeRun.value);
    if (targetSessionId) {
      runtimeStore.recordInputRoute(sessionState === 'running' ? 'run' : 'interactive', data);
      await writeInput(targetSessionId, data);
      return;
    }
    if (sessionState === 'switching_to_run' || sessionState === 'switching_to_idle') {
      if (queueSwitchingInput(data)) {
        runtimeStore.recordInputRoute('buffered', data);
      } else {
        runtimeStore.recordInputRoute('dropped', data);
      }
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
    switchingInputBufferBytes = 0;
    inputDecodersBySession.clear();
    terminalDataHandlers.clear();
    clearEventBridgeListeners();
    pendingRunHandles.clear();
    pendingRunStartedPayloads.clear();
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
