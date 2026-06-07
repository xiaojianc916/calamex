import { onBeforeUnmount, onMounted } from 'vue';
import { addDisposableEventListener, requestDisposableAnimationFrame } from '@/utils/dom-lifecycle';
import {
  SHELL_WINDOW_RESIZE_END_EVENT,
  SHELL_WINDOW_RESIZE_FRAME_EVENT,
  SHELL_WINDOW_RESIZE_SETTLED_EVENT,
  SHELL_WINDOW_RESIZE_START_EVENT,
} from '@/utils/window-resize-events';

type TShellResizeFrameCallback = () => void;

interface IUseShellResizeFrameSchedulerOptions {
  onStart?: TShellResizeFrameCallback;
  onFrame?: TShellResizeFrameCallback;
  onEnd?: TShellResizeFrameCallback;
  onSettled?: TShellResizeFrameCallback;
  /**
   * resize settled 后额外补几帧轻量 layout，用于 WebView2 / CodeMirror / xterm
   * 这类内部测量可能慢一帧的组件。默认 2 帧，兼顾最终精度和主线程负担。
   */
  settledFrames?: number;
}

/**
 * 组件级 live resize 适配器。
 *
 * 设计原则：组件不要各自直接监听 window.resize 并高频重排，而是接入 shell 统一
 * resize 生命周期；拖拽过程中所有重排合并到 requestAnimationFrame，拖拽结束后再
 * 补少量 settle frame 做精确校准。
 */
export const useShellResizeFrameScheduler = ({
  onStart,
  onFrame,
  onEnd,
  onSettled,
  settledFrames = 2,
}: IUseShellResizeFrameSchedulerOptions): void => {
  let cancelScheduledFrame: (() => void) | null = null;
  let cancelScheduledSettledFrame: (() => void) | null = null;
  let disposeResizeListeners: (() => void) | null = null;
  let pendingSettledFrames = 0;

  const cancelFrame = (): void => {
    cancelScheduledFrame?.();
    cancelScheduledFrame = null;
  };

  const cancelSettledFrames = (): void => {
    cancelScheduledSettledFrame?.();
    cancelScheduledSettledFrame = null;
    pendingSettledFrames = 0;
  };

  const scheduleFrame = (): void => {
    if (!onFrame || cancelScheduledFrame) {
      return;
    }

    cancelScheduledFrame = requestDisposableAnimationFrame(() => {
      cancelScheduledFrame = null;
      onFrame();
    });
  };

  const pumpSettledFrames = (): void => {
    if (pendingSettledFrames <= 0) {
      cancelScheduledSettledFrame = null;
      return;
    }

    cancelScheduledSettledFrame = requestDisposableAnimationFrame(() => {
      cancelScheduledSettledFrame = null;
      onFrame?.();
      pendingSettledFrames -= 1;
      pumpSettledFrames();
    });
  };

  const handleStart = (): void => {
    cancelSettledFrames();
    onStart?.();
    scheduleFrame();
  };

  const handleFrame = (): void => {
    scheduleFrame();
  };

  const handleEnd = (): void => {
    onEnd?.();
    scheduleFrame();
  };

  const handleSettled = (): void => {
    cancelFrame();
    onFrame?.();
    onSettled?.();
    cancelSettledFrames();
    pendingSettledFrames = Math.max(0, Math.round(settledFrames));
    pumpSettledFrames();
  };

  onMounted(() => {
    const disposables = [
      addDisposableEventListener(window, SHELL_WINDOW_RESIZE_START_EVENT, handleStart),
      addDisposableEventListener(window, SHELL_WINDOW_RESIZE_FRAME_EVENT, handleFrame),
      addDisposableEventListener(window, SHELL_WINDOW_RESIZE_END_EVENT, handleEnd),
      addDisposableEventListener(window, SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleSettled),
    ];

    disposeResizeListeners = () => {
      for (const dispose of disposables.splice(0).reverse()) {
        dispose();
      }
      disposeResizeListeners = null;
    };
  });

  onBeforeUnmount(() => {
    disposeResizeListeners?.();
    cancelFrame();
    cancelSettledFrames();
  });
};
