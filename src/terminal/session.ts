/**
 * src/terminal/session.ts
 * TerminalSession：终端会话核心实现（R-20.2.1 / R-20.2.3）。
 * 持有全部会话状态；与 UI 层解耦，可通过构造参数注入 fake 服务用于单测（R-20.2.6）。
 *
 * 职责拆分：
 *   - session-constants.ts     → 常量与类型别名
 *   - session-ansi.ts          → ANSI 纯函数与预编译正则
 *   - session-types.ts         → 公共接口与内部类型
 *   - session-helpers.ts       → 选项构建器、主题、诊断 helper
 *   - terminal-write-buffer.ts → 写缓冲管理器（rAF/timeout flush、隐藏积压）
 *   - run-visual-sequencer.ts  → Run 可视化帧序列重排器
 *   - session.ts（本文件）     → TerminalSession 协调者：布局/视口、事件、PTY、生命周期
 */

import type { UnlistenFn } from '@tauri-apps/api/event';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { consola } from 'consola';
import { markRaw, nextTick, type Ref, ref, shallowRef } from 'vue';
import { loadTauriEvent } from '@/services/tauri/core/ipc-runtime';
import type { TThemeMode } from '@/types/app';
import type { ITerminalSettings } from '@/types/settings';
import type {
  ITerminalBufferDiagnostic,
  ITerminalDataEvent,
  ITerminalExitEvent,
  ITerminalInputRoutePayload,
  ITerminalRunCompletedPayload,
  ITerminalSessionPayload,
  ITerminalStatusChangePayload,
  ITerminalVisualWritePayload,
  TTerminalConnectionState,
  TTerminalInputRoute,
} from '@/types/terminal';
import { toErrorMessage } from '@/utils/error/error';
import { readClipboardText, writeClipboardText } from '@/utils/platform/clipboard';
import { waitForDesktopRuntime } from '@/utils/platform/desktop-runtime';
import {
  SHELL_WINDOW_RESIZE_END_EVENT,
  SHELL_WINDOW_RESIZE_FRAME_EVENT,
  SHELL_WINDOW_RESIZE_SETTLED_EVENT,
  SHELL_WINDOW_RESIZE_START_EVENT,
} from '@/utils/window/window-resize-events';
import { RunVisualSequencer } from './run-visual-sequencer';
import {
  isLikelyInteractiveResizeRepaintFrame,
  previewTerminalDiagnosticText,
  scanInteractiveAltScreenSwitch,
} from './session-ansi';
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MIN_RENDERABLE_TERMINAL_HEIGHT,
  MIN_RENDERABLE_TERMINAL_WIDTH,
  TERMINAL_BELL_VISUAL_FLASH_MS,
  TERMINAL_BUFFER_DIAGNOSTIC_LINE_COUNT,
  TERMINAL_COLD_START_HINT_DELAY_MS,
  TERMINAL_HEARTBEAT_INTERVAL_MS,
  TERMINAL_LAYOUT_SCROLL_GUARD_RELEASE_MS,
  TERMINAL_LAYOUT_SETTLE_DELAY_MS,
  TERMINAL_LIVE_RESIZE_PTY_SYNC_DELAY_MS,
  TERMINAL_LIVE_RESIZE_REFRESH_EVERY,
  TERMINAL_RENDERABLE_CONTENT_SCAN_ROWS,
  TERMINAL_RESIZE_REPAINT_SUPPRESSION_MS,
  TERMINAL_RUN_COMPLETED_FLUSH_TIMEOUT_MS,
  type TTerminalLayoutSyncOptions,
} from './session-constants';
import {
  buildTerminalOptions,
  encodeTerminalInputForDiagnostics,
  getXtermTheme,
  isInteractiveChannelClosedError,
  isPrintableTerminalInput,
  resolveInteger,
  resolveTerminalBellStyle,
} from './session-helpers';
import type {
  ITerminalSessionCallbacks,
  ITerminalSessionOptions,
  ITerminalTauriService,
} from './session-types';
import { TerminalWriteBuffer } from './terminal-write-buffer';

// ─── Re-export 公共 API（保持消费者导入路径不变） ──────────────────────────────

export {
  normalizeTerminalAnsiForTheme,
  stripInjectedRunSeparatorForTerminalData,
} from './session-ansi';
export type {
  ITerminalSessionCallbacks,
  ITerminalSessionOptions,
  ITerminalTauriService,
} from './session-types';

// ─── TerminalSession 类 ───────────────────────────────────────────────────────

// 终端会话错误日志统一走 consola（与 IPC 层 consola.withTag('ipc') 同口径）。
const terminalLogger = consola.withTag('terminal');

// PTY 列宽/行高的合法区间常量：取代散落的魔法数字，集中表达约束。
const TERMINAL_MIN_COLS = 2;
const TERMINAL_MAX_COLS = 5000;
const TERMINAL_MIN_ROWS = 1;
const TERMINAL_MAX_ROWS = 3000;

/**
 * 终端会话实体，遵循 R-20.2.3 定义的接口契约；一个实例对应一个 PTY 连接。
 */
export class TerminalSession {
  // ── 公共响应式状态 ─────────────────────────────────────────────────────────
  readonly id: string;
  readonly status: Ref<TTerminalConnectionState>;
  readonly statusMessage: Ref<string>;
  readonly session: Ref<ITerminalSessionPayload | null>;

  // ── 私有：服务依赖 ─────────────────────────────────────────────────────────
  private readonly _tauri: ITerminalTauriService;
  private readonly _resetOrphanedBackendSession: boolean;

  // ── 私有：回调 ────────────────────────────────────────────────────────────
  private _onStatusChange: ((p: ITerminalStatusChangePayload) => void) | null = null;
  private _onRunCompleted: ((p: ITerminalRunCompletedPayload) => void) | null = null;
  private _onInputRoute: ((p: ITerminalInputRoutePayload) => void) | null = null;
  private _onTerminalData: ((p: ITerminalDataEvent) => void) | null = null;
  private _onVisualWrite: ((p: ITerminalVisualWritePayload) => void) | null = null;
  private _onBufferDiagnostic: ((p: ITerminalBufferDiagnostic) => void) | null = null;
  private _onTitleChange: ((title: string) => void) | null = null;

  // ── 私有：xterm 实例 ────────────────────────────────────────────────────────
  private _terminalRef = shallowRef<Terminal | null>(null);
  private _fitAddonRef = shallowRef<FitAddon | null>(null);

  // ── 私有：DOM ───────────────────────────────────────────────────────────────
  private _hostEl: HTMLElement | null = null;

  // ── 私有：主题与设置（UI 层传入） ───────────────────────────────────────────
  private _theme: TThemeMode = 'dark';
  private _settings: ITerminalSettings | null = null;

  // -- Private: visibility --------------------------------------------------
  private _visible = false;
  private _showRunSeparator = true;

  // ── 私有：定时器（布局/视口） ────────────────────────────────────────────────
  private _layoutFrameId: number | null = null;
  private _layoutSettleTimeoutId: number | null = null;
  private _viewportFrameId: number | null = null;
  private _programmaticScrollReleaseFrameId: number | null = null;
  private _scrollRecoveryTimeoutId: number | null = null;
  private _layoutScrollGuardTimeoutId: number | null = null;
  private _liveResizePtySyncTimeoutId: number | null = null;
  private _liveResizeFrameCounter = 0;
  private _pendingLiveResizePtySize: { cols: number; rows: number } | null = null;

