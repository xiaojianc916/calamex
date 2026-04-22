/**
 * src/terminal/session.ts
 * TerminalSession — 终端会话核心实现（R-20.2.1 / R-20.2.3）
 *
 * 持有全部会话状态；与 UI 层完全解耦，可通过构造参数注入 fake 服务用于单测（R-20.2.6）。
 * UI 层（useIntegratedTerminal.ts）仅负责 DOM 挂载 / Vue 生命周期 / 响应式 watcher。
 */
import { getThemeManager } from '@/themes';
import type { TThemeMode } from '@/types/app';
import type { ITerminalSettings } from '@/types/settings';
import type {
    ITerminalDataEvent,
    ITerminalExitEvent,
    ITerminalRunCompletePayload,
    ITerminalRunOutputEvent,
    ITerminalSessionPayload,
    ITerminalStatusChangePayload,
    TTerminalConnectionState,
} from '@/types/terminal';
import { writeClipboardText } from '@/utils/clipboard';
import { waitForDesktopRuntime } from '@/utils/desktop-runtime';
import { toErrorMessage } from '@/utils/error';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { nextTick, ref, shallowRef, type Ref } from 'vue';

// ─── 本地常量 ─────────────────────────────────────────────────────────────────

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 28;
const MIN_RENDERABLE_TERMINAL_WIDTH = 24;
const MIN_RENDERABLE_TERMINAL_HEIGHT = 24;
const TERMINAL_ENABLE_WEBGL_RENDERER = false;
const TERMINAL_WEBGL_RECOVERY_DELAY_MS = 180;
const TERMINAL_LAYOUT_SETTLE_DELAY_MS = 72;
const TERMINAL_OUTPUT_FLUSH_DELAY_MS = 16;
const TERMINAL_RUN_COMPLETE_FLUSH_TIMEOUT_MS = 160;
const TERMINAL_SCROLL_RECOVERY_DELAY_MS = 64;
const TERMINAL_PROMPT_WAKE_DELAY_MS = 320;
const DEFAULT_TERMINAL_FONT_FAMILY =
    "Berkeley Mono, JetBrains Mono, 'SFMono-Regular', Consolas, 'Courier New', monospace";

type TTerminalBellStyle = 'none' | 'sound' | 'visual';
type TTerminalLayoutSyncOptions = { settle?: boolean };

// ─── 终端主题 helper ───────────────────────────────────────────────────────────

/**
 * 从 ThemeManager 获取当前 xterm 主题。
 * ThemeManager.init() 在 main.ts 同步调用，运行时永远非 null；
 * 单测中若未初始化则返回空对象，xterm 使用内置默认色。
 */
const getXtermTheme = () => getThemeManager().getTerminalTheme() ?? {};

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

const resolveTerminalFontFamily = (fontFamily: string): string => {
    const normalized = fontFamily.trim();
    return normalized.length > 0
        ? `${normalized}, ${DEFAULT_TERMINAL_FONT_FAMILY}`
        : DEFAULT_TERMINAL_FONT_FAMILY;
};

const buildTerminalOptions = (s: ITerminalSettings) => ({
    allowTransparency: false,
    bellStyle: resolveTerminalBellStyle(s.bellMode),
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
    theme: getXtermTheme(),
});

const isPrintableTerminalInput = (data: string): boolean => {
    if (data.length === 0) return false;
    const code = data.charCodeAt(0);
    return code >= 0x20 && code !== 0x7f;
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
}

// ─── 回调接口 ─────────────────────────────────────────────────────────────────

export interface ITerminalSessionCallbacks {
    onStatusChange?: (payload: ITerminalStatusChangePayload) => void;
    onOutput?: (payload: ITerminalRunOutputEvent) => void;
    onRunComplete?: (payload: ITerminalRunCompletePayload) => void;
}

// ─── 构造选项 ─────────────────────────────────────────────────────────────────

export interface ITerminalSessionOptions extends ITerminalSessionCallbacks {
    sessionId: string;
    tauriService: ITerminalTauriService;
    /**
     * 由 registry 注入的外部 status ref。
     * 确保 useIntegratedTerminalStatus 在 session 创建前后读同一个 ref（Fix-3）。
     */
    statusRef?: Ref<TTerminalConnectionState>;
    /** 由 registry 注入的外部 statusMessage ref */
    statusMessageRef?: Ref<string>;
}

