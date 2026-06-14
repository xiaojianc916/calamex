/**
 * src/terminal/session.ts
 * TerminalSession：终端会话核心实现（R-20.2.1 / R-20.2.3）。
 * 持有全部会话状态；与 UI 层解耦，可通过构造参数注入 fake 服务用于单测（R-20.2.6）。
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { markRaw, nextTick, type Ref, ref, shallowRef } from 'vue';
import { resolveTerminalFontFamily } from '@/constants/terminal';
import { getThemeManager } from '@/themes';
import { buildTerminalTheme } from '@/themes/derive/terminal';
import { dark } from '@/themes/variants/dark';
import { light } from '@/themes/variants/light';
import type { TThemeMode } from '@/types/app';
import type { ITerminalSettings } from '@/types/settings';
import type {
  ITerminalBufferDiagnostic,
  ITerminalDataEvent,
  ITerminalExitEvent,
  ITerminalInputRoutePayload,
  ITerminalRunChunkPayload,
  ITerminalRunCompletedPayload,
  ITerminalSessionPayload,
  ITerminalStateChangedPayload,
  ITerminalStatusChangePayload,
  ITerminalVisualWritePayload,
  TTerminalConnectionState,
  TTerminalInputRoute,
} from '@/types/terminal';
import { readClipboardText, writeClipboardText } from '@/utils/clipboard';
import { waitForDesktopRuntime } from '@/utils/desktop-runtime';
import { toErrorMessage } from '@/utils/error';
import { createHiddenWriteBacklog } from '@/utils/hidden-write-backlog';
import {
  SHELL_WINDOW_RESIZE_END_EVENT,
  SHELL_WINDOW_RESIZE_FRAME_EVENT,
  SHELL_WINDOW_RESIZE_SETTLED_EVENT,
  SHELL_WINDOW_RESIZE_START_EVENT,
} from '@/utils/window-resize-events';

// ─── 本地常量 ─────────────────────────────────────────────────────────────────

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 28;
const MIN_RENDERABLE_TERMINAL_WIDTH = 24;
const MIN_RENDERABLE_TERMINAL_HEIGHT = 24;
const TERMINAL_ENABLE_WEBGL_RENDERER = true;
const TERMINAL_WEBGL_RECOVERY_DELAY_MS = 180;
const TERMINAL_LAYOUT_SETTLE_DELAY_MS = 72;
const TERMINAL_OUTPUT_FLUSH_DELAY_MS = 16;
const TERMINAL_RUN_COMPLETED_FLUSH_TIMEOUT_MS = 160;
const TERMINAL_RUN_VISUAL_REORDER_TIMEOUT_MS = 2000;
const TERMINAL_LAYOUT_SCROLL_GUARD_RELEASE_MS = 180;
const TERMINAL_RESIZE_REPAINT_SUPPRESSION_MS = 240;
const TERMINAL_LIVE_RESIZE_PTY_SYNC_DELAY_MS = 96;
const TERMINAL_LIVE_RESIZE_REFRESH_EVERY = 3;
const TERMINAL_RUN_SEPARATOR_PREFIX = '──── run #';
const TERMINAL_BUFFER_DIAGNOSTIC_LINE_COUNT = 14;
const TERMINAL_BUFFER_DIAGNOSTIC_PREVIEW_LENGTH = 160;
const TERMINAL_BELL_VISUAL_FLASH_MS = 120;
// 初始绘制恢复时，从游标行向上有界扫描的最大行数，避免大 scrollback 下线性扫整缓冲。
const TERMINAL_RENDERABLE_CONTENT_SCAN_ROWS = 256;
// 离屏期间只保留最新输出，避免终端面板长时间隐藏时字符串 backlog 无界增长。
const TERMINAL_HIDDEN_WRITE_BACKLOG_MAX_CHARS = 512 * 1024;
const TERMINAL_HIDDEN_WRITE_BACKLOG_CHUNK_CHARS = 8 * 1024;
const TERMINAL_HIDDEN_WRITE_BACKLOG_OMITTED_MARKER =
  '\r\n\x1b[90m[已省略部分离屏终端输出以保持界面流畅]\x1b[0m\r\n';

const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_ESCAPE_CHARACTER_PATTERN = new RegExp(ANSI_ESCAPE, 'gu');
const ANSI_CSI_HOME_CURSOR_PATTERN = new RegExp(
  `${ANSI_ESCAPE}\\[(?:\\d{0,4}(?:;\\d{0,4})?)?H`,
  'u',
);
const ANSI_CSI_ERASE_PATTERN = new RegExp(
  `${ANSI_ESCAPE}\\[(?:\\??\\d{0,4}(?:;\\d{0,4})*)?[JK]`,
  'u',
);
const ANSI_CSI_HIDE_CURSOR_PATTERN = new RegExp(`${ANSI_ESCAPE}\\[\\?25l`, 'u');
const ANSI_ALT_SCREEN_SWITCH_PATTERN = new RegExp(
  `${ANSI_ESCAPE}\\[\\?(?:47|1047|1049)([hl])`,
  'gu',
);
const ANSI_SGR_PATTERN = new RegExp(`${ANSI_ESCAPE}\\[([0-9;]*)m`, 'gu');
const ANSI_DEFAULT_FOREGROUND_CODE = 39;
const ANSI_DEFAULT_BACKGROUND_CODE = 49;
const ANSI_EXTENDED_FOREGROUND_CODE = 38;
const ANSI_EXTENDED_BACKGROUND_CODE = 48;
const ANSI_EXTENDED_INDEXED_COLOR_MODE = 5;
const ANSI_EXTENDED_RGB_COLOR_MODE = 2;
const ANSI_LIGHT_THEME_FORCED_FOREGROUND_CODES = new Set([37, 97]);
const ANSI_LIGHT_THEME_FORCED_BACKGROUND_CODES = new Set([40, 100]);

type TTerminalBellStyle = 'none' | 'sound' | 'visual';
type TTerminalLayoutSyncOptions = { settle?: boolean };

interface IRunVisualTransaction {
  nextSeq: number;
  pending: Map<number, ITerminalDataEvent>;
  gapTimerId: number | null;
}

// ─── 终端主题 helper ───────────────────────────────────────────────────────────

/**
 * 从 ThemeManager 获取当前 xterm 主题；未初始化时返回空对象，由 xterm 使用内置默认色。
 */
const getXtermTheme = (theme?: TThemeMode) => {
  if (theme === 'light') return buildTerminalTheme(light);
  if (theme === 'dark') return buildTerminalTheme(dark);
  return getThemeManager().getTerminalTheme() ?? {};
};