  // -- Private: Tauri event listeners --------------------------------------
  private _dataUnlisten: UnlistenFn | null = null;
  private _runCompletedUnlisten: UnlistenFn | null = null;
  private _exitUnlisten: UnlistenFn | null = null;
  private _eventListenerRegistration: Promise<void> | null = null;
  private _listenerVersion = 0;

  // ── 私有：DOM 副作用清理函数 ───────────────────────────────────────────────
  private _fontLoadingCleanup: (() => void) | null = null;
  private _visibilityChangeCleanup: (() => void) | null = null;
  private _windowFocusCleanup: (() => void) | null = null;
  private _windowResizeCleanup: (() => void) | null = null;
  private _shellWindowResizeCleanup: (() => void) | null = null;
  private _resizeObserver: ResizeObserver | null = null;

  // ── 私有：bell ─────────────────────────────────────────────────────────────
  private _bellUnsubscribe: (() => void) | null = null;

  // ── 私有：视口同步标记 ─────────────────────────────────────────────────────
  private _shouldClearTextureAtlasOnViewportSync = false;
  private _shouldRefreshViewportOnViewportSync = false;
  private _shouldScrollToBottomOnViewportSync = false;
  private _pendingLayoutSettleSync = false;
  private _isShellWindowResizing = false;
  private _pendingLayoutAfterShellWindowResize = false;

  // -- Private: terminal state flags ---------------------------------------
  private _isProgrammaticScrollSync = false;
  private _isAutoFollowEnabled = true;
  private _keepViewportAtBottomDuringLayout = false;
  private _interactiveAltScreenActive = false;
  private _interactiveResizeRepaintSuppressUntilMs = 0;

  // -- Private: run tracking ------------------------------------------------
  private _activeRunId: string | null = null;

  // -- Private: liveness heartbeat -----------------------------------------
  private _heartbeatTimerId: number | null = null;

  private _previousHostSize = { width: 0, height: 0 };
  private _previousTerminalSize = { cols: 0, rows: 0 };

  // ── 私有：委托模块 ──────────────────────────────────────────────────────────
  private readonly _writeBuffer: TerminalWriteBuffer;
  private readonly _runSequencer: RunVisualSequencer;

  // -- Constructor ----------------------------------------------------------

  constructor(options: ITerminalSessionOptions) {
    this.id = options.sessionId;
    this.status = options.statusRef ?? ref<TTerminalConnectionState>('connecting');
    this.statusMessage = options.statusMessageRef ?? ref('正在连接 WSL2 终端…');
    this.session = ref<ITerminalSessionPayload | null>(null);
    this._tauri = options.tauriService;
    this._resetOrphanedBackendSession = options.resetOrphanedBackendSession ?? false;
    this._onStatusChange = options.onStatusChange ?? null;
    this._onRunCompleted = options.onRunCompleted ?? null;
    this._onInputRoute = options.onInputRoute ?? null;
    this._onTerminalData = options.onTerminalData ?? null;
    this._onVisualWrite = options.onVisualWrite ?? null;
    this._onBufferDiagnostic = options.onBufferDiagnostic ?? null;
    this._onTitleChange = options.onTitleChange ?? null;

    // 写缓冲管理器：注入对外部状态的惰性访问与回调
    this._writeBuffer = new TerminalWriteBuffer({
      getTerminal: () => this._terminalRef.value,
      isVisible: () => this._visible,
      isShellWindowResizing: () => this._isShellWindowResizing,
      getThemeMode: () => this._theme,
      getShowRunSeparator: () => this._showRunSeparator,
      syncTerminalLayout: () => this._syncTerminalLayout(),
      scheduleViewportSync: (opts) => this._scheduleViewportSync(opts),
      emitBufferDiagnostic: (label, preview) => this._emitBufferDiagnostic(label, preview),
      emitVisualWrite: (payload) => this._emitVisualWrite(payload),
      hasTerminalRenderableContent: () => this._hasTerminalRenderableContent(),
    });

    // Run 可视化序列器：排好序的帧传给写缓冲
    this._runSequencer = new RunVisualSequencer({
      writePayload: (payload) => this._writeTerminalDataPayload(payload),
    });
  }

  // -- Public: update callbacks --------------------------------------------

  updateCallbacks(callbacks: ITerminalSessionCallbacks): void {
    this._onStatusChange = callbacks.onStatusChange ?? null;
    this._onRunCompleted = callbacks.onRunCompleted ?? null;
    this._onInputRoute = callbacks.onInputRoute ?? null;
    this._onTerminalData = callbacks.onTerminalData ?? null;
    this._onVisualWrite = callbacks.onVisualWrite ?? null;
    this._onBufferDiagnostic = callbacks.onBufferDiagnostic ?? null;
    this._onTitleChange = callbacks.onTitleChange ?? null;
  }

  setRunSeparatorVisible(visible: boolean): void {
    this._showRunSeparator = visible;
  }

  // -- Public: initialize and attach to DOM --------------------------------

  initWithHost(el: HTMLElement, theme: TThemeMode, settings: ITerminalSettings): void {
    this._hostEl = el;
    this._theme = theme;
    this._settings = settings;
    const hadTerminal = this._terminalRef.value !== null;
    this._createTerminal();
    if (hadTerminal) {
      this._applyTerminalSettings();
    }
  }

  // -- Public: set visibility ----------------------------------------------

  setVisible(visible: boolean): void {
    this._visible = visible;
  }

  applySettings(theme: TThemeMode, settings: ITerminalSettings): void {
    this._theme = theme;
    this._settings = settings;
    this._applyTerminalSettings();
  }

  handleBecomeVisible(): void {
    this._createTerminal();
    this._syncTerminalSurfaceTone();
    this._scheduleLayoutSync({ settle: true });
    this._scheduleViewportSync({
      clearTextureAtlas: true,
      refresh: true,
      scrollToBottom: true,
    });
    this._writeBuffer.flushOnBecomeVisible();
    this.focusTerminal();
  }

  // -- Public: subscribe Tauri events --------------------------------------

  registerEventListeners(): Promise<void> {
    if (this._dataUnlisten && this._runCompletedUnlisten && this._exitUnlisten) {
      return Promise.resolve();
    }
    if (this._eventListenerRegistration) {
      return this._eventListenerRegistration;
    }
    const version = this._listenerVersion;
    this._eventListenerRegistration = (async () => {
      const runtimeReady = await waitForDesktopRuntime();
      if (!runtimeReady) return;
      const { listen } = await loadTauriEvent();
      const [dl, cl, el] = await Promise.all([
        listen<ITerminalDataEvent>('terminal:data', (e) => this._handleDataEvent(e)),
        listen<ITerminalRunCompletedPayload>('terminal:run-completed', (e) =>
          this._handleRunCompletedEvent(e),
        ),
        listen<ITerminalExitEvent>('terminal:interactive-exited', (e) => this._handleExitEvent(e)),
      ]);
      if (this._listenerVersion !== version) {
        dl();
        cl();
        el();
        return;
      }
      this._dataUnlisten = dl;
      this._runCompletedUnlisten = cl;
      this._exitUnlisten = el;
    })().finally(() => {
      this._eventListenerRegistration = null;
    });
    return this._eventListenerRegistration;
  }

