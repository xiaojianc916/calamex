import { useEventListener } from '@vueuse/core';
import { onScopeDispose } from 'vue';
import { createMutableDisposable } from '@/utils/core/disposable';
import { requestDisposableAnimationFrame, requestDisposableTimeout } from '@/utils/platform/dom-lifecycle';
import { logger } from '@/utils/platform/logger';
import {
  SHELL_WINDOW_RESIZE_END_EVENT,
  SHELL_WINDOW_RESIZE_FRAME_EVENT,
  SHELL_WINDOW_RESIZE_SETTLED_EVENT,
  SHELL_WINDOW_RESIZE_START_EVENT,
} from '@/utils/window/window-resize-events';

const RESIZE_IDLE_RESET_DELAY_MS = 160;
const INTERACTIVE_RESIZE_SETTLE_MS = 160;
// 看门狗：收到 START 后立即挂上的兜底计时器。若后续没有真实的 resize 活动
// （原生 onResized -> markResizing 会在每帧把它顺延），就在这么短的时间内自动
// settle。用于杜绝“只来 START、却没有配对 END、也没有后续 onResized”时，rAF
// frame pump 空跑导致界面长时间假死（点击失效）的问题。真实拖拽过程中不会误伤。
const INTERACTIVE_RESIZE_START_WATCHDOG_MS = 800;
// 终极兜底：无论如何 frame pump 最多运行这么久。正常情况下绝不应触达
// （idle 计时器或看门狗会先 settle），仅用于防御任何未预期的 START 来源。
const INTERACTIVE_RESIZE_FRAME_PUMP_MAX_MS = 12_000;
// frame pump 运行超过该时长即视为异常（疑似 START 未配对 END / 无 onResized），
// 打印诊断日志以便定位真正的触发源。
const INTERACTIVE_RESIZE_PUMP_SUSPICIOUS_MS = 1_500;
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
  let resizeFramePumpFrames = 0;
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
        const pumpElapsedMs =
          resizeFramePumpStartedAt > 0 ? Date.now() - resizeFramePumpStartedAt : 0;
        const pumpFrames = resizeFramePumpFrames;
        cancelResizeFramePump();
        html.classList.remove('is-resizing');
        interactiveResizePhase = 'idle';
        resizeFramePumpStartedAt = 0;
        resizeFramePumpFrames = 0;
        // 诊断：pump 运行异常久通常意味着收到了一个未配对 END、也没有后续
        // onResized 的“悬空 START”。记录耗时与帧数，便于定位触发源。
        if (pumpElapsedMs > INTERACTIVE_RESIZE_PUMP_SUSPICIOUS_MS) {
          logger.warn({
            event: 'window.resize_frame_pump.long_run_settled',
            elapsedMs: pumpElapsedMs,
            frames: pumpFrames,
          });
        }
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

        resizeFramePumpFrames += 1;
        dispatchResizeFrame();

        const pumpElapsedMs = Date.now() - resizeFramePumpStartedAt;
        if (pumpElapsedMs > INTERACTIVE_RESIZE_FRAME_PUMP_MAX_MS) {
          logger.warn({
            event: 'window.resize_frame_pump.capped',
            elapsedMs: pumpElapsedMs,
            frames: resizeFramePumpFrames,
          });
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
    resizeFramePumpFrames = 0;
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
    // 关键修复：START 之后立即挂上看门狗。如果后续没有真实 resize 活动把它顺延
    // （markResizing 会在每次原生 onResized 时重置该计时器），看门狗会在很短时间
    // 内 settle，彻底杜绝“只收到 START、不收 END/onResized”导致 frame pump 空跑、
    // is-resizing 长期挂起、界面假死的问题。
    scheduleResizeClassRemoval(INTERACTIVE_RESIZE_START_WATCHDOG_MS);
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
    // 安全网：窗口/标签被隐藏时，任何进行中的交互式 resize 都应立即收尾，
    // 避免 frame pump 在后台空跑。
    useEventListener(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden' && interactiveResizePhase !== 'idle') {
        endInteractiveResize();
      }
    });
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