const resolveInteger = (
  value: number | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const integer = Math.trunc(numeric);
  if (!Number.isFinite(integer)) return fallback;
  return Math.min(max, Math.max(min, integer));
};

const resolveTerminalBellStyle = (bellMode: ITerminalSettings['bellMode']): TTerminalBellStyle => {
  switch (bellMode) {
    case 'sound':
      return 'sound';
    case 'flash':
      return 'visual';
    default:
      return 'none';
  }
};

const buildTerminalOptions = (s: ITerminalSettings, theme: TThemeMode) => ({
  allowTransparency: false,
  cols: DEFAULT_COLS,
  convertEol: true,
  cursorBlink: s.cursorBlink,
  cursorStyle: s.cursorStyle,
  drawBoldTextInBrightColors: true,
  fastScrollSensitivity: 1,
  fontFamily: resolveTerminalFontFamily(s.fontFamily),
  fontSize: s.fontSize,
  letterSpacing: 0,
  lineHeight: Number(s.lineHeight),
  rows: DEFAULT_ROWS,
  scrollback: s.scrollback,
  scrollOnUserInput: true,
  scrollSensitivity: 1,
  smoothScrollDuration: 0,
  theme: getXtermTheme(theme),
});

const isPrintableTerminalInput = (data: string): boolean => {
  if (data.length === 0) return false;
  const code = data.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f;
};

const encodeTerminalInputForDiagnostics = (data: string): Uint8Array => {
  if (typeof TextEncoder === 'undefined') {
    return new Uint8Array();
  }
  return new TextEncoder().encode(data);
};

const isFirstRunChunkFrame = (payload: ITerminalDataEvent): boolean =>
  payload.source === 'run' && typeof payload.runSeq === 'number' && payload.runSeq === 1;

/**
 * 单次扫描即可同时得出：本段数据是否含 alt-screen 切换序列（switched），
 * 以及在 current 基础上应用所有切换后的最终 alt-screen 状态（activeAfter）。
 * 将同一段数据的 alt-screen 正则扫描从两遍合并为一遍。
 */
const scanInteractiveAltScreenSwitch = (
  current: boolean,
  data: string,
): { switched: boolean; activeAfter: boolean } => {
  ANSI_ALT_SCREEN_SWITCH_PATTERN.lastIndex = 0;
  let switched = false;
  let activeAfter = current;
  for (
    let match = ANSI_ALT_SCREEN_SWITCH_PATTERN.exec(data);
    match !== null;
    match = ANSI_ALT_SCREEN_SWITCH_PATTERN.exec(data)
  ) {
    switched = true;
    activeAfter = match[1] === 'h';
  }
  return { switched, activeAfter };
};

const isLikelyInteractiveResizeRepaintFrame = (data: string): boolean =>
  ANSI_CSI_HOME_CURSOR_PATTERN.test(data) &&
  ANSI_CSI_ERASE_PATTERN.test(data) &&
  (ANSI_CSI_HIDE_CURSOR_PATTERN.test(data) || data.includes('\x1b[H'));

const normalizeSgrParamsForLightTerminal = (params: string): string => {
  if (!params) return params;
  const parts = params.split(';');
  const normalized: string[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const rawPart = parts[index] ?? '';
    const code = rawPart === '' ? 0 : Number(rawPart);
    if (!Number.isInteger(code)) {
      normalized.push(rawPart);
      continue;
    }

    if (code === ANSI_EXTENDED_FOREGROUND_CODE || code === ANSI_EXTENDED_BACKGROUND_CODE) {
      normalized.push(rawPart);
      const modeRaw = parts[index + 1];
      const mode = modeRaw === undefined || modeRaw === '' ? 0 : Number(modeRaw);
      if (modeRaw !== undefined) {
        normalized.push(modeRaw);
        index += 1;
      }
      if (mode === ANSI_EXTENDED_INDEXED_COLOR_MODE) {
        const colorIndex = parts[index + 1];
        if (colorIndex !== undefined) {
          normalized.push(colorIndex);
          index += 1;
        }
        continue;
      }
      if (mode === ANSI_EXTENDED_RGB_COLOR_MODE) {
        for (let channel = 0; channel < 3; channel += 1) {
          const channelValue = parts[index + 1];
          if (channelValue === undefined) break;
          normalized.push(channelValue);
          index += 1;
        }
        continue;
      }
      continue;
    }

    if (ANSI_LIGHT_THEME_FORCED_FOREGROUND_CODES.has(code)) {
      normalized.push(String(ANSI_DEFAULT_FOREGROUND_CODE));
      continue;
    }
    if (ANSI_LIGHT_THEME_FORCED_BACKGROUND_CODES.has(code)) {
      normalized.push(String(ANSI_DEFAULT_BACKGROUND_CODE));
      continue;
    }
    normalized.push(rawPart);
  }

  return normalized.join(';');
};

export const normalizeTerminalAnsiForTheme = (value: string, theme: TThemeMode): string => {
  if (theme !== 'light' || !value) return value;
  ANSI_SGR_PATTERN.lastIndex = 0;
  return value.replace(ANSI_SGR_PATTERN, (sequence: string, params: string) => {
    const normalizedParams = normalizeSgrParamsForLightTerminal(params);
    return normalizedParams === params ? sequence : `${ANSI_ESCAPE}[${normalizedParams}m`;
  });
};

const previewTerminalDiagnosticText = (value: string): string =>
  value
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replace(ANSI_ESCAPE_CHARACTER_PATTERN, '\\x1b')
    .slice(0, TERMINAL_BUFFER_DIAGNOSTIC_PREVIEW_LENGTH);

const isInteractiveChannelClosedError = (error: unknown): boolean => {
  const message = toErrorMessage(error, '');
  return (
    message.includes('interactive command channel 已关闭') ||
    message.includes('terminal duplex 已关闭')
  );
};

export const stripInjectedRunSeparatorForTerminalData = (data: string): string => {
  const markerIndex = data.indexOf(TERMINAL_RUN_SEPARATOR_PREFIX);
  if (markerIndex < 0) {
    return data;
  }

  const crlfIndex = data.indexOf('\r\n', markerIndex);
  const lfIndex = data.indexOf('\n', markerIndex);
  const separatorEndIndex =
    crlfIndex >= 0 ? crlfIndex + 2 : lfIndex >= 0 ? lfIndex + 1 : data.length;

  return `${data.slice(0, markerIndex)}${data.slice(separatorEndIndex)}`;
};