  // -- Public: establish PTY connection ------------------------------------

  async ensureConnect(): Promise<void> {
    const runtimeReady = await waitForDesktopRuntime();
    if (!runtimeReady) {
      this._emitStatus('error', '内置终端仅支持 Tauri 桌面端。');
      return;
    }
    const terminal = this._terminalRef.value;
    if (!terminal) return;

    if (this.session.value) {
      this._emitStatus('ready', `${this.session.value.shellLabel} 已连接`);
      this._scheduleViewportSync({ scrollToBottom: true });
      if (this._visible) this.focusTerminal();
      return;
    }

    this._emitStatus('connecting', '正在启动 WSL…');
    await nextTick();
    this._emitBufferDiagnostic('ensure-connect:before-initial-layout');
    this._syncTerminalLayout();
    const coldStartHintTimerId =
      typeof window !== 'undefined'
        ? window.setTimeout(() => {
            if (this.status.value === 'connecting') {
              this._emitStatus('connecting', '正在启动 WSL…（首次启动可能较慢，请稍候）');
            }
          }, TERMINAL_COLD_START_HINT_DELAY_MS)
        : null;
    try {
      // 列宽/行高入参在两处 ensureTerminalSession 调用中完全一致，抽成 builder 防漂移；
      // 边界改用 #14 注入的具名常量。
      const buildEnsureArgs = () => ({
        sessionId: this.id,
        cwd: null,
        cols: resolveInteger(terminal.cols, DEFAULT_COLS, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS),
        rows: resolveInteger(terminal.rows, DEFAULT_ROWS, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS),
      });
      let payload = await this._tauri.ensureTerminalSession(buildEnsureArgs());
      if (!payload.created && this._resetOrphanedBackendSession) {
        await this._tauri.closeTerminalSession({ sessionId: this.id });
        payload = await this._tauri.ensureTerminalSession(buildEnsureArgs());
      }
      this.session.value = payload;
      this._startHeartbeat();
      this._emitBufferDiagnostic(
        payload.created
          ? 'ensure-connect:created-session'
          : 'ensure-connect:existing-session-before-replay',
        payload.initialOutput ?? null,
      );
      if (!payload.created && payload.initialOutput) {
        terminal.reset();
        this._writeBuffer.reset();
        this._isAutoFollowEnabled = true;
        this._writeBuffer.pendingInitialPaintRecovery = true;
        this._writeBuffer.write(payload.initialOutput, { scrollToBottom: true });
        this._writeBuffer.flushNow({ forceLayout: true });
        this._emitBufferDiagnostic('ensure-connect:existing-session-after-replay');
      }
      if (payload.created && !payload.initialOutput) {
        this._writeBuffer.pendingInitialPaintRecovery = true;
      }
      if (!payload.created && payload.activeRun) {
        this.trackRun(payload.activeRun.runId);
      }
      this._emitStatus('ready', `${payload.shellLabel} 已连接`);
      this._scheduleViewportSync({ scrollToBottom: true });
      if (this._visible) this.focusTerminal();
    } catch (error) {
      const message = toErrorMessage(error, '连接 WSL2 终端失败。');
      this._emitStatus('error', message);
      terminal.writeln(`\x1b[31m${message}\x1b[0m`, () => {
        this._scheduleViewportSync({ scrollToBottom: true });
      });
    } finally {
      if (coldStartHintTimerId !== null) {
        window.clearTimeout(coldStartHintTimerId);
      }
    }
  }

  // -- Public: retry connection --------------------------------------------

  async retry(): Promise<void> {
    this._terminalRef.value?.reset();
    this._resetTerminalRunCapture();
    if (this.session.value) {
      try {
        await this._tauri.closeTerminalSession({ sessionId: this.id });
      } catch {
        // 连接通道异常断开时关闭后端会话可能失败，直接进入重建流程。
      }
      this.session.value = null;
    }
    this._isAutoFollowEnabled = true;
    this._writeBuffer.pendingInitialPaintRecovery = true;
    await this.ensureConnect();
  }

  // -- Public: focus / selection / clipboard --------------------------------

  focusTerminal(): void {
    this._terminalRef.value?.focus();
  }

  getSelectionText(): string {
    const selection = this._terminalRef.value?.getSelection() ?? '';
    if (!selection) return '';
    return this._settings?.trimFinalNewlineOnCopy ? selection.replace(/[\r\n]+$/u, '') : selection;
  }

  async copySelection(): Promise<void> {
    const selection = this.getSelectionText();
    if (!selection) return;
    await writeClipboardText(selection);
    this.focusTerminal();
  }

  selectAll(): void {
    this._terminalRef.value?.selectAll();
    this.focusTerminal();
  }

  pasteText(text: string): void {
    if (!text) return;
    this._terminalRef.value?.paste(text);
    this._isAutoFollowEnabled = true;
    this._scheduleViewportSync({ scrollToBottom: true });
    this.focusTerminal();
  }

  async pasteFromClipboard(): Promise<void> {
    const text = await readClipboardText();
    this.pasteText(text);
  }

  // -- Public: clear screen -------------------------------------------------

  async clearScreen(): Promise<void> {
    this._terminalRef.value?.clear();
    this._isAutoFollowEnabled = true;
    this._scheduleViewportSync({ scrollToBottom: true, refresh: true });
    if (!this.session.value) return;
    await this._tauri.writeTerminalInput({ sessionId: this.id, data: '\u000c' });
    this.focusTerminal();
  }

  // -- Public: interrupt / send command / send input ------------------------

  async interrupt(): Promise<void> {
    if (!this.session.value) return;
    await this._tauri.writeTerminalInput({ sessionId: this.id, data: '\u0003' });
    this._isAutoFollowEnabled = true;
    this._scheduleViewportSync({ scrollToBottom: true });
    this.focusTerminal();
  }

  async sendCommand(command: string): Promise<void> {
    const normalized = command.trim();
    if (!normalized) return;
    if (!this.session.value) await this.ensureConnect();
    if (!this.session.value) throw new Error('WSL2 终端尚未就绪。');
    await this._tauri.writeTerminalInput({ sessionId: this.id, data: `${normalized}\n` });
    this._isAutoFollowEnabled = true;
    this._scheduleViewportSync({ scrollToBottom: true });
    this.focusTerminal();
  }

  async sendInput(data: string): Promise<void> {
    if (!data) return;
    if (!this.session.value) await this.ensureConnect();
    if (!this.session.value) throw new Error('WSL2 终端尚未就绪。');
    await this._tauri.writeTerminalInput({ sessionId: this.id, data });
    this._isAutoFollowEnabled = true;
    this._scheduleViewportSync({ scrollToBottom: true });
    this.focusTerminal();
  }

  // -- Public: track run id -------------------------------------------------

