import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import {
  SHELL_WINDOW_RESIZE_FRAME_EVENT,
  SHELL_WINDOW_RESIZE_SETTLED_EVENT,
} from '@/utils/window/window-resize-events';
import { useWindowResizeState } from './useWindowResizeState';

type TResizeObserverCallback = () => void;

let capturedCallback: TResizeObserverCallback | null = null;

vi.mock('@vueuse/core', () => ({
  useResizeObserver: (_target: unknown, callback: TResizeObserverCallback) => {
    capturedCallback = callback;
    return { stop: vi.fn() };
  },
}));

const isResizing = (): boolean => document.documentElement.classList.contains('is-resizing');
const fireResize = (): void => {
  capturedCallback?.();
};

describe('useWindowResizeState（ResizeObserver 驱动）', () => {
  let scope: ReturnType<typeof effectScope> | null = null;
  let frameCount = 0;
  let settledCount = 0;

  const onFrame = (): void => {
    frameCount += 1;
  };
  const onSettled = (): void => {
    settledCount += 1;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    frameCount = 0;
    settledCount = 0;
    capturedCallback = null;
    document.documentElement.classList.remove('is-resizing');
    window.addEventListener(SHELL_WINDOW_RESIZE_FRAME_EVENT, onFrame);
    window.addEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, onSettled);
    scope = effectScope();
    scope.run(() => {
      useWindowResizeState();
    });
  });

  afterEach(() => {
    scope?.stop();
    scope = null;
    window.removeEventListener(SHELL_WINDOW_RESIZE_FRAME_EVENT, onFrame);
    window.removeEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, onSettled);
    document.documentElement.classList.remove('is-resizing');
    vi.useRealTimers();
  });

  it('ResizeObserver 回调触发后立即标记 is-resizing 并派发帧事件', () => {
    fireResize();

    expect(isResizing()).toBe(true);
    expect(frameCount).toBe(1);
    expect(settledCount).toBe(0);
  });

  it('停止收到新回调超过去抖时长后自动 settle，无需任何看门狗', () => {
    fireResize();

    vi.advanceTimersByTime(120);
    expect(isResizing()).toBe(true);
    expect(settledCount).toBe(0);

    vi.advanceTimersByTime(60);
    expect(isResizing()).toBe(false);
    expect(settledCount).toBe(1);
  });

  it('连续多次回调期间持续在场，每次都会重置去抖计时器', () => {
    fireResize();
    vi.advanceTimersByTime(120);
    fireResize();
    vi.advanceTimersByTime(120);

    expect(isResizing()).toBe(true);
    expect(frameCount).toBe(2);
    expect(settledCount).toBe(0);

    vi.advanceTimersByTime(60);
    expect(isResizing()).toBe(false);
    expect(settledCount).toBe(1);
  });

  it('作用域销毁时立即清理 is-resizing 状态', () => {
    fireResize();
    expect(isResizing()).toBe(true);

    scope?.stop();
    expect(isResizing()).toBe(false);
  });
});