// ─── 可注入的 Tauri PTY 服务接口（使 TerminalSession 可测试） ─────────────────

export interface ITerminalTauriService {
  ensureTerminalSession(params: {
    sessionId: string;
    cwd: string | null;
    cols: number;
    rows: number;
  }): Promise<ITerminalSessionPayload>;
  writeTerminalInput(params: { sessionId: string; data: string }): Promise<void>;
  resizeTerminalSession(params: { sessionId: string; cols: number; rows: number }): Promise<void>;
  closeTerminalSession(params: { sessionId: string }): Promise<void>;
}

// ─── 回调接口 ─────────────────────────────────────────────────────────────────

export interface ITerminalSessionCallbacks {
  onStatusChange?: (payload: ITerminalStatusChangePayload) => void;
  onOutput?: (payload: ITerminalRunChunkPayload) => void;
  onRunCompleted?: (payload: ITerminalRunCompletedPayload) => void;
  onInputRoute?: (payload: ITerminalInputRoutePayload) => void;
  onTerminalData?: (payload: ITerminalDataEvent) => void;
  onVisualWrite?: (payload: ITerminalVisualWritePayload) => void;
  onBufferDiagnostic?: (payload: ITerminalBufferDiagnostic) => void;
}

// ─── 构造选项 ─────────────────────────────────────────────────────────────────

export interface ITerminalSessionOptions extends ITerminalSessionCallbacks {
  sessionId: string;
  tauriService: ITerminalTauriService;
  resetOrphanedBackendSession?: boolean;
  /** 由 registry 注入的外部 status ref。 */
  statusRef?: Ref<TTerminalConnectionState>;
  /** 由 registry 注入的外部 statusMessage ref。 */
  statusMessageRef?: Ref<string>;
}