// ─── TerminalSession 类 ───────────────────────────────────────────────────────

/**
 * 终端会话实体，遵循 R-20.2.3 定义的接口契约。
 * 一个实例对应一个 PTY 连接；所有可变状态均封装为实例属性，严禁模块级共享变量。
 */
export class TerminalSession {
    // ── 公共响应式状态 ──────────────────────────────────────────────────────────
    readonly id: string;
    readonly status: Ref<TTerminalConnectionState>;
    readonly statusMessage: Ref<string>;
    readonly session: Ref<ITerminalSessionPayload | null>;

    // ── 私有：服务依赖 ──────────────────────────────────────────────────────────
    private readonly _tauri: ITerminalTauriService;

    // ── 私有：回调 ─────────────────────────────────────────────────────────────
    private _onStatusChange: ((p: ITerminalStatusChangePayload) => void) | null = null;
    private _onOutput: ((p: ITerminalRunOutputEvent) => void) | null = null;
    private _onRunComplete: ((p: ITerminalRunCompletePayload) => void) | null = null;

    // ── 私有：xterm 实例 ────────────────────────────────────────────────────────
    private _terminalRef = shallowRef<Terminal | null>(null);
    private _fitAddonRef = shallowRef<FitAddon | null>(null);
    private _webglAddonRef = shallowRef<WebglAddon | null>(null);

    // ── 私有：DOM ───────────────────────────────────────────────────────────────
    private _hostEl: HTMLElement | null = null;

    // ── 私有：主题与设置（UI 层传入） ───────────────────────────────────────────
    private _theme: TThemeMode = 'dark';
    private _settings: ITerminalSettings | null = null;

    // ── 私有：可见性 ────────────────────────────────────────────────────────────
    private _visible = false;

    // ── 私有：定时器 ────────────────────────────────────────────────────────────
    private _layoutFrameId: number | null = null;
    private _layoutSettleTimeoutId: number | null = null;
    private _viewportFrameId: number | null = null;
    private _programmaticScrollReleaseFrameId: number | null = null;
    private _terminalWriteFrameId: number | null = null;
    private _terminalWriteTimeoutId: number | null = null;
    private _scrollRecoveryTimeoutId: number | null = null;
    private _promptWakeTimeoutId: number | null = null;

    // ── 私有：Tauri 事件监听器 ──────────────────────────────────────────────────
    private _dataUnlisten: UnlistenFn | null = null;
    private _runOutputUnlisten: UnlistenFn | null = null;
    private _runCompleteUnlisten: UnlistenFn | null = null;
    private _exitUnlisten: UnlistenFn | null = null;
    private _eventListenerRegistration: Promise<void> | null = null;
    /**
     * 每次 detach 时递增；registerEventListeners 异步完成时比对版本，
     * 防止 detach 与 re-mount 竞态导致重复监听（Fix-2）。
     */
    private _listenerVersion = 0;

    // ── 私有：DOM 副作用清理函数 ────────────────────────────────────────────────
    private _fontLoadingCleanup: (() => void) | null = null;
    private _visibilityChangeCleanup: (() => void) | null = null;
    private _windowFocusCleanup: (() => void) | null = null;
    private _windowResizeCleanup: (() => void) | null = null;
    private _webglContextLossCleanup: { dispose(): void } | null = null;
    private _resizeObserver: ResizeObserver | null = null;

    // ── 私有：视口同步标志 ──────────────────────────────────────────────────────
    private _shouldClearTextureAtlasOnViewportSync = false;
    private _shouldRefreshViewportOnViewportSync = false;
    private _shouldScrollToBottomOnViewportSync = false;
    private _pendingLayoutSettleSync = false;

    // ── 私有：写缓冲区 ──────────────────────────────────────────────────────────
    private _bufferedTerminalWrite = '';
    private _hiddenTerminalWriteBacklog = '';
    private _pendingScrollToBottomAfterWrite = false;
    private _pendingHiddenScrollToBottom = false;
    private _shouldFitBeforeNextVisibleWrite = false;
    private _pendingInitialPaintRecovery = true;
    private readonly _pendingTerminalWriteCallbacks: Array<() => void> = [];

    // ── 私有：终端状态标志 ──────────────────────────────────────────────────────
    private _isTerminalWriteInFlight = false;
    private _isProgrammaticScrollSync = false;
    private _isAutoFollowEnabled = true;

