import { tauriService } from '@/services/tauri';
import { useEditorStore } from '@/store/editor';
import type { TThemeMode } from '@/types/app';
import type {
  ITerminalDataEvent,
  ITerminalExitEvent,
  ITerminalRunCompletePayload,
  ITerminalRunOutputEvent,
  ITerminalSessionPayload,
  ITerminalStatusChangePayload,
  TTerminalConnectionState,
} from '@/types/terminal';
import { DEFAULT_TERMINAL_SESSION_ID } from '@/types/terminal';
import { waitForDesktopRuntime } from '@/utils/desktop-runtime';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import {
  nextTick,
  onBeforeUnmount,
  onMounted,
  readonly,
  ref,
  shallowRef,
  watch,
  type Ref,
} from 'vue';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 28;
const MIN_RENDERABLE_TERMINAL_WIDTH = 24;
const MIN_RENDERABLE_TERMINAL_HEIGHT = 24;
const TERMINAL_ENABLE_WEBGL_RENDERER = false;
const TERMINAL_WEBGL_RECOVERY_DELAY_MS = 180;
const TERMINAL_LAYOUT_SETTLE_DELAY_MS = 72;
const TERMINAL_OUTPUT_FLUSH_DELAY_MS = 16;
const TERMINAL_SCROLL_RECOVERY_DELAY_MS = 64;
const TERMINAL_SCROLLBACK_LIMIT = 8000;

const createTerminalTheme = (theme: TThemeMode) =>
  theme === 'light'
    ? {
      background: '#f5f7fb',
      foreground: '#111827',
      cursor: '#335cff',
      cursorAccent: '#f5f7fb',
      selectionBackground: 'rgba(76, 111, 255, 0.18)',
      scrollbarSliderBackground: 'rgba(15, 23, 42, 0.12)',
      scrollbarSliderHoverBackground: 'rgba(15, 23, 42, 0.22)',
      scrollbarSliderActiveBackground: 'rgba(51, 92, 255, 0.32)',
      black: '#15181d',
      red: '#c2415b',
      green: '#15803d',
      yellow: '#a16207',
      blue: '#335cff',
      magenta: '#7c3aed',
      cyan: '#0f766e',
      white: '#475569',
      brightBlack: '#64748b',
      brightRed: '#e11d48',
      brightGreen: '#16a34a',
      brightYellow: '#ca8a04',
      brightBlue: '#4f46e5',
      brightMagenta: '#9333ea',
      brightCyan: '#0891b2',
      brightWhite: '#0f172a',
    }
    : {
      background: '#15191e',
      foreground: '#d7dce5',
      cursor: '#7c89ff',
      cursorAccent: '#15191e',
      selectionBackground: 'rgba(94, 106, 210, 0.26)',
      scrollbarSliderBackground: 'rgba(255, 255, 255, 0.1)',
      scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.18)',
      scrollbarSliderActiveBackground: 'rgba(124, 137, 255, 0.34)',
      black: '#111318',
      red: '#ff7b88',
      green: '#5dd39e',
      yellow: '#f3c969',
      blue: '#7c89ff',
      magenta: '#c792ea',
      cyan: '#89ddff',
      white: '#d7dce5',
      brightBlack: '#656b76',
      brightRed: '#ff9aa5',
      brightGreen: '#74e2ad',
      brightYellow: '#f8d88b',
      brightBlue: '#9aa6ff',
      brightMagenta: '#d7a6ff',
      brightCyan: '#a9e7ff',
      brightWhite: '#f5f7fb',
    };

const resolveErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const resolveInteger = (
  value: number | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const integer = Math.trunc(numeric);
  if (!Number.isFinite(integer)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, integer));
};

const isPrintableTerminalInput = (data: string): boolean => {
  if (data.length === 0) {
    return false;
  }

  const firstCharacterCode = data.charCodeAt(0);
  return firstCharacterCode >= 0x20 && firstCharacterCode !== 0x7f;
};

type TUseIntegratedTerminalOptions = {
  visible: Ref<boolean>;
  theme: Ref<TThemeMode>;
  sessionId?: string;
  onStatusChange?: (payload: ITerminalStatusChangePayload) => void;
  onOutput?: (payload: ITerminalRunOutputEvent) => void;
  onRunComplete?: (payload: ITerminalRunCompletePayload) => void;
};

type TTerminalLayoutSyncOptions = {
  settle?: boolean;
};

const sharedStatus = ref<TTerminalConnectionState>('connecting');
const sharedStatusMessage = ref('正在连接 WSL2 终端…');
const sharedSession = ref<ITerminalSessionPayload | null>(null);
const sharedTerminalRef = shallowRef<Terminal | null>(null);
const sharedFitAddonRef = shallowRef<FitAddon | null>(null);
const sharedWebglAddonRef = shallowRef<WebglAddon | null>(null);