// ─── TerminalSession 类 ───────────────────────────────────────────────────────

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
  private _onOutput: ((p: ITerminalRunChunkPayload) => void) | null = null;
  private _onRunCompleted: ((p: ITerminalRunCompletedPayload) => void) | null = null;
  private _onInputRoute: ((p: ITerminalInputRoutePayload) => void) | null = null;
  private _onTerminalData: ((p: ITerminalDataEvent) => void) | null = null;
  private _onVisualWrite: ((p: ITerminalVisualWritePayload) => void) | null = null;
  private _onBufferDiagnostic: ((p: ITerminalBufferDiagnostic) => void) | null = null;

  // ── 私有：xterm 实例 ────────────────────────────────────────────────────────
  private _terminalRef = shallowRef<Terminal | null>(null);
  private _fitAddonRef = shallowRef<FitAddon | null>(null);
  private _webglAddonRef = shallowRef<WebglAddon | null>(null);

  // ── 私有：DOM ───────────────────────────────────────────────────────────────
  private _hostEl: HTMLElement | null = null;

  // ── 私有：主题与设置（UI 层传入） ───────────────────────────────────────────
  private _theme: TThemeMode = 'dark';
  private _settings: ITerminalSettings | null = null;

  // -- Private: visibility --------------------------------------------------
  private _visible = false;
  private _showRunSeparator = true;

  // ── 私有：定时器 ────────────────────────────────────────────────────────────
  private _layoutFrameId: number | null = null;
  private _layoutSettleTimeoutId: number | null = null;
  private _viewportFrameId: number | null = null;
  private _programmaticScrollReleaseFrameId: number | null = null;
  private _terminalWriteFrameId: number | null = null;
  private _terminalWriteTimeoutId: number | null = null;
  private _scrollRecoveryTimeoutId: number | null = null;
  private _layoutScrollGuardTimeoutId: number | null = null;
  private _liveResizePtySyncTimeoutId: number | null = null;
  private _liveResizeFrameCounter = 0;
  private _pendingLiveResizePtySize: { cols: number; rows: number } | null = null;

  // -- Private: Tauri event listeners --------------------------------------
  private _dataUnlisten: UnlistenFn | null = null;
  private _runChunkUnlisten: UnlistenFn | null = null;
  private _runCompletedUnlisten: UnlistenFn | null = null;
  private _exitUnlisten: UnlistenFn | null = null;
  private _stateChangedUnlisten: UnlistenFn | null = null;
  private _eventListenerRegistration: Promise<void> | null = null;
  /**
   * 每次 detach 时递增；registerEventListeners 异步完成时比对版本，
   * 防止 detach 与 re-mount 竞态导致重复监听（Fix-2）。
   */
  private _listenerVersion = 0;

  // ── 私有：DOM 副作用清理函数 ───────────────────────────────────────────────
  private _fontLoadingCleanup: (() => void) | null = null;
  private _visibilityChangeCleanup: (() => void) | null = null;
  private _windowFocusCleanup: (() => void) | null = null;
  private _windowResizeCleanup: (() => void) | null = null;
  private _shellWindowResizeCleanup: (() => void) | null = null;
  private _webglContextLossCleanup: { dispose(): void } | null = null;
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

  // -- Private: write buffer -----------------------------------------------
  private readonly _bufferedTerminalWriteChunks: string[] = [];
  private _bufferedTerminalWriteLength = 0;
  private readonly _hiddenWriteBacklog = createHiddenWriteBacklog({
    maxChars: TERMINAL_HIDDEN_WRITE_BACKLOG_MAX_CHARS,
    maxChunkChars: TERMINAL_HIDDEN_WRITE_BACKLOG_CHUNK_CHARS,
    omittedMarker: TERMINAL_HIDDEN_WRITE_BACKLOG_OMITTED_MARKER,
  });
  private _pendingScrollToBottomAfterWrite = false;
  private _pendingHiddenScrollToBottom = false;
  private _shouldFitBeforeNextVisibleWrite = false;
  private _pendingInitialPaintRecovery = true;
  private readonly _pendingTerminalWriteCallbacks: Array<() => void> = [];
  private readonly _runVisualTransactions = new Map<string, IRunVisualTransaction>();

  // -- Private: terminal state flags ---------------------------------------
  private _isTerminalWriteInFlight = false;
  private _isProgrammaticScrollSync = false;
  private _isAutoFollowEnabled = true;
  private _keepViewportAtBottomDuringLayout = false;
  private _interactiveAltScreenActive = false;
  private _interactiveResizeRepaintSuppressUntilMs = 0;

  // -- Private: run tracking ------------------------------------------------
  private _activeRunId: string | null = null;

  // -- Private: renderer state ---------------------------------------------
  private _webglRendererBlocked = false;
  private _previousHostSize = { width: 0, height: 0 };
  private _previousTerminalSize = { cols: 0, rows: 0 };

  // -- Constructor ----------------------------------------------------------

  constructor(options: ITerminalSessionOptions) {
    this.id = options.sessionId;
    // 优先使用 registry 注入的共享 ref，保证状态钩子与实例同源（Fix-3）。
    this.status = options.statusRef ?? ref<TTerminalConnectionState>('connecting');
    this.statusMessage = options.statusMessageRef ?? ref('正在连接 WSL2 终端…');
    this.session = ref<ITerminalSessionPayload | null>(null);
    this._tauri = options.tauriService;
    this._resetOrphanedBackendSession = options.resetOrphanedBackendSession ?? false;
    this._onStatusChange = options.onStatusChange ?? null;
    this._onOutput = options.onOutput ?? null;
    this._onRunCompleted = options.onRunCompleted ?? null;
    this._onInputRoute = options.onInputRoute ?? null;
    this._onTerminalData = options.onTerminalData ?? null;
    this._onVisualWrite = options.onVisualWrite ?? null;
    this._onBufferDiagnostic = options.onBufferDiagnostic ?? null;
  }

  // -- Public: update callbacks --------------------------------------------

  updateCallbacks(callbacks: ITerminalSessionCallbacks): void {
    this._onStatusChange = callbacks.onStatusChange ?? null;
    this._onOutput = callbacks.onOutput ?? null;
    this._onRunCompleted = callbacks.onRunCompleted ?? null;
    this._onInputRoute = callbacks.onInputRoute ?? null;
    this._onTerminalData = callbacks.onTerminalData ?? null;
    this._onVisualWrite = callbacks.onVisualWrite ?? null;
    this._onBufferDiagnostic = callbacks.onBufferDiagnostic ?? null;
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

  // ── 公共：应用主题与终端设置变更 ────────────────────────────────────────────

  applySettings(theme: TThemeMode, settings: ITerminalSettings): void {
    this._theme = theme;
    this._settings = settings;
    this._applyTerminalSettings();
  }

  // -- Public: handle panel visibility -------------------------------------

  handleBecomeVisible(): void {
    this._createTerminal();
    this._syncTerminalSurfaceTone();
    this._scheduleLayoutSync({ settle: true });
    this._scheduleViewportSync({
      clearTextureAtlas: true,
      refresh: true,
      scrollToBottom: true,
    });
    if (!this._hiddenWriteBacklog.isEmpty) {
      this._shouldFitBeforeNextVisibleWrite = true;
      this._flushTerminalWriteBufferNow({ forceLayout: true });
    }
    this.focusTerminal();
  }

  // -- Public: subscribe Tauri events --------------------------------------

  registerEventListeners(): Promise<void> {
    if (
      this._dataUnlisten &&
      this._runChunkUnlisten &&
      this._runCompletedUnlisten &&
      this._exitUnlisten &&
      this._stateChangedUnlisten
    ) {
      return Promise.resolve();
    }
    if (this._eventListenerRegistration) {
      return this._eventListenerRegistration;
    }
    // 捕获当前版本号；若异步期间 detach 使版本递增，则丢弃本次注册（Fix-2）。
    const version = this._listenerVersion;
    this._eventListenerRegistration = (async () => {
      const runtimeReady = await waitForDesktopRuntime();
      if (!runtimeReady) {
        return;
      }

      const [dl, rl, cl, el, sl] = await Promise.all([
        listen<ITerminalDataEvent>('terminal:data', (e) => this._handleDataEvent(e)),
        listen<ITerminalRunChunkPayload>('terminal:run-chunk', (e) => this._handleRunChunkEvent(e)),
        listen<ITerminalRunCompletedPayload>('terminal:run-completed', (e) =>
          this._handleRunCompletedEvent(e),
        ),
        listen<ITerminalExitEvent>('terminal:interactive-exited', (e) => this._handleExitEvent(e)),
        listen<ITerminalStateChangedPayload>('terminal:state-changed', (e) =>
          this._handleStateChangedEvent(e),
        ),
      ]);
      if (this._listenerVersion !== version) {
        // detach 在注册期间被调用，立即释放这批监听器避免泄漏
        dl();
        rl();
        cl();
        el();
        sl();
        return;
      }
      this._dataUnlisten = dl;
      this._runChunkUnlisten = rl;
      this._runCompletedUnlisten = cl;
      this._exitUnlisten = el;
      this._stateChangedUnlisten = sl;
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
      if (this._visible) {
        this.focusTerminal();
      }
      return;
    }

    this._emitStatus('connecting', '正在连接 WSL2 终端…');
    await nextTick();
    this._emitBufferDiagnostic('ensure-connect:before-initial-layout');
    this._syncTerminalLayout();
    try {
      let payload = await this._tauri.ensureTerminalSession({
        sessionId: this.id,
        cwd: null,
        cols: resolveInteger(terminal.cols, DEFAULT_COLS, 2, 5000),
        rows: resolveInteger(terminal.rows, DEFAULT_ROWS, 1, 3000),
      });
      if (!payload.created && this._resetOrphanedBackendSession) {
        await this._tauri.closeTerminalSession({ sessionId: this.id });
        payload = await this._tauri.ensureTerminalSession({
          sessionId: this.id,
          cwd: null,
          cols: resolveInteger(terminal.cols, DEFAULT_COLS, 2, 5000),
          rows: resolveInteger(terminal.rows, DEFAULT_ROWS, 1, 3000),
        });
      }
      this.session.value = payload;
      this._emitBufferDiagnostic(
        payload.created
          ? 'ensure-connect:created-session'
          : 'ensure-connect:existing-session-before-replay',
        payload.initialOutput ?? null,
      );
      if (!payload.created && payload.initialOutput) {
        terminal.reset();
        this._clearTerminalWriteBuffer();
        this._hiddenWriteBacklog.clear();
        this._pendingScrollToBottomAfterWrite = false;
        this._pendingHiddenScrollToBottom = false;
        this._isAutoFollowEnabled = true;
        this._pendingInitialPaintRecovery = true;
        this._queueTerminalWrite(payload.initialOutput, { scrollToBottom: true });
        this._flushTerminalWriteBufferNow({ forceLayout: true });
        this._emitBufferDiagnostic('ensure-connect:existing-session-after-replay');
      }
      if (payload.created && !payload.initialOutput) {
        this._pendingInitialPaintRecovery = true;
      }
      this._emitStatus('ready', `${payload.shellLabel} 已连接`);
      this._scheduleViewportSync({ scrollToBottom: true });
      if (this._visible) {
        this.focusTerminal();
      }
    } catch (error) {
      const message = toErrorMessage(error, '连接 WSL2 终端失败。');
      this._emitStatus('error', message);
      terminal.writeln(`\x1b[31m${message}\x1b[0m`, () => {
        this._scheduleViewportSync({ scrollToBottom: true });
      });
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
    this._pendingInitialPaintRecovery = true;
    await this.ensureConnect();
  }

  // -- Public: focus / selection / clipboard --------------------------------

  focusTerminal(): void {
    this._terminalRef.value?.focus();
  }

  getSelectionText(): string {
    const selection = this._terminalRef.value?.getSelection() ?? '';
    if (!selection) {
      return '';
    }

    return this._settings?.trimFinalNewlineOnCopy ? selection.replace(/[\r\n]+$/u, '') : selection;
  }

  async copySelection(): Promise<void> {
    const selection = this.getSelectionText();
    if (!selection) {
      return;
    }

    await writeClipboardText(selection);
    this.focusTerminal();
  }

  selectAll(): void {
    this._terminalRef.value?.selectAll();
    this.focusTerminal();
  }

  pasteText(text: string): void {
    if (!text) {
      return;
    }

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

  // -- Public: interrupt run ------------------------------------------------

  async interrupt(): Promise<void> {
    if (!this.session.value) return;
    await this._tauri.writeTerminalInput({ sessionId: this.id, data: '\u0003' });
    this._isAutoFollowEnabled = true;
    this._scheduleViewportSync({ scrollToBottom: true });
    this.focusTerminal();
  }

  // -- Public: send command -------------------------------------------------

  async sendCommand(command: string): Promise<void> {
    const normalized = command.trim();
    if (!normalized) return;
    if (!this.session.value) {
      await this.ensureConnect();
    }
    if (!this.session.value) {
      throw new Error('WSL2 终端尚未就绪。');
    }
    await this._tauri.writeTerminalInput({
      sessionId: this.id,
      data: `${normalized}\n`,
    });
    this._isAutoFollowEnabled = true;
    this._scheduleViewportSync({ scrollToBottom: true });
    this.focusTerminal();
  }

  async sendInput(data: string): Promise<void> {
    if (!data) return;
    if (!this.session.value) {
      await this.ensureConnect();
    }
    if (!this.session.value) {
      throw new Error('WSL2 终端尚未就绪。');
    }
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
      void fontSet.ready.then(() => {
        handleFontMetricsReady();
      });
      fontSet.addEventListener('loadingdone', handleFontMetricsReady);
      this._fontLoadingCleanup = () => {
        fontSet.removeEventListener('loadingdone', handleFontMetricsReady);
        this._fontLoadingCleanup = null;
      };
    }
  }

  // -- Public: detach DOM/listeners while keeping PTY ----------------------

  detach(): void {
    // 版本递增；令任何尚在飞行中的 registerEventListeners 异步自行丢弃（Fix-2）。
    this._listenerVersion++;

    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._windowResizeCleanup?.();
    this._shellWindowResizeCleanup?.();
    this._windowFocusCleanup?.();
    this._visibilityChangeCleanup?.();
    this._fontLoadingCleanup?.();

    this._dataUnlisten?.();
    this._runChunkUnlisten?.();
    this._runCompletedUnlisten?.();
    this._exitUnlisten?.();
    this._stateChangedUnlisten?.();
    this._dataUnlisten = null;
    this._runChunkUnlisten = null;
    this._runCompletedUnlisten = null;
    this._exitUnlisten = null;
    this._stateChangedUnlisten = null;

    this._bellUnsubscribe?.();
    this._bellUnsubscribe = null;

    this._clearLayoutFrame();
    this._clearLayoutSettleTimeout();
    this._clearViewportFrame();
    this._clearProgrammaticScrollReleaseFrame();
    this._clearTerminalWriteFrame();
    this._clearTerminalWriteTimeout();
    this._clearScrollRecoveryTimeout();
    this._clearLayoutScrollGuardTimeout();
    this._clearLiveResizePtySyncTimeout();
    this._clearRunVisualTransactions();

    this._resetTerminalRunCapture();
    this._clearTerminalWriteBuffer();
    this._hiddenWriteBacklog.clear();
    this._pendingTerminalWriteCallbacks.length = 0;
    this._isTerminalWriteInFlight = false;
    this._pendingScrollToBottomAfterWrite = false;
    this._pendingHiddenScrollToBottom = false;
    this._shouldFitBeforeNextVisibleWrite = false;
    this._pendingInitialPaintRecovery = true;
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
    this.detach();
    this._disposeWebglRenderer();
    this._terminalRef.value?.dispose();
    this._terminalRef.value = null;
    this._fitAddonRef.value = null;
    this.session.value = null;
  }

  // ── 私有：emit 方法 ──────────────────────────────────────────────────────────

  private _emitStatus(state: TTerminalConnectionState, message: string): void {
    this.status.value = state;
    this.statusMessage.value = message;
    this._onStatusChange?.({ state, message });
  }

  private _emitOutput(payload: ITerminalRunChunkPayload): void {
    this._onOutput?.(payload);
  }

  private _emitRunCompleted(payload: ITerminalRunCompletedPayload): void {
    this._onRunCompleted?.(payload);
  }

  private _emitInputRoute(route: TTerminalInputRoute, data: string): void {
    this._onInputRoute?.({
      route,
      data: encodeTerminalInputForDiagnostics(data),
    });
  }

  private _emitVisualWrite(payload: ITerminalVisualWritePayload): void {
    this._onVisualWrite?.(payload);
  }

  private _emitTerminalDataReceived(payload: ITerminalDataEvent): void {
    this._onTerminalData?.(payload);
  }

  private _emitBufferDiagnostic(label: string, writePreview?: string | null): void {
    if (!this._onBufferDiagnostic) return;
    const diagnostic = this._buildBufferDiagnostic(label, writePreview ?? null);
    if (diagnostic) {
      this._onBufferDiagnostic(diagnostic);
    }
  }

  private _buildBufferDiagnostic(
    label: string,
    writePreview: string | null,
  ): ITerminalBufferDiagnostic | null {
    const terminal = this._terminalRef.value;
    if (!terminal) {
      return null;
    }

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
      pendingWriteChars: this._bufferedTerminalWriteLength,
      hiddenBacklogChars: this._hiddenWriteBacklog.length,
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
  private _clearTerminalWriteFrame(): void {
    if (this._terminalWriteFrameId !== null) {
      cancelAnimationFrame(this._terminalWriteFrameId);
      this._terminalWriteFrameId = null;
    }
  }
  private _clearTerminalWriteTimeout(): void {
    if (this._terminalWriteTimeoutId !== null) {
      window.clearTimeout(this._terminalWriteTimeoutId);
      this._terminalWriteTimeoutId = null;
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
  private _clearRunVisualTransactions(): void {
    for (const transaction of this._runVisualTransactions.values()) {
      if (transaction.gapTimerId !== null) {
        window.clearTimeout(transaction.gapTimerId);
      }
    }
    this._runVisualTransactions.clear();
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
    this._clearTerminalWriteFrame();
    this._clearTerminalWriteTimeout();
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
    ) {
      return;
    }

    try {
      const prevCols = terminal.cols;
      const prevRows = terminal.rows;
      const shouldKeepViewportAtBottom =
        this._visible && (this._isAutoFollowEnabled || this._isViewportNearBottom(terminal));
      this._beginLayoutScrollGuard(shouldKeepViewportAtBottom);
      this._runWithProgrammaticScrollLock(() => {
        fitAddon.fit();
      });

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
      console.warn('终端 live resize 尺寸同步失败', error);
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

    if (this._hasPendingTerminalWrite() || this._pendingTerminalWriteCallbacks.length > 0) {
      this._scheduleTerminalWriteFlush();
    }
  }

  private _scheduleLayoutSync(options?: TTerminalLayoutSyncOptions): void {
    if (options?.settle) {
      this._pendingLayoutSettleSync = true;
    }
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
      this._runWithProgrammaticScrollLock(() => {
        fitAddon.fit();
      });
      if (shouldKeepViewportAtBottom) {
        this._isAutoFollowEnabled = true;
      }
      if (terminal.cols === prevCols && terminal.rows === prevRows) {
        if (shouldKeepViewportAtBottom) {
          this._scheduleViewportSync({ scrollToBottom: true });
        }
        return;
      }
      this._emitBufferDiagnostic(`layout:after-fit:${terminal.cols}x${terminal.rows}`);
      if (!this._didTerminalSizeChange(terminal.cols, terminal.rows)) {
        if (shouldKeepViewportAtBottom) {
          this._scheduleViewportSync({ scrollToBottom: true });
        }
        return;
      }
      this._scheduleViewportSync({ scrollToBottom: shouldKeepViewportAtBottom });
      this._markInteractiveResizeRepaintSuppression();
      this._syncPtySize(terminal.cols, terminal.rows);
    } catch (error) {
      console.warn('终端尺寸同步失败', error);
    } finally {
      this._endLayoutScrollGuardSoon();
    }
  }

  private _syncPtySize(cols: number, rows: number): void {
    if (!this.session.value) return;
    void this._tauri.resizeTerminalSession({ sessionId: this.id, cols, rows }).catch((error) => {
      console.warn('终端 PTY 尺寸同步失败', {
        sessionId: this.id,
        cols,
        rows,
        error,
      });
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
      this._runWithProgrammaticScrollLock(() => {
        terminal.scrollToBottom();
      });
    }
    if (shouldRefresh) {
      terminal.refresh(0, Math.max(terminal.rows - 1, 0));
    }
  }

  // -- Private: write buffer -----------------------------------------------

  private _hasPendingTerminalWrite(): boolean {
    return this._bufferedTerminalWriteLength > 0;
  }

  private _appendTerminalWriteBuffer(value: string): void {
    if (!value) {
      return;
    }

    this._bufferedTerminalWriteChunks.push(value);
    this._bufferedTerminalWriteLength += value.length;
  }

  private _prependTerminalWriteBuffer(value: string): void {
    if (!value) {
      return;
    }

    this._bufferedTerminalWriteChunks.unshift(value);
    this._bufferedTerminalWriteLength += value.length;
  }

  private _drainTerminalWriteBuffer(): string {
    if (this._bufferedTerminalWriteLength === 0) {
      return '';
    }

    if (this._bufferedTerminalWriteChunks.length === 1) {
      const value = this._bufferedTerminalWriteChunks[0] ?? '';
      this._clearTerminalWriteBuffer();
      return value;
    }

    const value = this._bufferedTerminalWriteChunks.join('');
    this._clearTerminalWriteBuffer();
    return value;
  }

  private _clearTerminalWriteBuffer(): void {
    this._bufferedTerminalWriteChunks.length = 0;
    this._bufferedTerminalWriteLength = 0;
  }

  private _flushPendingTerminalWriteCallbacks(): void {
    if (this._pendingTerminalWriteCallbacks.length === 0) return;
    const cbs = this._pendingTerminalWriteCallbacks.splice(
      0,
      this._pendingTerminalWriteCallbacks.length,
    );
    cbs.forEach((cb) => {
      cb();
    });
  }

  private _flushTerminalWriteBufferNow(options?: {
    afterWrite?: () => void;
    forceLayout?: boolean;
  }): void {
    if (options?.afterWrite) {
      this._pendingTerminalWriteCallbacks.push(options.afterWrite);
    }
    this._clearTerminalWriteFrame();
    this._clearTerminalWriteTimeout();
    const terminal = this._terminalRef.value;
    if (!terminal) {
      if (!this._isTerminalWriteInFlight) this._flushPendingTerminalWriteCallbacks();
      return;
    }
    if (this._isShellWindowResizing && this._visible) {
      return;
    }
    if (!this._visible) {
      const bufferedWrite = this._drainTerminalWriteBuffer();

      if (bufferedWrite) {
        this._hiddenWriteBacklog.append(bufferedWrite);
      }

      if (this._pendingScrollToBottomAfterWrite) {
        this._pendingHiddenScrollToBottom = true;
        this._pendingScrollToBottomAfterWrite = false;
      }
      return;
    }
    if (this._isTerminalWriteInFlight) return;
    if (!this._hiddenWriteBacklog.isEmpty) {
      this._prependTerminalWriteBuffer(this._hiddenWriteBacklog.drain());

      if (this._pendingHiddenScrollToBottom) {
        this._pendingScrollToBottomAfterWrite = true;
        this._pendingHiddenScrollToBottom = false;
      }
    }
    if (!this._hasPendingTerminalWrite()) {
      if (options?.forceLayout || this._shouldFitBeforeNextVisibleWrite) {
        this._syncTerminalLayout();
        this._shouldFitBeforeNextVisibleWrite = false;
        this._scheduleViewportSync({ scrollToBottom: true });
      }
      this._flushPendingTerminalWriteCallbacks();
      return;
    }
    if (options?.forceLayout || this._shouldFitBeforeNextVisibleWrite) {
      this._syncTerminalLayout();
      this._shouldFitBeforeNextVisibleWrite = false;
    }
    const chunk = this._drainTerminalWriteBuffer();
    const shouldScroll = this._pendingScrollToBottomAfterWrite;
    this._pendingScrollToBottomAfterWrite = false;
    this._isTerminalWriteInFlight = true;
    this._emitBufferDiagnostic('xterm-write:before', chunk);
    terminal.write(chunk, () => {
      this._isTerminalWriteInFlight = false;
      this._emitBufferDiagnostic('xterm-write:after', chunk);
      this._scheduleViewportSync({ scrollToBottom: shouldScroll });
      if (this._pendingInitialPaintRecovery && this._hasTerminalRenderableContent()) {
        this._pendingInitialPaintRecovery = false;
        this._emitBufferDiagnostic('initial-paint-recovery:before-layout');
        this._syncTerminalLayout();
        this._emitBufferDiagnostic('initial-paint-recovery:after-layout');
        this._scheduleViewportSync({ refresh: true, scrollToBottom: true });
      }
      if (this._hasPendingTerminalWrite()) {
        this._flushTerminalWriteBufferNow();
        return;
      }
      this._flushPendingTerminalWriteCallbacks();
    });
  }

  private _scheduleTerminalWriteFlush(): void {
    if (this._isShellWindowResizing && this._visible) {
      return;
    }
    if (this._terminalWriteFrameId === null) {
      this._terminalWriteFrameId = requestAnimationFrame(() => {
        this._terminalWriteFrameId = null;
        this._flushTerminalWriteBufferNow();
      });
    }
    if (this._terminalWriteTimeoutId !== null) return;
    this._terminalWriteTimeoutId = window.setTimeout(() => {
      this._terminalWriteTimeoutId = null;
      this._flushTerminalWriteBufferNow();
    }, TERMINAL_OUTPUT_FLUSH_DELAY_MS);
  }

  private _queueTerminalWrite(value: string, options?: { scrollToBottom?: boolean }): void {
    if (!value) return;
    const normalizedValue = normalizeTerminalAnsiForTheme(value, this._theme);
    if (!this._visible) {
      this._hiddenWriteBacklog.append(normalizedValue);
      if (options?.scrollToBottom) this._pendingHiddenScrollToBottom = true;
      return;
    }
    this._appendTerminalWriteBuffer(normalizedValue);
    if (options?.scrollToBottom) this._pendingScrollToBottomAfterWrite = true;
    this._scheduleTerminalWriteFlush();
  }

  private _writeTerminalDataPayload(payload: ITerminalDataEvent): void {
    const data =
      payload.source === 'injected_separator' && !this._showRunSeparator
        ? stripInjectedRunSeparatorForTerminalData(payload.data)
        : payload.data;
    if (!data) return;
    if (isFirstRunChunkFrame(payload)) {
      this._emitBufferDiagnostic('before-first-run-visual-frame', data);
    }
    this._emitVisualWrite({ ...payload, data });
    this._queueTerminalWrite(data, { scrollToBottom: true });
  }

  private _getRunVisualTransaction(runId: string): IRunVisualTransaction {
    const existing = this._runVisualTransactions.get(runId);
    if (existing) {
      return existing;
    }

    const transaction: IRunVisualTransaction = {
      nextSeq: 1,
      pending: new Map<number, ITerminalDataEvent>(),
      gapTimerId: null,
    };
    this._runVisualTransactions.set(runId, transaction);
    return transaction;
  }

  private _clearRunVisualTransaction(runId: string): void {
    const transaction = this._runVisualTransactions.get(runId);
    if (!transaction) {
      return;
    }
    if (transaction.gapTimerId !== null) {
      window.clearTimeout(transaction.gapTimerId);
    }
    this._runVisualTransactions.delete(runId);
  }

  private _scheduleRunVisualGapRecovery(runId: string, transaction: IRunVisualTransaction): void {
    if (transaction.gapTimerId !== null) {
      return;
    }
    transaction.gapTimerId = window.setTimeout(() => {
      transaction.gapTimerId = null;
      this._recoverRunVisualSeqGap(runId);
    }, TERMINAL_RUN_VISUAL_REORDER_TIMEOUT_MS);
  }

  private _recoverRunVisualSeqGap(runId: string): void {
    const transaction = this._runVisualTransactions.get(runId);
    if (!transaction || transaction.pending.size === 0) {
      return;
    }
    // pending 必非空（上方已对 size === 0 提前返回）。用线性求最小取代展开式 Math.min，
    // 避免 pending 较大时把全部键展开为实参（可能触发 RangeError）；此路径仅在罕见的
    // 乱序缺口恢复定时器触发，pending 规模小，线性扫描足矣，无需在热路径维护增量最小值。
    let lowestPendingSeq = Number.POSITIVE_INFINITY;
    for (const seq of transaction.pending.keys()) {
      if (seq < lowestPendingSeq) lowestPendingSeq = seq;
    }
    if (!transaction.pending.has(transaction.nextSeq)) {
      transaction.nextSeq = lowestPendingSeq;
      console.warn('[terminal] terminal:data runSeq 缺口，已按当前可见事务放行。', {
        runId,
        nextSeq: transaction.nextSeq,
      });
    }
    this._drainRunVisualTransaction(runId, transaction);
  }

  private _drainRunVisualTransaction(runId: string, transaction: IRunVisualTransaction): void {
    while (true) {
      const payload = transaction.pending.get(transaction.nextSeq);
      if (!payload) {
        break;
      }
      transaction.pending.delete(transaction.nextSeq);
      transaction.nextSeq += 1;
      this._writeTerminalDataPayload(payload);
      if (payload.source === 'injected_separator') {
        this._clearRunVisualTransaction(runId);
        return;
      }
    }

    if (transaction.pending.size > 0) {
      this._scheduleRunVisualGapRecovery(runId, transaction);
      return;
    }

    if (transaction.gapTimerId !== null) {
      window.clearTimeout(transaction.gapTimerId);
      transaction.gapTimerId = null;
    }
  }

  private _handleRunVisualDataPayload(payload: ITerminalDataEvent): void {
    const runId = payload.runId;
    const runSeq = payload.runSeq;
    if (
      typeof runId !== 'string' ||
      runId.length === 0 ||
      typeof runSeq !== 'number' ||
      !Number.isSafeInteger(runSeq) ||
      runSeq <= 0
    ) {
      this._writeTerminalDataPayload(payload);
      return;
    }

    const transaction = this._getRunVisualTransaction(runId);
    if (runSeq < transaction.nextSeq) {
      return;
    }

    transaction.pending.set(runSeq, payload);
    this._drainRunVisualTransaction(runId, transaction);
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
      this._handleRunVisualDataPayload(event.payload);
      return;
    }

    if (event.payload.source === 'interactive' || !event.payload.source) {
      const wasAltScreenActive = this._interactiveAltScreenActive;
      // 单次扫描同时得出本段是否含 alt-screen 切换与应用后的最终状态，
      // 并把 switched 直接传入抑制判定，避免对同一段数据重复扫描（原先共三遍）。
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

  private _handleRunChunkEvent(event: { payload: ITerminalRunChunkPayload }): void {
    if (event.payload.sessionId !== this.id || !event.payload.data) return;
    this._emitOutput(event.payload);
  }

  private _handleRunCompletedEvent(event: { payload: ITerminalRunCompletedPayload }): void {
    if (event.payload.sessionId !== this.id) return;
    this._emitTerminalRunCompleted(event.payload);
  }

  private _handleStateChangedEvent(event: { payload: ITerminalStateChangedPayload }): void {
    if (event.payload.to !== 'idle_interactive') return;
    this._clearTrackedRunState();
    this._interactiveResizeRepaintSuppressUntilMs = 0;
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
    this._queueTerminalWrite(`\r\n\x1b[90m${message}\x1b[0m\r\n`, {
      scrollToBottom: true,
    });
    this._flushTerminalWriteBufferNow();
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
    fallbackId = window.setTimeout(() => {
      finalize();
    }, TERMINAL_RUN_COMPLETED_FLUSH_TIMEOUT_MS);
    this.focusTerminal();
    this._flushTerminalWriteBufferNow({
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
    } as ITerminalRunCompletedPayload;
  }

  private _clearTrackedRunState(runId?: string): void {
    if (runId && this._activeRunId !== runId) return;
    this._activeRunId = null;
  }

  private _resetTerminalRunCapture(): void {
    this._clearTrackedRunState();
  }

  // ── 私有：渲染器 ─────────────────────────────────────────────────────────────

  private _canUseWebglRenderer(): boolean {
    return (
      TERMINAL_ENABLE_WEBGL_RENDERER &&
      !this._webglRendererBlocked &&
      typeof window !== 'undefined' &&
      'WebGL2RenderingContext' in window
    );
  }

  private _ensurePreferredRenderer(): void {
    const terminal = this._terminalRef.value;
    if (!terminal || this._webglAddonRef.value || !this._canUseWebglRenderer()) return;
    try {
      const addon = markRaw(new WebglAddon());
      this._webglContextLossCleanup = addon.onContextLoss(() => {
        this._disposeWebglRenderer();
        window.setTimeout(() => {
          this._ensurePreferredRenderer();
          this._scheduleLayoutSync();
          this._scheduleViewportSync({
            clearTextureAtlas: true,
            refresh: true,
            scrollToBottom: true,
          });
        }, TERMINAL_WEBGL_RECOVERY_DELAY_MS);
      });
      terminal.loadAddon(addon);
      this._webglAddonRef.value = addon;
    } catch (error) {
      this._webglRendererBlocked = true;
      console.warn('WebGL 终端渲染器初始化失败，已回退默认渲染。', error);
    }
  }

  private _disposeWebglRenderer(): void {
    this._webglContextLossCleanup?.dispose();
    this._webglContextLossCleanup = null;
    this._webglAddonRef.value?.dispose();
    this._webglAddonRef.value = null;
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
    // 内容必然位于游标行及其上方，从游标行向上有界扫描固定行数即可。
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
      if (shell instanceof HTMLElement) {
        applySurfaceStyle(shell);
      }
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

  // ── 私有：bell（xterm v5 已移除 bellStyle，改用 onBell 自管） ───────────────

  private _applyBellBehavior(): void {
    const terminal = this._terminalRef.value;
    this._bellUnsubscribe?.();
    this._bellUnsubscribe = null;
    if (!terminal || !this._settings) return;

    const mode = resolveTerminalBellStyle(this._settings.bellMode);
    if (mode === 'none') return;

    const disposable = terminal.onBell(() => {
      if (mode === 'sound') {
        // 留给宿主实现：播放系统铃声或自定义 SFX。
        return;
      }
      // visual：闪烁宿主元素一次。
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
    void writeClipboardText(selection).catch(() => {
      /* 静默吞掉剪贴板写入失败 */
    });
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
      const handleShellWindowResizeStart = (): void => {
        this._handleShellWindowResizeStart();
      };
      const handleShellWindowResizeEnd = (): void => {
        this._handleShellWindowResizeEnd();
      };
      const handleShellWindowResizeFrame = (): void => {
        this._handleShellWindowResizeFrame();
      };
      const handleShellWindowResizeSettled = (): void => {
        this._handleShellWindowResizeSettled();
      };
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
    this._pendingInitialPaintRecovery = true;
    this._scheduleLayoutSync({ settle: true });
    this._scheduleViewportSync({
      clearTextureAtlas: true,
      refresh: true,
      scrollToBottom: true,
    });
    this._applyBellBehavior();
  }

  private _createTerminal(): void {
    if (!this._hostEl) return;
    if (!this._terminalRef.value) {
      if (!this._settings) {
        this._failMissingSettings();
      }
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
              this._queueTerminalWrite(`\r\n\x1b[90m${message}\x1b[0m\r\n`, {
                scrollToBottom: true,
              });
              this._flushTerminalWriteBufferNow();
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
        if (this._isAutoFollowEnabled) {
          this._clearScrollRecoveryTimeout();
          return;
        }
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
      terminal.onSelectionChange(() => {
        void this._writeSelectionToClipboard();
      });
    }
    this._attachTerminalToHost();
  }

  /**
   * 调用方契约：必须先 initWithHost(...) 再调用任何创建 xterm 的入口。
   * 命中此分支视为契约违规 —— 快失败，避免静默地用空字符串/0 数值启动 xterm。
   */
  private _failMissingSettings(): never {
    throw new Error(
      '[terminal-session] _settings 缺失：请先调用 initWithHost(host, theme, settings) 再创建终端。',
    );
  }
}