  trackRun(nextRunId: string | null): void {
    if (this._activeRunId && this._activeRunId !== nextRunId) {
      this._emitRunCompleted(this._buildRunCompletedPayload(this._activeRunId, -1));
    }
    if (!nextRunId) {
      this._clearTrackedRunState();
      return;
    }
    this._emitBufferDiagnostic('track-run:before-running-state');
    this._activeRunId = nextRunId;
    this._isAutoFollowEnabled = true;
    this._scheduleLayoutSync();
    this._scheduleViewportSync({ scrollToBottom: true });
  }

  // -- Public: bind render recovery listeners ------------------------------

  bindRenderRecoveryListeners(): void {
    if (!this._windowFocusCleanup) {
      const handleWindowFocus = (): void => {
        if (!this._visible) return;
        this._scheduleLayoutSync({ settle: true });
        this._scheduleViewportSync({
          clearTextureAtlas: true,
          refresh: true,
          scrollToBottom: true,
        });
      };
      window.addEventListener('focus', handleWindowFocus);
      this._windowFocusCleanup = () => {
        window.removeEventListener('focus', handleWindowFocus);
        this._windowFocusCleanup = null;
      };
    }

    if (!this._visibilityChangeCleanup) {
      const handleDocVisChange = (): void => {
        if (document.visibilityState !== 'visible' || !this._visible) return;
        this._scheduleLayoutSync({ settle: true });
        this._scheduleViewportSync({
          clearTextureAtlas: true,
          refresh: true,
          scrollToBottom: true,
        });
      };
      document.addEventListener('visibilitychange', handleDocVisChange);
      this._visibilityChangeCleanup = () => {
        document.removeEventListener('visibilitychange', handleDocVisChange);
        this._visibilityChangeCleanup = null;
      };
    }

    if (!this._fontLoadingCleanup && typeof document !== 'undefined' && 'fonts' in document) {
      const fontSet = document.fonts;
      const handleFontMetricsReady = (): void => {
        if (!this._visible) return;
        this._scheduleLayoutSync({ settle: true });
        this._scheduleViewportSync({ refresh: true });
      };
      void fontSet.ready.then(() => handleFontMetricsReady());
      fontSet.addEventListener('loadingdone', handleFontMetricsReady);
      this._fontLoadingCleanup = () => {
        fontSet.removeEventListener('loadingdone', handleFontMetricsReady);
        this._fontLoadingCleanup = null;
      };
    }
  }

  // -- Public: detach DOM/listeners while keeping PTY ----------------------

  detach(): void {
    this._listenerVersion++;

    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._windowResizeCleanup?.();
    this._shellWindowResizeCleanup?.();
    this._windowFocusCleanup?.();
    this._visibilityChangeCleanup?.();
    this._fontLoadingCleanup?.();

    this._dataUnlisten?.();
    this._runCompletedUnlisten?.();
    this._exitUnlisten?.();
    this._dataUnlisten = null;
    this._runCompletedUnlisten = null;
    this._exitUnlisten = null;

    this._bellUnsubscribe?.();
    this._bellUnsubscribe = null;

    this._clearLayoutFrame();
    this._clearLayoutSettleTimeout();
    this._clearViewportFrame();
    this._clearProgrammaticScrollReleaseFrame();
    this._clearScrollRecoveryTimeout();
    this._clearLayoutScrollGuardTimeout();
    this._clearLiveResizePtySyncTimeout();

    this._writeBuffer.reset();
    this._runSequencer.clearAll();
    this._resetTerminalRunCapture();

    this._keepViewportAtBottomDuringLayout = false;
    this._interactiveResizeRepaintSuppressUntilMs = 0;
    this._liveResizeFrameCounter = 0;
    this._pendingLiveResizePtySize = null;
    this._previousHostSize = { width: 0, height: 0 };

    this._hostEl = null;
    this._visible = false;
  }

  // -- Public: dispose terminal instance -----------------------------------

  async dispose(): Promise<void> {
    this._stopHeartbeat();
    if (this.session.value) {
      try {
        await this._tauri.closeTerminalSession({ sessionId: this.id });
      } catch {
        // 通道可能已断开或会话已退出；继续前端拆卸即可。
      }
    }
    this.detach();
    this._terminalRef.value?.dispose();
    this._terminalRef.value = null;
    this._fitAddonRef.value = null;
    this.session.value = null;
  }

  // ── 私有：存活心跳 ───────────────────────────────────────────────────────────

  private _startHeartbeat(): void {
    if (this._heartbeatTimerId !== null) return;
    if (typeof window === 'undefined') return;
    this._heartbeatTimerId = window.setInterval(() => {
      if (!this.session.value) return;
      const pending = this._tauri.heartbeatTerminalSession?.({ sessionId: this.id });
      void pending?.catch(() => {});
    }, TERMINAL_HEARTBEAT_INTERVAL_MS);
  }

  private _stopHeartbeat(): void {
    if (this._heartbeatTimerId !== null) {
      window.clearInterval(this._heartbeatTimerId);
      this._heartbeatTimerId = null;
    }
  }

  // ── 私有：emit 方法 ──────────────────────────────────────────────────────────

  private _emitStatus(state: TTerminalConnectionState, message: string): void {
    this.status.value = state;
    this.statusMessage.value = message;
    this._onStatusChange?.({ state, message });
  }

  private _emitRunCompleted(payload: ITerminalRunCompletedPayload): void {
    this._onRunCompleted?.(payload);
  }

  private _emitInputRoute(route: TTerminalInputRoute, data: string): void {
    this._onInputRoute?.({ route, data: encodeTerminalInputForDiagnostics(data) });
  }

  private _emitVisualWrite(payload: ITerminalVisualWritePayload): void {
    this._onVisualWrite?.(payload);
  }

  private _emitTitleChange(title: string): void {
    this._onTitleChange?.(title);
  }

  private _emitTerminalDataReceived(payload: ITerminalDataEvent): void {
    this._onTerminalData?.(payload);
  }

  private _emitBufferDiagnostic(label: string, writePreview?: string | null): void {
    if (!this._onBufferDiagnostic) return;
    const diagnostic = this._buildBufferDiagnostic(label, writePreview ?? null);
    if (diagnostic) this._onBufferDiagnostic(diagnostic);
  }

  private _buildBufferDiagnostic(
    label: string,
    writePreview: string | null,
  ): ITerminalBufferDiagnostic | null {
    const terminal = this._terminalRef.value;
    if (!terminal) return null;

    const buffer = terminal.buffer.active;
    const cursorLineIndex = Math.max(0, buffer.baseY + buffer.cursorY);
    const bufferLength = Math.max(0, buffer.length);
    const lastIndex = bufferLength > 0 ? Math.min(bufferLength - 1, cursorLineIndex) : 0;
    const startIndex = Math.max(0, lastIndex - TERMINAL_BUFFER_DIAGNOSTIC_LINE_COUNT + 1);
    const lastLines: string[] = [];
    for (let index = startIndex; index <= lastIndex; index += 1) {
      const line = buffer.getLine(index)?.translateToString(true) ?? '';
      lastLines.push(`${index}:${line}`);
    }

    return {
      label,
      at: new Date().toISOString(),
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      baseY: buffer.baseY,
      viewportY: buffer.viewportY,
      rows: terminal.rows,
      cols: terminal.cols,
      bufferLength,
      visible: this._visible,
      activeRunId: this._activeRunId,
      pendingWriteChars: this._writeBuffer.pendingWriteChars,
      hiddenBacklogChars: this._writeBuffer.hiddenBacklogChars,
      hostWidth: this._hostEl?.clientWidth ?? null,
      hostHeight: this._hostEl?.clientHeight ?? null,
      writePreview: writePreview === null ? null : previewTerminalDiagnosticText(writePreview),
      lastLines,
    };
  }

