import { useEventListener } from '@vueuse/core';
import { onScopeDispose } from 'vue';
import { createMutableDisposable } from '@/utils/disposable';
import { requestDisposableAnimationFrame, requestDisposableTimeout } from '@/utils/dom-lifecycle';
import { logger } from '@/utils/logger';
import {
  SHELL_WINDOW_RESIZE_END_EVENT,
  SHELL_WINDOW_RESIZE_FRAME_EVENT,
  SHELL_WINDOW_RESIZE_SETTLED_EVENT,
  SHELL_WINDOW_RESIZE_START_EVENT,
} from '@/utils/window-resize-events';

const RESIZE_IDLE_RESET_DELAY_MS = 160;
const INTERACTIVE_RESIZE_SETTLE_MS = 160;
const INTERACTIVE_RESIZE_FRAME_PUMP_MAX_MS = 12_000;
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
  const resizeClassRemovalTimer = createMutableDisposable();
  const resizeFramePumpFrame = createMutableDisposable();
  const tauriResizeListener = createMutableDisposable();
  let resizeFramePumpStartedAt = 0;
  let isDisposed = false;
  let interactiveResizePhase: TInteractiveResizePhase = 'idle';

  const clearResizeTimer = (): void => {
    resizeClassRemovalTimer.clear();
  };

  const cancelResizeFramePump = (): void => {
    resizeFramePumpFrame.clear();
  };

  const dispatchResizeFrame = (): void => {
    window.dispatchEvent(new Event(SHELL_WINDOW_RESIZE_FRAME_EVENT));
  };

  const scheduleResizeClassRemoval = (delayMs: number): void => {
    clearResizeTimer();
    resizeClassRemovalTimer.set(
      requestDisposableTimeout(() => {
        resizeClassRemovalTimer.clear();
        const wasResizing = html.classList.contains('is-resizing');
        cancelResizeFramePump();
        html.classList.remove('is-resizing');
        interactiveResizePhase = 'idle';
        if (wasResizing) {
          window.dispatchEvent(new Event(SHELL_WINDOW_RESIZE_SETTLED_EVENT));
        }
      }, delayMs),
    );
  };

  const queueResizeFramePump = (): void => {
    if (resizeFramePumpFrame.value) {
      return;
    }

    resizeFramePumpFrame.set(
      requestDisposableAnimationFrame(() => {
        resizeFramePumpFrame.clear();

        if (isDisposed || interactiveResizePhase !== 'active') {
          return;
        }

        dispatchResizeFrame();

        if (Date.now() - resizeFramePumpStartedAt > INTERACTIVE_RESIZE_FRAME_PUMP_MAX_MS) {
          interactiveResizePhase = 'settling';
          scheduleResizeClassRemoval(INTERACTIVE_RESIZE_SETTLE_MS);
          return;
        }

        queueResizeFramePump();
      }),
    );
  };

  const startResizeFramePump = (): void => {
    resizeFramePumpStartedAt = Date.now();
    queueResizeFramePump();
  };

  const beginResizePhase = (): void => {
    if (interactiveResizePhase === 'idle') {
      window.dispatchEvent(new Event(SHELL_WINDOW_RESIZE_START_EVENT));
    }

    html.classList.add('is-resizing');
  };

  const markResizing = (): void => {
    beginResizePhase();
    dispatchResizeFrame();

    if (interactiveResizePhase === 'active') {
      scheduleResizeClassRemoval(RESIZE_IDLE_RESET_DELAY_MS);
      return;
    }

    interactiveResizePhase = 'settling';
    scheduleResizeClassRemoval(RESIZE_IDLE_RESET_DELAY_MS);
  };

  const beginInteractiveResize = (): void => {
    interactiveResizePhase = 'active';
    clearResizeTimer();
    html.classList.add('is-resizing');
    dispatchResizeFrame();
    startResizeFramePump();
  };

  const endInteractiveResize = (): void => {
    cancelResizeFramePump();
    dispatchResizeFrame();
    interactiveResizePhase = 'settling';
    scheduleResizeClassRemoval(INTERACTIVE_RESIZE_SETTLE_MS);
  };

  onScopeDispose(() => {
    isDisposed = true;
    interactiveResizePhase = 'idle';
    clearResizeTimer();
    cancelResizeFramePump();
    tauriResizeListener.clear();
    html.classList.remove('is-resizing');
  });

  if (typeof window !== 'undefined') {
    // VueUse useEventListener 注册的监听会随当前组件 scope 自动解绑，无需手写 disposable bag。
    useEventListener(window, SHELL_WINDOW_RESIZE_START_EVENT, () => beginInteractiveResize());
    useEventListener(window, SHELL_WINDOW_RESIZE_END_EVENT, () => endInteractiveResize());
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

      tauriResizeListener.set(off);
    } catch (err) {
      warnResizeListenerFailure(err);
    }
  };

  void attachWindowResizeListener();

  return {
    markResizing,
  };
};
