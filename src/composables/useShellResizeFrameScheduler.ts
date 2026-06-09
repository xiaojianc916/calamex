import { useEventListener } from '@vueuse/core';
import { onBeforeUnmount } from 'vue';
import { createMutableDisposable } from '@/utils/disposable';
import { requestDisposableAnimationFrame } from '@/utils/dom-lifecycle';
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
  const scheduledFrame = createMutableDisposable();
  const scheduledSettledFrame = createMutableDisposable();
  let pendingSettledFrames = 0;

  const cancelFrame = (): void => {
    scheduledFrame.clear();
  };

  const cancelSettledFrames = (): void => {
    scheduledSettledFrame.clear();
    pendingSettledFrames = 0;
  };

  const scheduleFrame = (): void => {
    if (!onFrame || scheduledFrame.value) {
      return;
    }

    scheduledFrame.set(
      requestDisposableAnimationFrame(() => {
        scheduledFrame.clear();
        onFrame();
      }),
    );
  };

  const pumpSettledFrames = (): void => {
    if (pendingSettledFrames <= 0) {
      scheduledSettledFrame.clear();
      return;
    }

    scheduledSettledFrame.set(
      requestDisposableAnimationFrame(() => {
        scheduledSettledFrame.clear();
        onFrame?.();
        pendingSettledFrames -= 1;
        pumpSettledFrames();
      }),
    );
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

  // VueUse useEventListener 在 setup scope 注册，组件卸载时自动解绑，替代手写 disposable bag。
  useEventListener(window, SHELL_WINDOW_RESIZE_START_EVENT, handleStart);
  useEventListener(window, SHELL_WINDOW_RESIZE_FRAME_EVENT, handleFrame);
  useEventListener(window, SHELL_WINDOW_RESIZE_END_EVENT, handleEnd);
  useEventListener(window, SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleSettled);

  onBeforeUnmount(() => {
    cancelFrame();
    cancelSettledFrames();
  });
};