    // ── 私有：运行追踪 ──────────────────────────────────────────────────────────
    private _activeRunId: string | null = null;
    private _hasStructuredRunOutputForActiveRun = false;

    // ── 私有：渲染器状态 ────────────────────────────────────────────────────────
    private _webglRendererBlocked = false;
    private _previousHostSize = { width: 0, height: 0 };
    private _previousTerminalSize = { cols: 0, rows: 0 };

    // ── 构造 ────────────────────────────────────────────────────────────────────

    constructor(options: ITerminalSessionOptions) {
        this.id = options.sessionId;
        // 优先使用 registry 注入的共享 ref，保证状态钩子与实例同源（Fix-3）
        this.status = options.statusRef ?? ref<TTerminalConnectionState>('connecting');
        this.statusMessage = options.statusMessageRef ?? ref('正在连接 WSL2 终端…');
        this.session = ref<ITerminalSessionPayload | null>(null);
        this._tauri = options.tauriService;
        this._onStatusChange = options.onStatusChange ?? null;
        this._onOutput = options.onOutput ?? null;
        this._onRunComplete = options.onRunComplete ?? null;
    }

    // ── 公共：更新回调（组件重挂载时） ──────────────────────────────────────────

    updateCallbacks(callbacks: ITerminalSessionCallbacks): void {
        this._onStatusChange = callbacks.onStatusChange ?? null;
        this._onOutput = callbacks.onOutput ?? null;
        this._onRunComplete = callbacks.onRunComplete ?? null;
    }

    // ── 公共：初始化并挂载到 DOM（由 UI 层在 onMounted 调用） ───────────────────

    initWithHost(el: HTMLElement, theme: TThemeMode, settings: ITerminalSettings): void {
        this._hostEl = el;
        this._theme = theme;
        this._settings = settings;
        this._createTerminal();
    }

    // ── 公共：设置可见性 ────────────────────────────────────────────────────────

    setVisible(visible: boolean): void {
        this._visible = visible;
    }

    // ── 公共：应用主题与终端设置变更 ────────────────────────────────────────────

    applySettings(theme: TThemeMode, settings: ITerminalSettings): void {
        this._theme = theme;
        this._settings = settings;
        this._applyTerminalSettings();
    }

    // ── 公共：处理面板显示事件（visible 从 false 变 true 时由 UI watcher 调用） ──

    handleBecomeVisible(): void {
        this._createTerminal();
        this._ensurePreferredRenderer();
        this._syncTerminalSurfaceTone();
        this._scheduleLayoutSync({ settle: true });
        this._scheduleViewportSync({ clearTextureAtlas: true, refresh: true, scrollToBottom: true });
        if (this._hiddenTerminalWriteBacklog) {
            this._shouldFitBeforeNextVisibleWrite = true;
            this._flushTerminalWriteBufferNow({ forceLayout: true });
        }
        this.focusTerminal();
    }

    // ── 公共：订阅 Tauri 事件（由 UI 层在 onMounted 调用） ──────────────────────

    registerEventListeners(): Promise<void> {
        if (
            this._dataUnlisten &&
            this._runOutputUnlisten &&
            this._runCompleteUnlisten &&
            this._exitUnlisten
        ) {
            return Promise.resolve();
        }
        if (this._eventListenerRegistration) {
            return this._eventListenerRegistration;
        }
        // 捕获当前版本号；若异步期间 detach 使版本递增，则丢弃本次注册（Fix-2）
        const version = this._listenerVersion;
        this._eventListenerRegistration = (async () => {
            const [dl, rl, cl, el] = await Promise.all([
                listen<ITerminalDataEvent>('terminal:data', (e) => this._handleDataEvent(e)),
                listen<ITerminalRunOutputEvent>('terminal:run-output', (e) =>
                    this._handleRunOutputEvent(e),
                ),
                listen<ITerminalRunCompletePayload>('terminal:run-complete', (e) =>
                    this._handleRunCompleteEvent(e),
                ),
                listen<ITerminalExitEvent>('terminal:exit', (e) => this._handleExitEvent(e)),
            ]);
            if (this._listenerVersion !== version) {
                // detach 在注册期间被调用，立即释放这批监听器避免泄漏
                dl(); rl(); cl(); el();
                return;
            }
            this._dataUnlisten = dl;
            this._runOutputUnlisten = rl;
            this._runCompleteUnlisten = cl;
            this._exitUnlisten = el;
        })().finally(() => {
            this._eventListenerRegistration = null;
        });
        return this._eventListenerRegistration;
    }