export const useIntegratedTerminalStatus = () => ({
  status: readonly(sharedStatus),
  statusMessage: readonly(sharedStatusMessage),
});

let sharedVisibleRef: Ref<boolean> | null = null;
let sharedStatusListener: ((payload: ITerminalStatusChangePayload) => void) | null = null;
let sharedOutputListener: ((payload: ITerminalRunOutputEvent) => void) | null = null;
let sharedRunCompleteListener: ((payload: ITerminalRunCompletePayload) => void) | null = null;
let sharedRetryHandler: (() => Promise<void>) | null = null;
let sharedClearScreenHandler: (() => Promise<void>) | null = null;
let sharedInterruptHandler: (() => Promise<void>) | null = null;
let sharedSendCommandHandler: ((command: string) => Promise<void>) | null = null;

export const useIntegratedTerminalControls = () => ({
  status: readonly(sharedStatus),
  statusMessage: readonly(sharedStatusMessage),
  session: readonly(sharedSession),
  retry: async (): Promise<void> => {
    await sharedRetryHandler?.();
  },
  clearScreen: async (): Promise<void> => {
    await sharedClearScreenHandler?.();
  },
  interrupt: async (): Promise<void> => {
    await sharedInterruptHandler?.();
  },
  sendCommand: async (command: string): Promise<void> => {
    await sharedSendCommandHandler?.(command);
  },
});

let fontLoadingCleanup: (() => void) | null = null;
let visibilityChangeCleanup: (() => void) | null = null;
let windowFocusCleanup: (() => void) | null = null;
let windowResizeCleanup: (() => void) | null = null;
let webglContextLossCleanup: { dispose(): void } | null = null;
let resizeObserver: ResizeObserver | null = null;

let layoutFrameId: number | null = null;
let layoutSettleTimeoutId: number | null = null;
let viewportFrameId: number | null = null;
let pendingLayoutSettleSync = false;

let shouldClearTextureAtlasOnViewportSync = false;
let shouldRefreshViewportOnViewportSync = false;
let shouldScrollToBottomOnViewportSync = false;

let dataUnlisten: UnlistenFn | null = null;
let runOutputUnlisten: UnlistenFn | null = null;
let runCompleteUnlisten: UnlistenFn | null = null;
let exitUnlisten: UnlistenFn | null = null;
let eventListenerRegistration: Promise<void> | null = null;

let programmaticScrollReleaseFrameId: number | null = null;
let terminalWriteFrameId: number | null = null;
let terminalWriteTimeoutId: number | null = null;
let scrollRecoveryTimeoutId: number | null = null;

let isTerminalWriteInFlight = false;
let isProgrammaticScrollSync = false;
let isAutoFollowEnabled = true;
let bufferedTerminalWrite = '';
let hiddenTerminalWriteBacklog = '';
let pendingScrollToBottomAfterWrite = false;
let pendingHiddenScrollToBottom = false;
let shouldFitBeforeNextVisibleWrite = false;

const pendingTerminalWriteCallbacks: Array<() => void> = [];
let activeRunId: string | null = null;

let webglRendererBlocked = false;
let previousHostSize = { width: 0, height: 0 };
let previousTerminalSize = { cols: 0, rows: 0 };

const didHostSizeChange = (width: number, height: number): boolean => {
  const normalizedWidth = Math.round(width);
  const normalizedHeight = Math.round(height);

  if (normalizedWidth <= 0 || normalizedHeight <= 0) {
    return false;
  }

  if (
    previousHostSize.width === normalizedWidth &&
    previousHostSize.height === normalizedHeight
  ) {
    return false;
  }

  previousHostSize = {
    width: normalizedWidth,
    height: normalizedHeight,
  };

  return true;
};

const didTerminalSizeChange = (cols: number, rows: number): boolean => {
  const normalizedCols = Math.max(0, Math.trunc(cols));
  const normalizedRows = Math.max(0, Math.trunc(rows));

  if (normalizedCols <= 0 || normalizedRows <= 0) {
    return false;
  }

  if (
    previousTerminalSize.cols === normalizedCols &&
    previousTerminalSize.rows === normalizedRows
  ) {
    return false;
  }

  previousTerminalSize = {
    cols: normalizedCols,
    rows: normalizedRows,
  };

  return true;
};

