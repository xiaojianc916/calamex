import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import {
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
  type Ref,
} from 'vue';
import { tauriService } from '@/services/tauri';
import type { TThemeMode } from '@/types/app';
import { DEFAULT_TERMINAL_SESSION_ID } from '@/types/terminal';
import type {
  ITerminalDataEvent,
  ITerminalExitEvent,
  ITerminalSessionPayload,
  ITerminalStatusChangePayload,
  TTerminalConnectionState,
} from '@/types/terminal';
import { waitForDesktopRuntime } from '@/utils/desktop-runtime';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 28;

const createTerminalTheme = (theme: TThemeMode) =>
  theme === 'light'
    ? {
        background: '#f5f7fb',
        foreground: '#111827',
        cursor: '#335cff',
        cursorAccent: '#f5f7fb',
        selectionBackground: 'rgba(76, 111, 255, 0.18)',
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

type TUseIntegratedTerminalOptions = {
  visible: Ref<boolean>;
  theme: Ref<TThemeMode>;
  sessionId?: string;
  onStatusChange?: (payload: ITerminalStatusChangePayload) => void;
};

export const useIntegratedTerminal = ({
  visible,
  theme,
  sessionId = DEFAULT_TERMINAL_SESSION_ID,
  onStatusChange,
}: TUseIntegratedTerminalOptions) => {
  const hostRef = ref<HTMLElement | null>(null);
  const status = ref<TTerminalConnectionState>('connecting');
  const statusMessage = ref('正在连接 WSL2 终端…');
  const session = ref<ITerminalSessionPayload | null>(null);

  const terminalRef = shallowRef<Terminal | null>(null);
  const fitAddonRef = shallowRef<FitAddon | null>(null);

  let resizeObserver: ResizeObserver | null = null;
  let fitFrameId: number | null = null;
  let dataUnlisten: UnlistenFn | null = null;
  let exitUnlisten: UnlistenFn | null = null;

  const emitStatus = (state: TTerminalConnectionState, message: string): void => {
    status.value = state;
    statusMessage.value = message;
    onStatusChange?.({ state, message });
  };

  const clearFitFrame = (): void => {
    if (fitFrameId !== null) {
      cancelAnimationFrame(fitFrameId);
      fitFrameId = null;
    }
  };

  const syncTerminalSize = async (): Promise<void> => {
    const terminal = terminalRef.value;
    const fitAddon = fitAddonRef.value;
    if (!terminal || !fitAddon || !hostRef.value) {
      return;
    }

    fitAddon.fit();

    if (!session.value) {
      return;
    }

    const cols = Math.max(2, terminal.cols || DEFAULT_COLS);
    const rows = Math.max(1, terminal.rows || DEFAULT_ROWS);
    await tauriService.resizeTerminalSession({
      sessionId,
      cols,
      rows,
    });
  };

  const scheduleFit = (): void => {
    clearFitFrame();
    fitFrameId = requestAnimationFrame(() => {
      fitFrameId = null;
      void syncTerminalSize();
    });
  };

  const focusTerminal = (): void => {
    terminalRef.value?.focus();
  };

  const bindResizeObserver = (): void => {
    if (typeof ResizeObserver === 'undefined' || !hostRef.value) {
      return;
    }

    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(() => {
      if (visible.value) {
        scheduleFit();
      }
    });
    resizeObserver.observe(hostRef.value);
  };

  const ensureSession = async (): Promise<void> => {
    const runtimeReady = await waitForDesktopRuntime();
    if (!runtimeReady) {
      emitStatus('error', '内置终端仅支持 Tauri 桌面端。');
      return;
    }

    const terminal = terminalRef.value;
    const fitAddon = fitAddonRef.value;
    if (!terminal || !fitAddon) {
      return;
    }

    emitStatus('connecting', '正在连接 WSL2 终端…');
    await nextTick();
    fitAddon.fit();

    try {
      const payload = await tauriService.ensureTerminalSession({
        sessionId,
        cwd: null,
        cols: Math.max(2, terminal.cols || DEFAULT_COLS),
        rows: Math.max(1, terminal.rows || DEFAULT_ROWS),
      });

      session.value = payload;
      emitStatus('ready', `${payload.shellLabel} 已连接`);
      scheduleFit();

      if (visible.value) {
        focusTerminal();
      }
    } catch (error) {
      const message = resolveErrorMessage(error, '连接 WSL2 终端失败。');
      emitStatus('error', message);
      terminal.writeln(`\x1b[31m${message}\x1b[0m`);
    }
  };

  const registerEventListeners = async (): Promise<void> => {
    dataUnlisten = await listen<ITerminalDataEvent>('terminal:data', (event) => {
      if (event.payload.sessionId !== sessionId) {
        return;
      }

      terminalRef.value?.write(event.payload.data);
    });

    exitUnlisten = await listen<ITerminalExitEvent>('terminal:exit', (event) => {
      if (event.payload.sessionId !== sessionId) {
        return;
      }

      session.value = null;
      const message =
        event.payload.exitCode === null
          ? 'WSL2 终端已断开。'
          : `WSL2 终端已退出（代码 ${event.payload.exitCode}）。`;

      terminalRef.value?.write(`\r\n\x1b[90m${message}\x1b[0m\r\n`);
      emitStatus('closed', message);
    });
  };

  const createTerminal = (): void => {
    if (!hostRef.value || terminalRef.value) {
      return;
    }

    const terminal = new Terminal({
      allowTransparency: true,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      drawBoldTextInBrightColors: true,
      fontFamily:
        "Berkeley Mono, JetBrains Mono, 'SFMono-Regular', Consolas, 'Courier New', monospace",
      fontSize: 13,
      letterSpacing: 0,
      lineHeight: 1.38,
      rows: DEFAULT_ROWS,
      cols: DEFAULT_COLS,
      scrollback: 5000,
      theme: createTerminalTheme(theme.value),
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(hostRef.value);
    terminalRef.value = terminal;
    fitAddonRef.value = fitAddon;

    terminal.onData((data) => {
      if (!session.value) {
        return;
      }

      void tauriService.writeTerminalInput({ sessionId, data }).catch((error) => {
        emitStatus('error', resolveErrorMessage(error, '终端输入发送失败。'));
      });
    });

    terminal.onResize(({ cols, rows }) => {
      if (!session.value) {
        return;
      }

      void tauriService.resizeTerminalSession({ sessionId, cols, rows }).catch(() => {
        // 终端在关闭或窗口隐藏时可能触发瞬时 resize，这里忽略即可。
      });
    });
  };

  const retry = async (): Promise<void> => {
    terminalRef.value?.reset();
    await ensureSession();
  };

  onMounted(async () => {
    createTerminal();
    bindResizeObserver();
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
    },
  );

  watch(
    () => visible.value,
    async (nextVisible) => {
      if (!nextVisible) {
        return;
      }

      await nextTick();
      scheduleFit();
      focusTerminal();
    },
  );

  onBeforeUnmount(() => {
    clearFitFrame();
    resizeObserver?.disconnect();
    resizeObserver = null;

    if (session.value) {
      void tauriService.closeTerminalSession({ sessionId }).catch(() => {
        // Ignore shutdown races when the PTY has already exited.
      });
      session.value = null;
    }

    if (dataUnlisten) {
      dataUnlisten();
      dataUnlisten = null;
    }

    if (exitUnlisten) {
      exitUnlisten();
      exitUnlisten = null;
    }

    terminalRef.value?.dispose();
    terminalRef.value = null;
    fitAddonRef.value = null;
  });

  return {
    hostRef,
    status,
    statusMessage,
    retry,
    focusTerminal,
  };
};