  // ── 私有：定时器清理 ─────────────────────────────────────────────────────────

  private _clearLayoutFrame(): void {
    if (this._layoutFrameId !== null) {
      cancelAnimationFrame(this._layoutFrameId);
      this._layoutFrameId = null;
    }
  }
  private _clearViewportFrame(): void {
    if (this._viewportFrameId !== null) {
      cancelAnimationFrame(this._viewportFrameId);
      this._viewportFrameId = null;
    }
  }
  private _clearLayoutSettleTimeout(): void {
    if (this._layoutSettleTimeoutId !== null) {
      window.clearTimeout(this._layoutSettleTimeoutId);
      this._layoutSettleTimeoutId = null;
    }
  }
  private _clearScrollRecoveryTimeout(): void {
    if (this._scrollRecoveryTimeoutId !== null) {
      window.clearTimeout(this._scrollRecoveryTimeoutId);
      this._scrollRecoveryTimeoutId = null;
    }
  }
  private _clearLayoutScrollGuardTimeout(): void {
    if (this._layoutScrollGuardTimeoutId !== null) {
      window.clearTimeout(this._layoutScrollGuardTimeoutId);
      this._layoutScrollGuardTimeoutId = null;
    }
  }
  private _clearLiveResizePtySyncTimeout(): void {
    if (this._liveResizePtySyncTimeoutId !== null) {
      window.clearTimeout(this._liveResizePtySyncTimeoutId);
      this._liveResizePtySyncTimeoutId = null;
    }
  }
  private _clearProgrammaticScrollReleaseFrame(): void {
    if (this._programmaticScrollReleaseFrameId !== null) {
      cancelAnimationFrame(this._programmaticScrollReleaseFrameId);
      this._programmaticScrollReleaseFrameId = null;
    }
  }

  // -- Private: layout and viewport scheduling -----------------------------

  private _handleShellWindowResizeStart(): void {
    this._isShellWindowResizing = true;
    this._pendingLayoutAfterShellWindowResize = false;
    this._liveResizeFrameCounter = 0;
    this._pendingLiveResizePtySize = null;
    this._clearLiveResizePtySyncTimeout();
    this._clearLayoutFrame();
    this._clearLayoutSettleTimeout();
    this._clearViewportFrame();
  }

  private _handleShellWindowResizeEnd(): void {
    const shouldRelayout = this._pendingLayoutAfterShellWindowResize || this._hostEl !== null;
    this._pendingLayoutAfterShellWindowResize = shouldRelayout;
  }

  private _handleShellWindowResizeFrame(): void {
    if (!this._visible) return;
    const hostEl = this._hostEl;
    if (!hostEl) return;
    if (!this._didHostSizeChange(hostEl.clientWidth, hostEl.clientHeight)) return;
    this._pendingLayoutAfterShellWindowResize = true;
    this._scheduleLiveResizeLayoutSync();
  }

  private _scheduleLiveResizeLayoutSync(): void {
    if (this._layoutFrameId !== null) return;
    this._layoutFrameId = requestAnimationFrame(() => {
      this._layoutFrameId = null;
      this._syncTerminalLayoutDuringShellWindowResize();
    });
  }

  private _syncTerminalLayoutDuringShellWindowResize(): void {
    const terminal = this._terminalRef.value;
    const fitAddon = this._fitAddonRef.value;
    const hostEl = this._hostEl;
    if (!terminal || !fitAddon || !hostEl || !this._visible) return;
    if (
      hostEl.clientWidth < MIN_RENDERABLE_TERMINAL_WIDTH ||
      hostEl.clientHeight < MIN_RENDERABLE_TERMINAL_HEIGHT
    )
      return;

    try {
      const prevCols = terminal.cols;
      const prevRows = terminal.rows;
      const shouldKeepViewportAtBottom =
        this._visible && (this._isAutoFollowEnabled || this._isViewportNearBottom(terminal));
      this._beginLayoutScrollGuard(shouldKeepViewportAtBottom);
      this._runWithProgrammaticScrollLock(() => fitAddon.fit());

      this._liveResizeFrameCounter += 1;
      const shouldRefresh =
        terminal.cols !== prevCols ||
        terminal.rows !== prevRows ||
        this._liveResizeFrameCounter % TERMINAL_LIVE_RESIZE_REFRESH_EVERY === 0;

      this._scheduleViewportSync({
        forceDuringResize: true,
        refresh: shouldRefresh,
        scrollToBottom: shouldKeepViewportAtBottom,
      });
    } catch (error) {
      terminalLogger.warn('终端 live resize 尺寸同步失败', error);
    } finally {
      this._endLayoutScrollGuardSoon();
    }
  }

  private _scheduleLiveResizePtySizeSync(cols: number, rows: number): void {
    this._pendingLiveResizePtySize = { cols, rows };
    if (this._liveResizePtySyncTimeoutId !== null) return;
    this._liveResizePtySyncTimeoutId = window.setTimeout(() => {
      this._liveResizePtySyncTimeoutId = null;
      this._flushPendingLiveResizePtySize();
    }, TERMINAL_LIVE_RESIZE_PTY_SYNC_DELAY_MS);
  }

  private _flushPendingLiveResizePtySize(): void {
    this._clearLiveResizePtySyncTimeout();
    const size = this._pendingLiveResizePtySize;
    this._pendingLiveResizePtySize = null;
    if (!size) return;
    this._syncPtySize(size.cols, size.rows);
  }

  private _handleShellWindowResizeSettled(): void {
    this._isShellWindowResizing = false;
    this._flushPendingLiveResizePtySize();
    if (!this._visible) return;

    const shouldRelayout = this._pendingLayoutAfterShellWindowResize || this._hostEl !== null;
    this._pendingLayoutAfterShellWindowResize = false;

    if (shouldRelayout) {
      this._scheduleLayoutSync({ settle: true });
      this._scheduleViewportSync({ refresh: true, scrollToBottom: true });
    }

    if (this._writeBuffer.hasPendingWrite || this._writeBuffer.hasPendingCallbacks) {
      this._writeBuffer.scheduleFlush();
    }
  }

  private _scheduleLayoutSync(options?: TTerminalLayoutSyncOptions): void {
    if (options?.settle) this._pendingLayoutSettleSync = true;
    this._clearLayoutSettleTimeout();
    if (this._isShellWindowResizing) {
      this._pendingLayoutAfterShellWindowResize = true;
      return;
    }
    if (this._layoutFrameId !== null) return;
    this._layoutFrameId = requestAnimationFrame(() => {
      this._layoutFrameId = null;
      this._syncTerminalLayout();
      if (!this._pendingLayoutSettleSync) return;
      this._pendingLayoutSettleSync = false;
      this._layoutSettleTimeoutId = window.setTimeout(() => {
        this._layoutSettleTimeoutId = null;
        this._syncTerminalLayout();
      }, TERMINAL_LAYOUT_SETTLE_DELAY_MS);
    });
  }

