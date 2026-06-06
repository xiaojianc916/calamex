import { onScopeDispose } from 'vue';
import { logger } from '@/utils/logger';
import {
  SHELL_WINDOW_RESIZE_END_EVENT,
  SHELL_WINDOW_RESIZE_SETTLED_EVENT,
  SHELL_WINDOW_RESIZE_START_EVENT,
} from '@/utils/window-resize-events';

const RESIZE_IDLE_RESET_DELAY_MS = 140;
const INTERACTIVE_RESIZE_SETTLE_MS = 140;
const TAURI_INTERNALS_KEY = '__TAURI_INTERNALS__';

interface IResizeEventSource {
  onResized(handler: () => void): Promise<() => void>;
}

type TInteractiveResizePhase = 'idle' | 'active' | 'settling';

const readObjectProperty = (source: unknown, key: string): unknown => {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }

  return Reflect.get(source, key);
};

const hasTauriWindowRuntime = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  const internals = readObjectProperty(window, TAURI_INTERNALS_KEY);
  const invoke = readObjectProperty(internals, 'invoke');
  const metadata = readObjectProperty(internals, 'metadata');
  const currentWindow = readObjectProperty(metadata, 'currentWindow');
  const label = readObjectProperty(currentWindow, 'label');

  return typeof invoke === 'function' && typeof label === 'string' && label.length > 0;
};

const isResizeEventSource = (value: unknown): value is IResizeEventSource =>
  typeof value === 'object' &&
  value !== null &&
  'onResized' in value &&
  typeof value.onResized === 'function';

const warnResizeListenerFailure = (err: unknown): void => {
  logger.warn({
    event: 'window.resize_listener.failed',
    err,
  });
};

export const useWindowResizeState = () => {
  const html = document.documentElement;
  let timer: number | undefined;
  let unlisten: (() => void) | undefined;
  let detachResizeStartListener: (() => void) | undefined;
  let isDisposed = false;
  let interactiveResizePhase: TInteractiveResizePhase = 'idle';

  const clearResizeTimer = (): void => {
    if (timer === undefined) {
      return;
    }

    window.clearTimeout(timer);
    timer = undefined;
  };

  const scheduleResizeClassRemoval = (delayMs: number): void => {
    clearResizeTimer();
    timer = window.setTimeout(() => {
      const wasResizing = html.classList.contains('is-resizing');
      html.classList.remove('is-resizing');
      interactiveResizePhase = 'idle';
      timer = undefined;
      if (wasResizing) {
        window.dispatchEvent(new Event(SHELL_WINDOW_RESIZE_SETTLED_EVENT));
      }
    }, delayMs);
  };

  const markResizing = (): void => {
    html.classList.add('is-resizing');
    interactiveResizePhase = 'settling';
    scheduleResizeClassRemoval(RESIZE_IDLE_RESET_DELAY_MS);
  };

  const beginInteractiveResize = (): void => {
    interactiveResizePhase = 'active';
    clearResizeTimer();
    html.classList.add('is-resizing');
  };

  const endInteractiveResize = (): void => {
    interactiveResizePhase = 'settling';
    scheduleResizeClassRemoval(INTERACTIVE_RESIZE_SETTLE_MS);
  };

  onScopeDispose(() => {
    isDisposed = true;
    interactiveResizePhase = 'idle';
    clearResizeTimer();
    unlisten?.();
    detachResizeStartListener?.();
    html.classList.remove('is-resizing');
  });

  if (typeof window !== 'undefined') {
    const handleResizeStart = (): void => {
      beginInteractiveResize();
    };
    const handleResizeEnd = (): void => {
      endInteractiveResize();
    };

    window.addEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleResizeStart);
    window.addEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleResizeEnd);
    detachResizeStartListener = () => {
      window.removeEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleResizeStart);
      window.removeEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleResizeEnd);
    };
  }

  if (!hasTauriWindowRuntime()) {
    return {
      markResizing,
    };
  }

  // 与本文件其余 Tauri 调用方保持一致：按需动态加载 @tauri-apps/api/window，
  // 让该模块可被独立分包，并消除 INEFFECTIVE_DYNAMIC_IMPORT 构建警告。
  const attachWindowResizeListener = async (): Promise<void> => {
    let getCurrentWindow: typeof import('@tauri-apps/api/window')['getCurrentWindow'];
    try {
      const tauriWindow = await import('@tauri-apps/api/window');
      getCurrentWindow = tauriWindow.getCurrentWindow;
    } catch (err) {
      warnResizeListenerFailure(err);
      return;
    }

    if (isDisposed) {
      return;
    }

    let currentWindow: unknown;
    try {
      currentWindow = getCurrentWindow();
    } catch (err) {
      warnResizeListenerFailure(err);
      return;
    }

    if (!isResizeEventSource(currentWindow)) {
      return;
    }

    try {
      const off = await currentWindow.onResized(markResizing);
      if (isDisposed) {
        off();
        return;
      }

      unlisten = off;
    } catch (err) {
      warnResizeListenerFailure(err);
    }
  };

  void attachWindowResizeListener();

  return {
    markResizing,
  };
};