export const useIntegratedTerminal = ({
  visible,
  theme,
  sessionId = DEFAULT_TERMINAL_SESSION_ID,
  onStatusChange,
  onOutput,
  onRunComplete,
}: TUseIntegratedTerminalOptions) => {
  const editorStore = useEditorStore();
  sharedVisibleRef = visible;
  sharedStatusListener = onStatusChange ?? null;
  sharedOutputListener = onOutput ?? null;
  sharedRunCompleteListener = onRunComplete ?? null;

  const hostRef = ref<HTMLElement | null>(null);
  const status = sharedStatus;
  const statusMessage = sharedStatusMessage;
  const session = sharedSession;
  const terminalRef = sharedTerminalRef;
  const fitAddonRef = sharedFitAddonRef;
  const webglAddonRef = sharedWebglAddonRef;

  const buildRunCompletePayload = (
    runId: string,
    exitCode: number | null,
  ): ITerminalRunCompletePayload =>
  ({
    sessionId,
    runId,
    exitCode,
    finishedAt: new Date().toISOString(),
  } as ITerminalRunCompletePayload);

  const emitStatus = (state: TTerminalConnectionState, message: string): void => {
    status.value = state;
    statusMessage.value = message;
    sharedStatusListener?.({ state, message });
  };

  const emitOutput = (payload: ITerminalRunOutputEvent): void => {
    sharedOutputListener?.(payload);
  };

  const emitRunComplete = (payload: ITerminalRunCompletePayload): void => {
    sharedRunCompleteListener?.(payload);
  };

  const isTerminalVisible = (): boolean => Boolean(sharedVisibleRef?.value);

  const clearLayoutFrame = (): void => {
    if (layoutFrameId !== null) {
      cancelAnimationFrame(layoutFrameId);
      layoutFrameId = null;
    }
  };
  const clearViewportFrame = (): void => {
    if (viewportFrameId !== null) {
      cancelAnimationFrame(viewportFrameId);
      viewportFrameId = null;
    }
  };
  const clearLayoutSettleTimeout = (): void => {
    if (layoutSettleTimeoutId !== null) {
      window.clearTimeout(layoutSettleTimeoutId);
      layoutSettleTimeoutId = null;
    }
  };
  const clearTerminalWriteFrame = (): void => {
    if (terminalWriteFrameId !== null) {
      cancelAnimationFrame(terminalWriteFrameId);
      terminalWriteFrameId = null;
    }
  };
  const clearTerminalWriteTimeout = (): void => {
    if (terminalWriteTimeoutId !== null) {
      window.clearTimeout(terminalWriteTimeoutId);
      terminalWriteTimeoutId = null;
    }
  };
  const clearScrollRecoveryTimeout = (): void => {
    if (scrollRecoveryTimeoutId !== null) {
      window.clearTimeout(scrollRecoveryTimeoutId);
      scrollRecoveryTimeoutId = null;
    }
  };

  const flushPendingTerminalWriteCallbacks = (): void => {
    if (pendingTerminalWriteCallbacks.length === 0) {
      return;
    }
    const callbacks = pendingTerminalWriteCallbacks.splice(0, pendingTerminalWriteCallbacks.length);
    callbacks.forEach((callback) => {
      callback();
    });
  };

  const flushTerminalWriteBufferNow = (options?: {
    afterWrite?: () => void;
    forceLayout?: boolean;
  }): void => {
    if (options?.afterWrite) {
      pendingTerminalWriteCallbacks.push(options.afterWrite);
    }
    clearTerminalWriteFrame();
    clearTerminalWriteTimeout();
    const terminal = terminalRef.value;
    if (!terminal) {
      if (!isTerminalWriteInFlight) {
        flushPendingTerminalWriteCallbacks();
      }
      return;
    }
    if (!isTerminalVisible()) {
      if (bufferedTerminalWrite) {
        hiddenTerminalWriteBacklog += bufferedTerminalWrite;
        bufferedTerminalWrite = '';
      }
      if (pendingScrollToBottomAfterWrite) {
        pendingHiddenScrollToBottom = true;
        pendingScrollToBottomAfterWrite = false;
      }
      return;
    }
    if (isTerminalWriteInFlight) {
      return;
    }
    if (hiddenTerminalWriteBacklog) {
      bufferedTerminalWrite = `${hiddenTerminalWriteBacklog}${bufferedTerminalWrite}`;
      hiddenTerminalWriteBacklog = '';
      if (pendingHiddenScrollToBottom) {
        pendingScrollToBottomAfterWrite = true;
        pendingHiddenScrollToBottom = false;
      }
    }
    if (!bufferedTerminalWrite) {
      if (options?.forceLayout || shouldFitBeforeNextVisibleWrite) {
        syncTerminalLayout();
        shouldFitBeforeNextVisibleWrite = false;
        scheduleViewportSync({ scrollToBottom: true });
      }
      flushPendingTerminalWriteCallbacks();
      return;
    }
    if (options?.forceLayout || shouldFitBeforeNextVisibleWrite) {
      syncTerminalLayout();
      shouldFitBeforeNextVisibleWrite = false;
    }
    const chunk = bufferedTerminalWrite;
    const shouldScrollToBottom = pendingScrollToBottomAfterWrite;
    bufferedTerminalWrite = '';
    pendingScrollToBottomAfterWrite = false;
    isTerminalWriteInFlight = true;
    terminal.write(chunk, () => {
      isTerminalWriteInFlight = false;
      scheduleViewportSync({ scrollToBottom: shouldScrollToBottom });
      if (bufferedTerminalWrite) {
        flushTerminalWriteBufferNow();
        return;
      }
      flushPendingTerminalWriteCallbacks();
    });
  };

  const scheduleTerminalWriteFlush = (): void => {
    if (terminalWriteFrameId === null) {
      terminalWriteFrameId = requestAnimationFrame(() => {
        terminalWriteFrameId = null;
        flushTerminalWriteBufferNow();
      });
    }
    if (terminalWriteTimeoutId !== null) {
      return;
    }
    terminalWriteTimeoutId = window.setTimeout(() => {
      terminalWriteTimeoutId = null;
      flushTerminalWriteBufferNow();
    }, TERMINAL_OUTPUT_FLUSH_DELAY_MS);
  };

  const queueTerminalWrite = (
    value: string,
    options?: {
      scrollToBottom?: boolean;
    },
  ): void => {
    if (!value) {
      return;
    }
    if (!isTerminalVisible()) {
      hiddenTerminalWriteBacklog += value;
      if (options?.scrollToBottom) {
        pendingHiddenScrollToBottom = true;
      }
      return;
    }
    bufferedTerminalWrite += value;
    if (options?.scrollToBottom) {
      pendingScrollToBottomAfterWrite = true;
    }
    scheduleTerminalWriteFlush();
  };

  const syncTerminalSurfaceTone = (): void => {
    const background = createTerminalTheme(theme.value).background;
    hostRef.value?.style.setProperty('--terminal-fill', background);
    if (hostRef.value) {
      hostRef.value.style.backgroundColor = background;
    }
    if (terminalRef.value?.element) {
      terminalRef.value.element.style.setProperty('--terminal-fill', background);
      terminalRef.value.element.style.backgroundColor = background;
    }
  };

  const disposeWebglRenderer = (): void => {
    webglContextLossCleanup?.dispose();
    webglContextLossCleanup = null;
    webglAddonRef.value?.dispose();
    webglAddonRef.value = null;
  };

  const clearTerminalTextureAtlas = (): void => {
    if (webglAddonRef.value) {
      webglAddonRef.value.clearTextureAtlas();
      return;
    }
    terminalRef.value?.clearTextureAtlas();
  };

  const canUseWebglRenderer = (): boolean =>
    TERMINAL_ENABLE_WEBGL_RENDERER &&
    !webglRendererBlocked &&
    typeof window !== 'undefined' &&
    'WebGL2RenderingContext' in window;

  const ensurePreferredRenderer = (): void => {
    const terminal = terminalRef.value;
    if (!terminal || webglAddonRef.value || !canUseWebglRenderer()) {
      return;
    }
    try {
      const addon = new WebglAddon();
      webglContextLossCleanup = addon.onContextLoss(() => {
        disposeWebglRenderer();
        window.setTimeout(() => {
          ensurePreferredRenderer();
          scheduleLayoutSync();
          scheduleViewportSync({ clearTextureAtlas: true, refresh: true, scrollToBottom: true });
        }, TERMINAL_WEBGL_RECOVERY_DELAY_MS);
      });
      terminal.loadAddon(addon);
      webglAddonRef.value = addon;
    } catch (error) {
      webglRendererBlocked = true;
      console.warn('WebGL 终端渲染器初始化失败，已回退默认渲染器', error);
    }
  };

  const refreshTerminalViewportNow = (): void => {
    const terminal = terminalRef.value;
    const shouldClearTextureAtlas = shouldClearTextureAtlasOnViewportSync;
    const shouldRefresh = shouldRefreshViewportOnViewportSync || shouldClearTextureAtlas;
    const shouldScrollToBottom = shouldScrollToBottomOnViewportSync;
    shouldClearTextureAtlasOnViewportSync = false;
    shouldRefreshViewportOnViewportSync = false;
    shouldScrollToBottomOnViewportSync = false;
    if (!terminal) {
      return;
    }
    if (shouldClearTextureAtlas) {
      clearTerminalTextureAtlas();
    }
    if (
      shouldScrollToBottom &&
      isTerminalVisible() &&
      isAutoFollowEnabled &&
      !isViewportNearBottom(terminal)
    ) {
      runWithProgrammaticScrollLock(() => {
        terminal.scrollToBottom();
      });
    }
    if (shouldRefresh) {
      terminal.refresh(0, Math.max(terminal.rows - 1, 0));
    }
  };

  const clearProgrammaticScrollReleaseFrame = (): void => {
    if (programmaticScrollReleaseFrameId !== null) {
      cancelAnimationFrame(programmaticScrollReleaseFrameId);
      programmaticScrollReleaseFrameId = null;
    }
  };

  const releaseProgrammaticScrollLock = (): void => {
    clearProgrammaticScrollReleaseFrame();
    programmaticScrollReleaseFrameId = requestAnimationFrame(() => {
      isProgrammaticScrollSync = false;
      programmaticScrollReleaseFrameId = null;
    });
  };

  const runWithProgrammaticScrollLock = (callback: () => void): void => {
    isProgrammaticScrollSync = true;
    callback();
    releaseProgrammaticScrollLock();
  };

  const isViewportNearBottom = (terminal: Terminal): boolean => {
    const buffer = terminal.buffer.active;
    return buffer.baseY - buffer.viewportY <= 1;
  };

  const scheduleViewportSync = (options?: {
    clearTextureAtlas?: boolean;
    refresh?: boolean;
    scrollToBottom?: boolean;
  }): void => {
    if (options?.clearTextureAtlas) {
      shouldClearTextureAtlasOnViewportSync = true;
    }
    if (options?.refresh) {
      shouldRefreshViewportOnViewportSync = true;
    }
    if (options?.scrollToBottom) {
      shouldScrollToBottomOnViewportSync = true;
    }
    clearViewportFrame();
    viewportFrameId = requestAnimationFrame(() => {
      viewportFrameId = null;
      refreshTerminalViewportNow();
    });
  };

  const scheduleScrollRecovery = (): void => {
    if (!webglAddonRef.value) {
      return;
    }

    clearScrollRecoveryTimeout();
    scrollRecoveryTimeoutId = window.setTimeout(() => {
      scrollRecoveryTimeoutId = null;
      scheduleViewportSync({
        clearTextureAtlas: true,
        refresh: true,
      });
    }, TERMINAL_SCROLL_RECOVERY_DELAY_MS);
  };

  const syncTerminalLayout = (): void => {
    const terminal = terminalRef.value;
    const fitAddon = fitAddonRef.value;
    const hostElement = hostRef.value;
    if (!terminal || !fitAddon || !hostElement) {
      return;
    }
    if (
      hostElement.clientWidth < MIN_RENDERABLE_TERMINAL_WIDTH ||
      hostElement.clientHeight < MIN_RENDERABLE_TERMINAL_HEIGHT
    ) {
      return;
    }
    try {
      fitAddon.fit();
    } catch (error) {
      console.warn('终端尺寸同步失败', error);
    }
  };

  const scheduleLayoutSync = (options?: TTerminalLayoutSyncOptions): void => {
    if (options?.settle) {
      pendingLayoutSettleSync = true;
    }

    clearLayoutSettleTimeout();

    if (layoutFrameId !== null) {
      return;
    }

    layoutFrameId = requestAnimationFrame(() => {
      layoutFrameId = null;
      syncTerminalLayout();

      if (!pendingLayoutSettleSync) {
        return;
      }

      pendingLayoutSettleSync = false;
      layoutSettleTimeoutId = window.setTimeout(() => {
        layoutSettleTimeoutId = null;
        syncTerminalLayout();
      }, TERMINAL_LAYOUT_SETTLE_DELAY_MS);
    });
  };

  const focusTerminal = (): void => {
    terminalRef.value?.focus();
  };

  const clearTerminalScreen = async (): Promise<void> => {
    terminalRef.value?.clear();
    isAutoFollowEnabled = true;
    scheduleViewportSync({ scrollToBottom: true, refresh: true });

    if (!session.value) {
      return;
    }

    await tauriService.writeTerminalInput({ sessionId, data: '\u000c' });
    focusTerminal();
  };

  const interruptTerminalExecution = async (): Promise<void> => {
    if (!session.value) {
      return;
    }

    await tauriService.writeTerminalInput({ sessionId, data: '\u0003' });
    isAutoFollowEnabled = true;
    scheduleViewportSync({ scrollToBottom: true });
    focusTerminal();
  };

  const sendCommandToTerminal = async (command: string): Promise<void> => {
    const normalizedCommand = command.trim();
    if (!normalizedCommand) {
      return;
    }

    if (!session.value) {
      await ensureSession();
    }

    if (!session.value) {
      throw new Error('WSL2 终端尚未就绪。');
    }

    await tauriService.writeTerminalInput({
      sessionId,
      data: `${normalizedCommand}\n`,
    });
    isAutoFollowEnabled = true;
    scheduleViewportSync({ scrollToBottom: true });
    focusTerminal();
  };

  const clearTrackedRunState = (runId?: string): void => {
    if (runId && activeRunId !== runId) {
      return;
    }
    activeRunId = null;
  };

  const resetTerminalRunCapture = (): void => {
    clearTrackedRunState();
  };

  const bindResizeObserver = (): void => {
    if (typeof ResizeObserver === 'undefined' || !hostRef.value) {
      return;
    }
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver((entries) => {
      const targetEntry = entries[0];
      if (!targetEntry || !didHostSizeChange(targetEntry.contentRect.width, targetEntry.contentRect.height)) {
        return;
      }

      if (isTerminalVisible()) {
        scheduleLayoutSync();
      }
    });
    resizeObserver.observe(hostRef.value);

    if (windowResizeCleanup) {
      return;
    }
    const handleWindowResize = (): void => {
      if (!isTerminalVisible()) {
        return;
      }

      if (!hostRef.value || !didHostSizeChange(hostRef.value.clientWidth, hostRef.value.clientHeight)) {
        return;
      }

      scheduleLayoutSync();
    };
    window.addEventListener('resize', handleWindowResize);
    windowResizeCleanup = () => {
      window.removeEventListener('resize', handleWindowResize);
      windowResizeCleanup = null;
    };
  };

  const bindRenderRecoveryListeners = (): void => {
    if (!windowFocusCleanup) {
      const handleWindowFocus = (): void => {
        if (!isTerminalVisible()) {
          return;
        }
        ensurePreferredRenderer();
        scheduleLayoutSync({ settle: true });
        scheduleViewportSync({ clearTextureAtlas: true, refresh: true, scrollToBottom: true });
      };
      window.addEventListener('focus', handleWindowFocus);
      windowFocusCleanup = () => {
        window.removeEventListener('focus', handleWindowFocus);
        windowFocusCleanup = null;
      };
    }

    if (!visibilityChangeCleanup) {
      const handleVisibilityChange = (): void => {
        if (document.visibilityState !== 'visible' || !isTerminalVisible()) {
          return;
        }
        ensurePreferredRenderer();
        scheduleLayoutSync({ settle: true });
        scheduleViewportSync({ clearTextureAtlas: true, refresh: true, scrollToBottom: true });
      };
      document.addEventListener('visibilitychange', handleVisibilityChange);
      visibilityChangeCleanup = () => {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        visibilityChangeCleanup = null;
      };
    }

    if (fontLoadingCleanup || typeof document === 'undefined' || !('fonts' in document)) {
      return;
    }
    const fontSet = document.fonts;
    const handleFontMetricsReady = (): void => {
      if (!isTerminalVisible()) {
        return;
      }
      ensurePreferredRenderer();
      scheduleLayoutSync({ settle: true });
      scheduleViewportSync({ refresh: true });
    };
    const readyPromise = fontSet.ready;
    void readyPromise.then(() => {
      handleFontMetricsReady();
    });
    fontSet.addEventListener('loadingdone', handleFontMetricsReady);
    fontLoadingCleanup = () => {
      fontSet.removeEventListener('loadingdone', handleFontMetricsReady);
      fontLoadingCleanup = null;
    };
  };

  const ensureSession = async (): Promise<void> => {
    const runtimeReady = await waitForDesktopRuntime();
    if (!runtimeReady) {
      emitStatus('error', '内置终端仅支持 Tauri 桌面端。');
      return;
    }
    const terminal = terminalRef.value;
    if (!terminal) {
      return;
    }
    emitStatus('connecting', '正在连接 WSL2 终端…');
    await nextTick();
    syncTerminalLayout();
    try {
      const payload = await tauriService.ensureTerminalSession({
        sessionId,
        cwd: null,
        cols: resolveInteger(terminal.cols, DEFAULT_COLS, 2, 5000),
        rows: resolveInteger(terminal.rows, DEFAULT_ROWS, 1, 3000),
      });
      session.value = payload;
      emitStatus('ready', `${payload.shellLabel} 已连接`);
      ensurePreferredRenderer();
      scheduleViewportSync({ scrollToBottom: true });
      if (visible.value) {
        focusTerminal();
      }
    } catch (error) {
      const message = resolveErrorMessage(error, '连接 WSL2 终端失败。');
      emitStatus('error', message);
      terminal.writeln(`\x1b[31m${message}\x1b[0m`, () => {
        scheduleViewportSync({ scrollToBottom: true });
      });
    }
  };

  const handleTerminalDataEvent = (event: { payload: ITerminalDataEvent }): void => {
    if (event.payload.sessionId !== sessionId) {
      return;
    }
    if (!event.payload.data) {
      return;
    }
    queueTerminalWrite(event.payload.data, { scrollToBottom: true });
  };

  const handleTerminalRunOutputEvent = (event: { payload: ITerminalRunOutputEvent }): void => {
    if (event.payload.sessionId !== sessionId || !event.payload.data) {
      return;
    }
    emitOutput(event.payload);
  };

  const emitTerminalRunComplete = (payload: ITerminalRunCompletePayload): void => {
    clearTrackedRunState(payload.runId);
    if (!isTerminalVisible()) {
      emitRunComplete(payload);
      return;
    }

    focusTerminal();
    flushTerminalWriteBufferNow({
      afterWrite: () => {
        scheduleViewportSync({ scrollToBottom: true });
        emitRunComplete(payload);
      },
      forceLayout: true,
    });
  };

  const handleTerminalRunCompleteEvent = (event: { payload: ITerminalRunCompletePayload }): void => {
    if (event.payload.sessionId !== sessionId) {
      return;
    }
    emitTerminalRunComplete(event.payload);
  };

  const handleTerminalExitEvent = (event: { payload: ITerminalExitEvent }): void => {
    if (event.payload.sessionId !== sessionId) {
      return;
    }
    session.value = null;
    const message =
      event.payload.exitCode === null
        ? 'WSL2 终端已断开。'
        : `WSL2 终端已退出（代码 ${event.payload.exitCode}）。`;
    if (activeRunId) {
      emitRunComplete(buildRunCompletePayload(activeRunId, event.payload.exitCode ?? -1));
      resetTerminalRunCapture();
    }
    queueTerminalWrite(`\r\n\x1b[90m${message}\x1b[0m\r\n`, { scrollToBottom: true });
    flushTerminalWriteBufferNow();
    scheduleViewportSync({ scrollToBottom: true });
    emitStatus('closed', message);
  };

  const registerEventListeners = (): Promise<void> => {
    if (dataUnlisten && runOutputUnlisten && runCompleteUnlisten && exitUnlisten) {
      return Promise.resolve();
    }
    if (eventListenerRegistration) {
      return eventListenerRegistration;
    }
    eventListenerRegistration = (async () => {
      const [
        nextDataUnlisten,
        nextRunOutputUnlisten,
        nextRunCompleteUnlisten,
        nextExitUnlisten,
      ] = await Promise.all([
        listen<ITerminalDataEvent>('terminal:data', handleTerminalDataEvent),
        listen<ITerminalRunOutputEvent>('terminal:run-output', handleTerminalRunOutputEvent),
        listen<ITerminalRunCompletePayload>(
          'terminal:run-complete',
          handleTerminalRunCompleteEvent,
        ),
        listen<ITerminalExitEvent>('terminal:exit', handleTerminalExitEvent),
      ]);
      dataUnlisten = nextDataUnlisten;
      runOutputUnlisten = nextRunOutputUnlisten;
      runCompleteUnlisten = nextRunCompleteUnlisten;
      exitUnlisten = nextExitUnlisten;
    })().finally(() => {
      eventListenerRegistration = null;
    });
    return eventListenerRegistration;
  };

  const attachTerminalToHost = (): void => {
    const terminal = terminalRef.value;
    const host = hostRef.value;
    if (!terminal || !host) {
      return;
    }
    if (!terminal.element) {
      terminal.open(host);
    } else if (terminal.element.parentElement !== host) {
      host.replaceChildren(terminal.element);
    }
    previousHostSize = {
      width: Math.round(host.clientWidth),
      height: Math.round(host.clientHeight),
    };
    bindResizeObserver();
    ensurePreferredRenderer();
    syncTerminalSurfaceTone();
    scheduleLayoutSync({ settle: true });
    scheduleViewportSync({ clearTextureAtlas: true, refresh: true, scrollToBottom: true });
  };

  const createTerminal = (): void => {
    if (!hostRef.value) {
      return;
    }

    if (!terminalRef.value) {
      const terminal = new Terminal({
        allowTransparency: false,
        convertEol: true,
        cursorBlink: false,
        cursorStyle: 'bar',
        drawBoldTextInBrightColors: true,
        fontFamily:
          "Berkeley Mono, JetBrains Mono, 'SFMono-Regular', Consolas, 'Courier New', monospace",
        fontSize: 12.5,
        letterSpacing: 0,
        lineHeight: 1.46,
        rows: DEFAULT_ROWS,
        cols: DEFAULT_COLS,
        scrollOnUserInput: true,
        scrollback: TERMINAL_SCROLLBACK_LIMIT,
        scrollSensitivity: 1,
        fastScrollSensitivity: 1,
        smoothScrollDuration: 0,
        theme: createTerminalTheme(theme.value),
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminalRef.value = terminal;
      fitAddonRef.value = fitAddon;
      previousTerminalSize = {
        cols: terminal.cols,
        rows: terminal.rows,
      };

      terminal.onData((data) => {
        if (!session.value) {
          return;
        }
        if (isPrintableTerminalInput(data) || data === '\r' || data === '\n') {
          isAutoFollowEnabled = true;
        }
        void tauriService.writeTerminalInput({ sessionId, data }).catch((error) => {
          emitStatus('error', resolveErrorMessage(error, '终端输入发送失败。'));
        });
      });
      terminal.onScroll(() => {
        if (isProgrammaticScrollSync) {
          return;
        }
        const current = terminalRef.value;
        if (!current) {
          return;
        }
        isAutoFollowEnabled = isViewportNearBottom(current);
        if (isAutoFollowEnabled) {
          clearScrollRecoveryTimeout();
          return;
        }
        scheduleScrollRecovery();
      });
      terminal.onResize(({ cols, rows }) => {
        if (!didTerminalSizeChange(cols, rows)) {
          return;
        }

        scheduleViewportSync({ scrollToBottom: true });

        if (!session.value) {
          return;
        }

        void tauriService.resizeTerminalSession({ sessionId, cols, rows }).catch(() => {
          // 终端在关闭或窗口隐藏时可能触发瞬时 resize，这里忽略即可。
        });
      });
    }

    attachTerminalToHost();
  };

  const retry = async (): Promise<void> => {
    terminalRef.value?.reset();
    resetTerminalRunCapture();
    isAutoFollowEnabled = true;
    await ensureSession();
  };

  sharedRetryHandler = retry;
  sharedClearScreenHandler = clearTerminalScreen;
  sharedInterruptHandler = interruptTerminalExecution;
  sharedSendCommandHandler = sendCommandToTerminal;

  onMounted(async () => {
    createTerminal();
    bindRenderRecoveryListeners();
    await registerEventListeners();
    await ensureSession();
  });

  watch(
    () => theme.value,
    (nextTheme) => {
      const terminal = terminalRef.value;
      if (!terminal) {
        return;
      }
      terminal.options.theme = createTerminalTheme(nextTheme);
      syncTerminalSurfaceTone();
      scheduleViewportSync({ clearTextureAtlas: true, refresh: true });
    },
  );

  watch(
    () => visible.value,
    async (nextVisible) => {
      if (!nextVisible) {
        return;
      }
      await nextTick();
      createTerminal();
      ensurePreferredRenderer();
      syncTerminalSurfaceTone();
      scheduleLayoutSync({ settle: true });
      scheduleViewportSync({ clearTextureAtlas: true, refresh: true, scrollToBottom: true });
      if (hiddenTerminalWriteBacklog) {
        shouldFitBeforeNextVisibleWrite = true;
        flushTerminalWriteBufferNow({ forceLayout: true });
      }
      focusTerminal();
    },
  );

  watch(
    () => editorStore.pendingTerminalRunId,
    (nextRunId) => {
      if (activeRunId && activeRunId !== nextRunId) {
        emitRunComplete(buildRunCompletePayload(activeRunId, -1));
      }
      if (!nextRunId) {
        clearTrackedRunState();
        return;
      }
      activeRunId = nextRunId;
      isAutoFollowEnabled = true;
      shouldFitBeforeNextVisibleWrite = true;
      scheduleLayoutSync();
      scheduleViewportSync({ scrollToBottom: true });
    },
    { flush: 'sync' },
  );

  onBeforeUnmount(() => {
    sharedVisibleRef = null;
    sharedStatusListener = null;
    sharedOutputListener = null;
    sharedRunCompleteListener = null;
    sharedRetryHandler = null;
    sharedClearScreenHandler = null;
    sharedInterruptHandler = null;
    sharedSendCommandHandler = null;

    resizeObserver?.disconnect();
    resizeObserver = null;
    windowResizeCleanup?.();
    windowFocusCleanup?.();
    visibilityChangeCleanup?.();
    fontLoadingCleanup?.();

    dataUnlisten?.();
    runOutputUnlisten?.();
    runCompleteUnlisten?.();
    exitUnlisten?.();
    dataUnlisten = null;
    runOutputUnlisten = null;
    runCompleteUnlisten = null;
    exitUnlisten = null;

    clearLayoutFrame();
    clearLayoutSettleTimeout();
    clearViewportFrame();
    clearProgrammaticScrollReleaseFrame();
    clearTerminalWriteFrame();
    clearTerminalWriteTimeout();
    clearScrollRecoveryTimeout();

    resetTerminalRunCapture();
    bufferedTerminalWrite = '';
    hiddenTerminalWriteBacklog = '';
    pendingTerminalWriteCallbacks.length = 0;
    isTerminalWriteInFlight = false;
    pendingScrollToBottomAfterWrite = false;
    pendingHiddenScrollToBottom = false;
    shouldFitBeforeNextVisibleWrite = false;
    previousHostSize = { width: 0, height: 0 };

    disposeWebglRenderer();
  });

  return {
    hostRef,
    status,
    statusMessage,
    retry,
    focusTerminal,
  };
};