  private _syncTerminalLayout(): void {
    if (this._isShellWindowResizing) {
      this._pendingLayoutAfterShellWindowResize = true;
      return;
    }

    const terminal = this._terminalRef.value;
    const fitAddon = this._fitAddonRef.value;
    const hostEl = this._hostEl;
    if (!terminal || !fitAddon || !hostEl) return;
    if (
      hostEl.clientWidth < MIN_RENDERABLE_TERMINAL_WIDTH ||
      hostEl.clientHeight < MIN_RENDERABLE_TERMINAL_HEIGHT
    )
      return;
    try {
      const prevCols = terminal.cols;
      const prevRows = terminal.rows;
      const shouldKeepViewportAtBottom =
        this._visible && (this._isAutoFollowEnabled || this._isViewportNearBottom(terminal));
      this._beginLayoutScrollGuard(shouldKeepViewportAtBottom);
      this._emitBufferDiagnostic(`layout:before-fit:${prevCols}x${prevRows}`);
      this._runWithProgrammaticScrollLock(() => fitAddon.fit());
      if (shouldKeepViewportAtBottom) this._isAutoFollowEnabled = true;
      if (terminal.cols === prevCols && terminal.rows === prevRows) {
        if (shouldKeepViewportAtBottom) this._scheduleViewportSync({ scrollToBottom: true });
        return;
      }
      this._emitBufferDiagnostic(`layout:after-fit:${terminal.cols}x${terminal.rows}`);
      if (!this._didTerminalSizeChange(terminal.cols, terminal.rows)) {
        if (shouldKeepViewportAtBottom) this._scheduleViewportSync({ scrollToBottom: true });
        return;
      }
      this._scheduleViewportSync({ scrollToBottom: shouldKeepViewportAtBottom });
      this._markInteractiveResizeRepaintSuppression();
      this._syncPtySize(terminal.cols, terminal.rows);
    } catch (error) {
      terminalLogger.warn('终端尺寸同步失败', error);
    } finally {
      this._endLayoutScrollGuardSoon();
    }
  }

  private _syncPtySize(cols: number, rows: number): void {
    if (!this.session.value) return;
    void this._tauri.resizeTerminalSession({ sessionId: this.id, cols, rows }).catch((error) => {
      terminalLogger.warn('终端 PTY 尺寸同步失败', { sessionId: this.id, cols, rows, error });
    });
  }

  private _scheduleViewportSync(options?: {
    clearTextureAtlas?: boolean;
    refresh?: boolean;
    scrollToBottom?: boolean;
    forceDuringResize?: boolean;
  }): void {
    if (options?.clearTextureAtlas) this._shouldClearTextureAtlasOnViewportSync = true;
    if (options?.refresh) this._shouldRefreshViewportOnViewportSync = true;
    if (options?.scrollToBottom) this._shouldScrollToBottomOnViewportSync = true;
    if (this._isShellWindowResizing && !options?.forceDuringResize) return;
    this._clearViewportFrame();
    this._viewportFrameId = requestAnimationFrame(() => {
      this._viewportFrameId = null;
      this._refreshTerminalViewportNow();
    });
  }

  private _refreshTerminalViewportNow(): void {
    const terminal = this._terminalRef.value;
    const shouldClearAtlas = this._shouldClearTextureAtlasOnViewportSync;
    const shouldRefresh = this._shouldRefreshViewportOnViewportSync || shouldClearAtlas;
    const shouldScrollToBottom = this._shouldScrollToBottomOnViewportSync;
    this._shouldClearTextureAtlasOnViewportSync = false;
    this._shouldRefreshViewportOnViewportSync = false;
    this._shouldScrollToBottomOnViewportSync = false;
    if (!terminal) return;
    if (shouldClearAtlas) this._clearTerminalTextureAtlas();
    if (
      shouldScrollToBottom &&
      this._visible &&
      this._isAutoFollowEnabled &&
      !this._isViewportNearBottom(terminal)
    ) {
      this._runWithProgrammaticScrollLock(() => terminal.scrollToBottom());
    }
    if (shouldRefresh) terminal.refresh(0, Math.max(terminal.rows - 1, 0));
  }

  // -- Private: write helpers (delegated to TerminalWriteBuffer) -----------

  private _writeTerminalDataPayload(payload: ITerminalDataEvent): void {
    this._writeBuffer.writeDataPayload(payload);
  }

  // -- Private: terminal event handling ------------------------------------

  private _handleDataEvent(event: { payload: ITerminalDataEvent }): void {
    if (event.payload.sessionId !== this.id || !event.payload.data) return;
    this._emitTerminalDataReceived(event.payload);
    if (
      event.payload.source === 'run' ||
      event.payload.source === 'injected_reset' ||
      event.payload.source === 'injected_separator'
    ) {
      this._runSequencer.handlePayload(event.payload);
      return;
    }

    if (event.payload.source === 'interactive' || !event.payload.source) {
      const wasAltScreenActive = this._interactiveAltScreenActive;
      const altScreen = scanInteractiveAltScreenSwitch(
        this._interactiveAltScreenActive,
        event.payload.data,
      );
      this._interactiveAltScreenActive = altScreen.activeAfter;
      if (
        !wasAltScreenActive &&
        !altScreen.switched &&
        this._shouldSuppressInteractiveResizeRepaint(event.payload.data, altScreen.switched)
      ) {
        this._emitBufferDiagnostic('interactive-resize-repaint-suppressed', event.payload.data);
        return;
      }
    }

    if (this._activeRunId && (event.payload.source === 'interactive' || !event.payload.source)) {
      this._emitBufferDiagnostic('interactive-frame-suppressed-during-run', event.payload.data);
      return;
    }

    this._writeTerminalDataPayload(event.payload);
  }

  private _handleRunCompletedEvent(event: { payload: ITerminalRunCompletedPayload }): void {
    if (event.payload.sessionId !== this.id) return;
    this._emitTerminalRunCompleted(event.payload);
  }

  private _handleExitEvent(event: { payload: ITerminalExitEvent }): void {
    if (event.payload.sessionId !== this.id) return;
    this.session.value = null;
    this._interactiveAltScreenActive = false;
    this._interactiveResizeRepaintSuppressUntilMs = 0;
    const message =
      event.payload.exitCode === null
        ? 'WSL2 终端已断开。'
        : `WSL2 终端已退出（代码 ${event.payload.exitCode}）。`;
    if (this._activeRunId) {
      this._emitRunCompleted(
        this._buildRunCompletedPayload(this._activeRunId, event.payload.exitCode ?? -1),
      );
      this._resetTerminalRunCapture();
    }
    this._writeBuffer.write(`\r\n\x1b[90m${message}\x1b[0m\r\n`, { scrollToBottom: true });
    this._writeBuffer.flushNow();
    this._scheduleViewportSync({ scrollToBottom: true });
    this._emitStatus('closed', message);
  }