    // ── 公共：建立 PTY 连接 ─────────────────────────────────────────────────────

    async ensureConnect(): Promise<void> {
        const runtimeReady = await waitForDesktopRuntime();
        if (!runtimeReady) {
            this._emitStatus('error', '内置终端仅支持 Tauri 桌面端。');
            return;
        }
        const terminal = this._terminalRef.value;
        if (!terminal) return;

        this._emitStatus('connecting', '正在连接 WSL2 终端…');
        await nextTick();
        this._syncTerminalLayout();
        try {
            const payload = await this._tauri.ensureTerminalSession({
                sessionId: this.id,
                cwd: null,
                cols: resolveInteger(terminal.cols, DEFAULT_COLS, 2, 5000),
                rows: resolveInteger(terminal.rows, DEFAULT_ROWS, 1, 3000),
            });
            this.session.value = payload;
            if (!payload.created && payload.initialOutput) {
                terminal.reset();
                this._bufferedTerminalWrite = '';
                this._hiddenTerminalWriteBacklog = '';
                this._pendingScrollToBottomAfterWrite = false;
                this._pendingHiddenScrollToBottom = false;
                this._isAutoFollowEnabled = true;
                this._pendingInitialPaintRecovery = true;
                this._queueTerminalWrite(payload.initialOutput, { scrollToBottom: true });
                this._flushTerminalWriteBufferNow({ forceLayout: true });
            }
            if (payload.created && !payload.initialOutput) {
                this._pendingInitialPaintRecovery = true;
                this._schedulePromptWake();
            }
            this._emitStatus('ready', `${payload.shellLabel} 已连接`);
            this._ensurePreferredRenderer();
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

    // ── 公共：重试连接 ──────────────────────────────────────────────────────────

    async retry(): Promise<void> {
        this._terminalRef.value?.reset();
        this._resetTerminalRunCapture();
        this._isAutoFollowEnabled = true;
        this._pendingInitialPaintRecovery = true;
        await this.ensureConnect();
    }

    // ── 公共：聚焦终端 ──────────────────────────────────────────────────────────

    focusTerminal(): void {
        this._terminalRef.value?.focus();
    }

    // ── 公共：清屏 ──────────────────────────────────────────────────────────────

    async clearScreen(): Promise<void> {
        this._terminalRef.value?.clear();
        this._isAutoFollowEnabled = true;
        this._scheduleViewportSync({ scrollToBottom: true, refresh: true });
        if (!this.session.value) return;
        await this._tauri.writeTerminalInput({ sessionId: this.id, data: '\u000c' });
        this.focusTerminal();
    }

    // ── 公共：中断执行 ──────────────────────────────────────────────────────────

    async interrupt(): Promise<void> {
        if (!this.session.value) return;
        await this._tauri.writeTerminalInput({ sessionId: this.id, data: '\u0003' });
        this._isAutoFollowEnabled = true;
        this._scheduleViewportSync({ scrollToBottom: true });
        this.focusTerminal();
    }

    // ── 公共：发送命令 ──────────────────────────────────────────────────────────

    async sendCommand(command: string): Promise<void> {
        const normalized = command.trim();
        if (!normalized) return;
        if (!this.session.value) {
            await this.ensureConnect();
        }
        if (!this.session.value) {
            throw new Error('WSL2 终端尚未就绪。');
        }
        await this._tauri.writeTerminalInput({ sessionId: this.id, data: `${normalized}\n` });
        this._isAutoFollowEnabled = true;
        this._scheduleViewportSync({ scrollToBottom: true });
        this.focusTerminal();
    }

    // ── 公共：追踪运行 ID ────────────────────────────────────────────────────────

    trackRun(nextRunId: string | null): void {
        if (this._activeRunId && this._activeRunId !== nextRunId) {
            this._emitRunComplete(this._buildRunCompletePayload(this._activeRunId, -1));
        }
        if (!nextRunId) {
            this._clearTrackedRunState();
            return;
        }
        this._activeRunId = nextRunId;
        this._hasStructuredRunOutputForActiveRun = false;
        this._isAutoFollowEnabled = true;
        this._shouldFitBeforeNextVisibleWrite = true;
        this._scheduleLayoutSync();
        this._scheduleViewportSync({ scrollToBottom: true });
    }

    // ── 公共：注册渲染恢复监听器（由 UI 层 onMounted 调用） ─────────────────────

    bindRenderRecoveryListeners(): void {
        if (!this._windowFocusCleanup) {
            const handleWindowFocus = (): void => {
                if (!this._visible) return;
                this._ensurePreferredRenderer();
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
                this._ensurePreferredRenderer();
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
                this._ensurePreferredRenderer();
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

    // ── 公共：分离（清理 DOM / 事件，但不销毁 PTY） ─────────────────────────────

    detach(): void {
        // 版本递增；令任何尚在飞行中的 registerEventListeners 异步自行丢弃（Fix-2）
        this._listenerVersion++;

        this._resizeObserver?.disconnect();
        this._resizeObserver = null;
        this._windowResizeCleanup?.();
        this._windowFocusCleanup?.();
        this._visibilityChangeCleanup?.();
        this._fontLoadingCleanup?.();

        this._dataUnlisten?.();
        this._runOutputUnlisten?.();
        this._runCompleteUnlisten?.();
        this._exitUnlisten?.();
        this._dataUnlisten = null;
        this._runOutputUnlisten = null;
        this._runCompleteUnlisten = null;
        this._exitUnlisten = null;

        this._clearLayoutFrame();
        this._clearLayoutSettleTimeout();
        this._clearViewportFrame();
        this._clearProgrammaticScrollReleaseFrame();
        this._clearTerminalWriteFrame();
        this._clearTerminalWriteTimeout();
        this._clearScrollRecoveryTimeout();
        this._clearPromptWakeTimeout();

        this._resetTerminalRunCapture();
        this._bufferedTerminalWrite = '';
        this._hiddenTerminalWriteBacklog = '';
        this._pendingTerminalWriteCallbacks.length = 0;
        this._isTerminalWriteInFlight = false;
        this._pendingScrollToBottomAfterWrite = false;
        this._pendingHiddenScrollToBottom = false;
        this._shouldFitBeforeNextVisibleWrite = false;
        this._pendingInitialPaintRecovery = true;
        this._previousHostSize = { width: 0, height: 0 };

        this._disposeWebglRenderer();

        this._hostEl = null;
        this._visible = false;
    }

    // ── 公共：完全销毁（含 Terminal 实例，由 registry.dispose() 调用） ───────────

    async dispose(): Promise<void> {
        this.detach();
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

    private _emitOutput(payload: ITerminalRunOutputEvent): void {
        this._onOutput?.(payload);
    }

    private _emitRunComplete(payload: ITerminalRunCompletePayload): void {
        this._onRunComplete?.(payload);
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
    private _clearPromptWakeTimeout(): void {
        if (this._promptWakeTimeoutId !== null) {
            window.clearTimeout(this._promptWakeTimeoutId);
            this._promptWakeTimeoutId = null;
        }
    }
    private _clearProgrammaticScrollReleaseFrame(): void {
        if (this._programmaticScrollReleaseFrameId !== null) {
            cancelAnimationFrame(this._programmaticScrollReleaseFrameId);
            this._programmaticScrollReleaseFrameId = null;
        }
    }

    // ── 私有：布局与视口调度 ─────────────────────────────────────────────────────

    private _scheduleLayoutSync(options?: TTerminalLayoutSyncOptions): void {
        if (options?.settle) {
            this._pendingLayoutSettleSync = true;
        }
        this._clearLayoutSettleTimeout();
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
            fitAddon.fit();
        } catch (error) {
            console.warn('终端尺寸同步失败', error);
        }
    }

    private _scheduleViewportSync(options?: {
        clearTextureAtlas?: boolean;
        refresh?: boolean;
        scrollToBottom?: boolean;
    }): void {
        if (options?.clearTextureAtlas) this._shouldClearTextureAtlasOnViewportSync = true;
        if (options?.refresh) this._shouldRefreshViewportOnViewportSync = true;
        if (options?.scrollToBottom) this._shouldScrollToBottomOnViewportSync = true;
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

    // ── 私有：写缓冲区 ───────────────────────────────────────────────────────────

    private _flushPendingTerminalWriteCallbacks(): void {
        if (this._pendingTerminalWriteCallbacks.length === 0) return;
        const cbs = this._pendingTerminalWriteCallbacks.splice(
            0,
            this._pendingTerminalWriteCallbacks.length,
        );
        cbs.forEach((cb) => cb());
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
        if (!this._visible) {
            if (this._bufferedTerminalWrite) {
                this._hiddenTerminalWriteBacklog += this._bufferedTerminalWrite;
                this._bufferedTerminalWrite = '';
            }
            if (this._pendingScrollToBottomAfterWrite) {
                this._pendingHiddenScrollToBottom = true;
                this._pendingScrollToBottomAfterWrite = false;
            }
            return;
        }
        if (this._isTerminalWriteInFlight) return;
        if (this._hiddenTerminalWriteBacklog) {
            this._bufferedTerminalWrite = `${this._hiddenTerminalWriteBacklog}${this._bufferedTerminalWrite}`;
            this._hiddenTerminalWriteBacklog = '';
            if (this._pendingHiddenScrollToBottom) {
                this._pendingScrollToBottomAfterWrite = true;
                this._pendingHiddenScrollToBottom = false;
            }
        }
        if (!this._bufferedTerminalWrite) {
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
        const chunk = this._bufferedTerminalWrite;
        const shouldScroll = this._pendingScrollToBottomAfterWrite;
        this._bufferedTerminalWrite = '';
        this._pendingScrollToBottomAfterWrite = false;
        this._isTerminalWriteInFlight = true;
        terminal.write(chunk, () => {
            this._isTerminalWriteInFlight = false;
            this._scheduleViewportSync({ scrollToBottom: shouldScroll });
            if (this._pendingInitialPaintRecovery && this._hasTerminalRenderableContent()) {
                this._pendingInitialPaintRecovery = false;
                this._syncTerminalLayout();
                this._scheduleViewportSync({ refresh: true, scrollToBottom: true });
            }
            if (this._bufferedTerminalWrite) {
                this._flushTerminalWriteBufferNow();
                return;
            }
            this._flushPendingTerminalWriteCallbacks();
        });
    }

    private _scheduleTerminalWriteFlush(): void {
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
        if (!this._visible) {
            this._hiddenTerminalWriteBacklog += value;
            if (options?.scrollToBottom) this._pendingHiddenScrollToBottom = true;
            return;
        }
        this._bufferedTerminalWrite += value;
        if (options?.scrollToBottom) this._pendingScrollToBottomAfterWrite = true;
        this._scheduleTerminalWriteFlush();
    }

    // ── 私有：终端事件处理 ────────────────────────────────────────────────────────

    private _handleDataEvent(event: { payload: ITerminalDataEvent }): void {
        if (event.payload.sessionId !== this.id || !event.payload.data) return;
        if (this._activeRunId && !this._hasStructuredRunOutputForActiveRun) {
            this._emitOutput({
                sessionId: this.id,
                runId: this._activeRunId,
                data: event.payload.data,
            });
        }
        this._queueTerminalWrite(event.payload.data, { scrollToBottom: true });
    }

    private _handleRunOutputEvent(event: { payload: ITerminalRunOutputEvent }): void {
        if (event.payload.sessionId !== this.id || !event.payload.data) return;
        this._hasStructuredRunOutputForActiveRun = true;
        this._emitOutput(event.payload);
    }

    private _handleRunCompleteEvent(event: { payload: ITerminalRunCompletePayload }): void {
        if (event.payload.sessionId !== this.id) return;
        this._emitTerminalRunComplete(event.payload);
    }

    private _handleExitEvent(event: { payload: ITerminalExitEvent }): void {
        if (event.payload.sessionId !== this.id) return;
        this.session.value = null;
        const message =
            event.payload.exitCode === null
                ? 'WSL2 终端已断开。'
                : `WSL2 终端已退出（代码 ${event.payload.exitCode}）。`;
        if (this._activeRunId) {
            this._emitRunComplete(
                this._buildRunCompletePayload(this._activeRunId, event.payload.exitCode ?? -1),
            );
            this._resetTerminalRunCapture();
        }
        this._queueTerminalWrite(`\r\n\x1b[90m${message}\x1b[0m\r\n`, { scrollToBottom: true });
        this._flushTerminalWriteBufferNow();
        this._scheduleViewportSync({ scrollToBottom: true });
        this._emitStatus('closed', message);
    }

    private _emitTerminalRunComplete(payload: ITerminalRunCompletePayload): void {
        this._clearTrackedRunState(payload.runId);
        if (!this._visible) {
            this._emitRunComplete(payload);
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
            this._emitRunComplete(payload);
        };
        fallbackId = window.setTimeout(
            () => {
                finalize();
            },
            TERMINAL_RUN_COMPLETE_FLUSH_TIMEOUT_MS,
        );
        this.focusTerminal();
        this._flushTerminalWriteBufferNow({
            afterWrite: () => {
                this._scheduleViewportSync({ scrollToBottom: true });
                finalize();
            },
            forceLayout: true,
        });
    }

    // ── 私有：运行追踪 ───────────────────────────────────────────────────────────

    private _buildRunCompletePayload(
        runId: string,
        exitCode: number | null,
    ): ITerminalRunCompletePayload {
        return {
            sessionId: this.id,
            runId,
            exitCode,
            finishedAt: new Date().toISOString(),
        } as ITerminalRunCompletePayload;
    }

    private _clearTrackedRunState(runId?: string): void {
        if (runId && this._activeRunId !== runId) return;
        this._activeRunId = null;
        this._hasStructuredRunOutputForActiveRun = false;
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
            const addon = new WebglAddon();
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
            console.warn('WebGL 终端渲染器初始化失败，已回退默认渲染器', error);
        }
    }

    private _disposeWebglRenderer(): void {
        this._webglContextLossCleanup?.dispose();
        this._webglContextLossCleanup = null;
        this._webglAddonRef.value?.dispose();
        this._webglAddonRef.value = null;
    }

    private _clearTerminalTextureAtlas(): void {
        if (this._webglAddonRef.value) {
            this._webglAddonRef.value.clearTextureAtlas();
            return;
        }
        this._terminalRef.value?.clearTextureAtlas();
    }

    // ── 私有：视口辅助 ────────────────────────────────────────────────────────────

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
        callback();
        this._releaseProgrammaticScrollLock();
    }

    private _scheduleScrollRecovery(): void {
        if (!this._webglAddonRef.value) return;
        this._clearScrollRecoveryTimeout();
        this._scrollRecoveryTimeoutId = window.setTimeout(() => {
            this._scrollRecoveryTimeoutId = null;
            this._scheduleViewportSync({ clearTextureAtlas: true, refresh: true });
        }, TERMINAL_SCROLL_RECOVERY_DELAY_MS);
    }

    private _hasTerminalRenderableContent(): boolean {
        const terminal = this._terminalRef.value;
        if (!terminal) return false;
        const buf = terminal.buffer.active;
        for (let i = 0; i < buf.length; i++) {
            const line = buf.getLine(i);
            if (line?.translateToString(true).trim().length) return true;
        }
        return false;
    }

    // ── 私有：外观同步 ────────────────────────────────────────────────────────────

    private _syncTerminalSurfaceTone(): void {
        const background = getXtermTheme().background ?? '#15191e';
        if (this._hostEl) {
            this._hostEl.style.setProperty('--terminal-fill', background);
            this._hostEl.style.backgroundColor = background;
        }
        if (this._terminalRef.value?.element) {
            this._terminalRef.value.element.style.setProperty('--terminal-fill', background);
            this._terminalRef.value.element.style.backgroundColor = background;
        }
    }

    private _applyTerminalSettings(): void {
        const terminal = this._terminalRef.value;
        if (!terminal || !this._settings) return;
        const opts = buildTerminalOptions(this._settings);
        terminal.options.theme = opts.theme;
        terminal.options.fontFamily = opts.fontFamily;
        terminal.options.fontSize = opts.fontSize;
        terminal.options.lineHeight = opts.lineHeight;
        terminal.options.cursorBlink = opts.cursorBlink;
        terminal.options.cursorStyle = opts.cursorStyle;
        terminal.options.scrollback = opts.scrollback;
        terminal.options.bellStyle = opts.bellStyle;
        this._syncTerminalSurfaceTone();
        this._scheduleLayoutSync({ settle: true });
        this._scheduleViewportSync({ clearTextureAtlas: true, refresh: true });
    }

    // ── 私有：剪贴板 ─────────────────────────────────────────────────────────────

    private async _writeSelectionToClipboard(): Promise<void> {
        const terminal = this._terminalRef.value;
        if (!terminal || !this._settings?.copyOnSelect) return;
        const selection = terminal.getSelection();
        if (!selection) return;
        const next = this._settings.trimFinalNewlineOnCopy
            ? selection.replace(/[\r\n]+$/u, '')
            : selection;
        if (!next) return;
        void writeClipboardText(next).catch(() => { });
    }

    // ── 私有：提示符唤醒 ─────────────────────────────────────────────────────────

    private _schedulePromptWake(): void {
        this._clearPromptWakeTimeout();
        this._promptWakeTimeoutId = window.setTimeout(() => {
            this._promptWakeTimeoutId = null;
            if (!this.session.value || this._hasTerminalRenderableContent()) return;
            void this._tauri.writeTerminalInput({ sessionId: this.id, data: '\n' }).catch(() => { });
        }, TERMINAL_PROMPT_WAKE_DELAY_MS);
    }

    // ── 私有：ResizeObserver 绑定 ─────────────────────────────────────────────────

    private _bindResizeObserver(): void {
        if (typeof ResizeObserver === 'undefined' || !this._hostEl) return;
        this._resizeObserver?.disconnect();
        this._resizeObserver = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry || !this._didHostSizeChange(entry.contentRect.width, entry.contentRect.height))
                return;
            if (this._visible) this._scheduleLayoutSync();
        });
        this._resizeObserver.observe(this._hostEl);

        if (this._windowResizeCleanup) return;
        const handleWindowResize = (): void => {
            if (!this._visible) return;
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

    // ── 私有：尺寸变化检测 ────────────────────────────────────────────────────────

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

    // ── 私有：终端创建 ────────────────────────────────────────────────────────────

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
        this._ensurePreferredRenderer();
        this._syncTerminalSurfaceTone();
        this._pendingInitialPaintRecovery = true;
        this._scheduleLayoutSync({ settle: true });
        this._scheduleViewportSync({ clearTextureAtlas: true, refresh: true, scrollToBottom: true });
    }

    private _createTerminal(): void {
        if (!this._hostEl) return;
        if (!this._terminalRef.value) {
            const terminal = new Terminal(
                buildTerminalOptions(this._settings ?? this._fallbackSettings()),
            );
            const fitAddon = new FitAddon();
            terminal.loadAddon(fitAddon);
            this._terminalRef.value = terminal;
            this._fitAddonRef.value = fitAddon;
            this._previousTerminalSize = { cols: terminal.cols, rows: terminal.rows };

            terminal.onData((data) => {
                if (!this.session.value) return;
                if (isPrintableTerminalInput(data) || data === '\r' || data === '\n') {
                    this._isAutoFollowEnabled = true;
                }
                void this._tauri
                    .writeTerminalInput({ sessionId: this.id, data })
                    .catch((error: unknown) => {
                        this._emitStatus('error', toErrorMessage(error, '终端输入发送失败。'));
                    });
            });
            terminal.onScroll(() => {
                if (this._isProgrammaticScrollSync) return;
                const t = this._terminalRef.value;
                if (!t) return;
                this._isAutoFollowEnabled = this._isViewportNearBottom(t);
                if (this._isAutoFollowEnabled) {
                    this._clearScrollRecoveryTimeout();
                    return;
                }
                this._scheduleScrollRecovery();
            });
            terminal.onResize(({ cols, rows }) => {
                if (!this._didTerminalSizeChange(cols, rows)) return;
                this._scheduleViewportSync({ scrollToBottom: true });
                if (!this.session.value) return;
                void this._tauri.resizeTerminalSession({ sessionId: this.id, cols, rows }).catch(() => { });
            });
            terminal.onSelectionChange(() => {
                void this._writeSelectionToClipboard();
            });
        }
        this._attachTerminalToHost();
    }

    /** 临时回退设置（仅在 initWithHost 之前被意外调用时防止崩溃） */
    private _fallbackSettings(): ITerminalSettings {
        return {
            bellMode: 'off',
            copyOnSelect: false,
            trimFinalNewlineOnCopy: true,
            cursorBlink: true,
            cursorStyle: 'block',
            fontFamily: '',
            fontSize: 14,
            lineHeight: 1.2,
            scrollback: 5000,
        } as ITerminalSettings;
    }
}