  private _emitTerminalRunCompleted(payload: ITerminalRunCompletedPayload): void {
    this._clearTrackedRunState(payload.runId);
    if (!this._visible) {
      this._emitRunCompleted(payload);
      return;
    }
    let didEmit = false;
    let fallbackId: number | null = null;
    const finalize = (): void => {
      if (didEmit) return;
      didEmit = true;
      if (fallbackId !== null) {
        window.clearTimeout(fallbackId);
        fallbackId = null;
      }
      this._emitRunCompleted(payload);
    };
    fallbackId = window.setTimeout(() => finalize(), TERMINAL_RUN_COMPLETED_FLUSH_TIMEOUT_MS);
    this.focusTerminal();
    this._writeBuffer.flushNow({
      afterWrite: () => {
        this._scheduleViewportSync({ scrollToBottom: true });
        finalize();
      },
      forceLayout: true,
    });
  }

  // -- Private: run tracking ------------------------------------------------

  private _buildRunCompletedPayload(
    runId: string,
    exitCode: number | null,
  ): ITerminalRunCompletedPayload {
    return {
      sessionId: this.id,
      runId,
      exitCode,
      finishedAt: new Date().toISOString(),
    };
  }

  private _clearTrackedRunState(runId?: string): void {
    if (runId && this._activeRunId !== runId) return;
    this._activeRunId = null;
  }

  private _resetTerminalRunCapture(): void {
    this._clearTrackedRunState();
    this._runSequencer.clearAll();
  }

  private _clearTerminalTextureAtlas(): void {
    this._terminalRef.value?.clearTextureAtlas();
  }

  // -- Private: viewport helpers -------------------------------------------

  private _isViewportNearBottom(terminal: Terminal): boolean {
    const buffer = terminal.buffer.active;
    return buffer.baseY - buffer.viewportY <= 1;
  }

  private _releaseProgrammaticScrollLock(): void {
    this._clearProgrammaticScrollReleaseFrame();
    this._programmaticScrollReleaseFrameId = requestAnimationFrame(() => {
      this._isProgrammaticScrollSync = false;
      this._programmaticScrollReleaseFrameId = null;
    });
  }

  private _runWithProgrammaticScrollLock(callback: () => void): void {
    this._isProgrammaticScrollSync = true;
    try {
      callback();
    } finally {
      this._releaseProgrammaticScrollLock();
    }
  }

  private _beginLayoutScrollGuard(shouldKeepViewportAtBottom: boolean): void {
    this._clearLayoutScrollGuardTimeout();
    this._keepViewportAtBottomDuringLayout = shouldKeepViewportAtBottom;
  }

  private _endLayoutScrollGuardSoon(): void {
    if (!this._keepViewportAtBottomDuringLayout) return;
    this._clearLayoutScrollGuardTimeout();
    this._layoutScrollGuardTimeoutId = window.setTimeout(() => {
      this._keepViewportAtBottomDuringLayout = false;
      this._layoutScrollGuardTimeoutId = null;
    }, TERMINAL_LAYOUT_SCROLL_GUARD_RELEASE_MS);
  }

  private _markInteractiveResizeRepaintSuppression(): void {
    this._interactiveResizeRepaintSuppressUntilMs =
      Date.now() + TERMINAL_RESIZE_REPAINT_SUPPRESSION_MS;
  }

  private _shouldSuppressInteractiveResizeRepaint(
    data: string,
    hasAltScreenControl: boolean,
  ): boolean {
    if (this._interactiveAltScreenActive) return false;
    if (Date.now() > this._interactiveResizeRepaintSuppressUntilMs) return false;
    if (hasAltScreenControl) return false;
    return isLikelyInteractiveResizeRepaintFrame(data);
  }

  private _hasTerminalRenderableContent(): boolean {
    const terminal = this._terminalRef.value;
    if (!terminal) return false;
    const buf = terminal.buffer.active;
    const bufferLength = buf.length;
    if (bufferLength <= 0) return false;
    const cursorLineIndex = Math.max(0, buf.baseY + buf.cursorY);
    const lastIndex = Math.min(bufferLength - 1, cursorLineIndex);
    const firstIndex = Math.max(0, lastIndex - TERMINAL_RENDERABLE_CONTENT_SCAN_ROWS + 1);
    for (let i = lastIndex; i >= firstIndex; i -= 1) {
      const line = buf.getLine(i);
      if (line?.translateToString(true).trim().length) return true;
    }
    return false;
  }

  // -- Private: appearance sync --------------------------------------------

  private _syncTerminalSurfaceTone(): void {
    const theme = getXtermTheme(this._theme);
    const background = theme.background ?? '#ffffff';
    const cursor = theme.cursor ?? '#000000';
    const cursorAccent = theme.cursorAccent ?? '#ffffff';
    const applySurfaceStyle = (element: HTMLElement): void => {
      element.style.setProperty('--terminal-fill', background);
      element.style.setProperty('--terminal-cursor', cursor);
      element.style.setProperty('--terminal-cursor-accent', cursorAccent);
      element.style.setProperty('background-color', background, 'important');
    };
    if (this._hostEl) {
      applySurfaceStyle(this._hostEl);
      const shell = this._hostEl.closest('.embedded-terminal-shell');
      if (shell instanceof HTMLElement) applySurfaceStyle(shell);
      for (const element of this._hostEl.querySelectorAll<HTMLElement>(
        '.xterm, .xterm-viewport, .xterm-scroll-area, .xterm-screen, .xterm-screen canvas',
      )) {
        applySurfaceStyle(element);
      }
    }
    if (this._terminalRef.value?.element) {
      applySurfaceStyle(this._terminalRef.value.element);
    }
  }

  private _applyTerminalSettings(): void {
    const terminal = this._terminalRef.value;
    if (!terminal || !this._settings) return;
    const opts = buildTerminalOptions(this._settings, this._theme);
    terminal.options.theme = opts.theme;
    terminal.options.fontFamily = opts.fontFamily;
    terminal.options.fontSize = opts.fontSize;
    terminal.options.lineHeight = opts.lineHeight;
    terminal.options.cursorBlink = opts.cursorBlink;
    terminal.options.cursorStyle = opts.cursorStyle;
    terminal.options.scrollback = opts.scrollback;
    this._syncTerminalSurfaceTone();
    terminal.refresh(0, Math.max(0, terminal.rows - 1));
    this._scheduleLayoutSync({ settle: true });
    this._scheduleViewportSync({ clearTextureAtlas: true, refresh: true });
    this._applyBellBehavior();
  }

  // ── 私有：bell ─────────────────────────────────────────────────────────────

  private _applyBellBehavior(): void {
    const terminal = this._terminalRef.value;
    this._bellUnsubscribe?.();
    this._bellUnsubscribe = null;
    if (!terminal || !this._settings) return;

    const mode = resolveTerminalBellStyle(this._settings.bellMode);
    if (mode === 'none') return;

    const disposable = terminal.onBell(() => {
      if (mode === 'sound') return;
      const host = this._hostEl;
      if (!host) return;
      host.classList.add('terminal-bell-flash');
      window.setTimeout(
        () => host.classList.remove('terminal-bell-flash'),
        TERMINAL_BELL_VISUAL_FLASH_MS,
      );
    });
    this._bellUnsubscribe = () => disposable.dispose();
  }

  // ── 私有：剪贴板 ─────────────────────────────────────────────────────────────

  private async _writeSelectionToClipboard(): Promise<void> {
    if (!this._terminalRef.value || !this._settings?.copyOnSelect) return;
    const selection = this.getSelectionText();
    if (!selection) return;
    void writeClipboardText(selection).catch(() => {});
  }

  // ── 私有：ResizeObserver 绑定 ─────────────────────────────────────────────────

  private _bindResizeObserver(): void {
    if (typeof ResizeObserver === 'undefined' || !this._hostEl) return;
    this._resizeObserver?.disconnect();
    this._resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || !this._didHostSizeChange(entry.contentRect.width, entry.contentRect.height))
        return;
      if (this._visible) {
        if (this._isShellWindowResizing) {
          this._pendingLayoutAfterShellWindowResize = true;
          return;
        }
        this._scheduleLayoutSync();
      }
    });
    this._resizeObserver.observe(this._hostEl);

    if (!this._shellWindowResizeCleanup) {
      const handleShellWindowResizeStart = (): void => this._handleShellWindowResizeStart();
      const handleShellWindowResizeEnd = (): void => this._handleShellWindowResizeEnd();
      const handleShellWindowResizeFrame = (): void => this._handleShellWindowResizeFrame();
      const handleShellWindowResizeSettled = (): void => this._handleShellWindowResizeSettled();
      window.addEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);
      window.addEventListener(SHELL_WINDOW_RESIZE_FRAME_EVENT, handleShellWindowResizeFrame);
      window.addEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleShellWindowResizeEnd);
      window.addEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);
      this._shellWindowResizeCleanup = () => {
        window.removeEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);
        window.removeEventListener(SHELL_WINDOW_RESIZE_FRAME_EVENT, handleShellWindowResizeFrame);
        window.removeEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleShellWindowResizeEnd);
        window.removeEventListener(
          SHELL_WINDOW_RESIZE_SETTLED_EVENT,
          handleShellWindowResizeSettled,
        );
        this._shellWindowResizeCleanup = null;
      };
    }

    if (this._windowResizeCleanup) return;
    const handleWindowResize = (): void => {
      if (!this._visible) return;
      if (this._isShellWindowResizing) {
        this._pendingLayoutAfterShellWindowResize = true;
        return;
      }
      const el = this._hostEl;
      if (!el || !this._didHostSizeChange(el.clientWidth, el.clientHeight)) return;
      this._scheduleLayoutSync();
    };
    window.addEventListener('resize', handleWindowResize);
    this._windowResizeCleanup = () => {
      window.removeEventListener('resize', handleWindowResize);
      this._windowResizeCleanup = null;
    };
  }

  // -- Private: size change detection --------------------------------------

  private _didHostSizeChange(width: number, height: number): boolean {
    const w = Math.round(width);
    const h = Math.round(height);
    if (w <= 0 || h <= 0) return false;
    if (this._previousHostSize.width === w && this._previousHostSize.height === h) return false;
    this._previousHostSize = { width: w, height: h };
    return true;
  }

  private _didTerminalSizeChange(cols: number, rows: number): boolean {
    const c = Math.max(0, Math.trunc(cols));
    const r = Math.max(0, Math.trunc(rows));
    if (c <= 0 || r <= 0) return false;
    if (this._previousTerminalSize.cols === c && this._previousTerminalSize.rows === r)
      return false;
    this._previousTerminalSize = { cols: c, rows: r };
    return true;
  }

  // -- Private: terminal creation ------------------------------------------

  private _attachTerminalToHost(): void {
    const terminal = this._terminalRef.value;
    const host = this._hostEl;
    if (!terminal || !host) return;
    if (!terminal.element) {
      terminal.open(host);
    } else if (terminal.element.parentElement !== host) {
      host.replaceChildren(terminal.element);
    }
    this._previousHostSize = {
      width: Math.round(host.clientWidth),
      height: Math.round(host.clientHeight),
    };
    this._bindResizeObserver();
    this._syncTerminalSurfaceTone();
    this._writeBuffer.pendingInitialPaintRecovery = true;
    this._scheduleLayoutSync({ settle: true });
    this._scheduleViewportSync({ clearTextureAtlas: true, refresh: true, scrollToBottom: true });
    this._applyBellBehavior();
  }

  private _createTerminal(): void {
    if (!this._hostEl) return;
    if (!this._terminalRef.value) {
      if (!this._settings) this._failMissingSettings();
      const terminal = markRaw(new Terminal(buildTerminalOptions(this._settings, this._theme)));
      const fitAddon = markRaw(new FitAddon());
      terminal.loadAddon(fitAddon);
      this._terminalRef.value = terminal;
      this._fitAddonRef.value = fitAddon;
      this._previousTerminalSize = { cols: terminal.cols, rows: terminal.rows };

      terminal.onData((data) => {
        if (!this.session.value) return;
        if (isPrintableTerminalInput(data) || data === '\r' || data === '\n') {
          this._isAutoFollowEnabled = true;
        }
        this._emitInputRoute(this._activeRunId ? 'run' : 'interactive', data);
        void this._tauri
          .writeTerminalInput({ sessionId: this.id, data })
          .catch((error: unknown) => {
            if (isInteractiveChannelClosedError(error)) {
              this.session.value = null;
              const message = 'WSL Link interactive command channel 已关闭。';
              this._emitStatus('closed', message);
              this._writeBuffer.write(`\r\n\x1b[90m${message}\x1b[0m\r\n`, {
                scrollToBottom: true,
              });
              this._writeBuffer.flushNow();
              this._scheduleViewportSync({ scrollToBottom: true });
              return;
            }
            this._emitStatus('error', toErrorMessage(error, '终端输入发送失败。'));
          });
      });
      terminal.onScroll(() => {
        if (this._isProgrammaticScrollSync || this._keepViewportAtBottomDuringLayout) return;
        const t = this._terminalRef.value;
        if (!t) return;
        this._isAutoFollowEnabled = this._isViewportNearBottom(t);
        if (this._isAutoFollowEnabled) this._clearScrollRecoveryTimeout();
      });
      terminal.onResize(({ cols, rows }) => {
        if (!this._didTerminalSizeChange(cols, rows)) return;
        this._markInteractiveResizeRepaintSuppression();
        if (this._isShellWindowResizing) {
          this._scheduleViewportSync({
            forceDuringResize: true,
            refresh: this._liveResizeFrameCounter % TERMINAL_LIVE_RESIZE_REFRESH_EVERY === 0,
            scrollToBottom: true,
          });
          this._scheduleLiveResizePtySizeSync(cols, rows);
          return;
        }
        this._scheduleViewportSync({ scrollToBottom: true });
        this._syncPtySize(cols, rows);
      });
      terminal.onSelectionChange(() => void this._writeSelectionToClipboard());
      terminal.onTitleChange((title) => this._emitTitleChange(title));
    }
    this._attachTerminalToHost();
  }

  private _failMissingSettings(): never {
    throw new Error(
      '[terminal-session] _settings 缺失：请先调用 initWithHost(host, theme, settings) 再创建终端。',
    );
  }
}
