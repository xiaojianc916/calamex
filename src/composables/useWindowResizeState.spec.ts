import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import {
  SHELL_WINDOW_RESIZE_END_EVENT,
  SHELL_WINDOW_RESIZE_FRAME_EVENT,
  SHELL_WINDOW_RESIZE_SETTLED_EVENT,
  SHELL_WINDOW_RESIZE_START_EVENT,
} from '@/utils/window/window-resize-events';
import { useWindowResizeState } from './useWindowResizeState';

vi.mock('@/utils/platform/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const isResizing = (): boolean => document.documentElement.classList.contains('is-resizing');

describe('useWindowResizeState 交互式 resize 看门狗', () => {
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

  it('收到 START 后若无后续活动，看门狗会在 1s 内自动 settle，避免 frame pump 空跑', () => {
    window.dispatchEvent(new Event(SHELL_WINDOW_RESIZE_START_EVENT));

    expect(isResizing()).toBe(true);
    // beginInteractiveResize 会同步派发一帧，无需依赖 rAF。
    expect(frameCount).toBeGreaterThanOrEqual(1);

    // 未越过看门狗阈值前，仍处于 resizing 状态。
    vi.advanceTimersByTime(500);
    expect(isResizing()).toBe(true);
    expect(settledCount).toBe(0);

    // 越过看门狗阈值后应自动收尾。
    vi.advanceTimersByTime(400);
    expect(isResizing()).toBe(false);
    expect(settledCount).toBe(1);
  });

  it('显式 END 事件会及时收尾交互式 resize', () => {
    window.dispatchEvent(new Event(SHELL_WINDOW_RESIZE_START_EVENT));
    expect(isResizing()).toBe(true);

    window.dispatchEvent(new Event(SHELL_WINDOW_RESIZE_END_EVENT));
    vi.advanceTimersByTime(200);

    expect(isResizing()).toBe(false);
    expect(settledCount).toBe(1);
  });

  it('页面切到后台(visibilitychange hidden)时强制收尾', () => {
    window.dispatchEvent(new Event(SHELL_WINDOW_RESIZE_START_EVENT));
    expect(isResizing()).toBe(true);

    const visibilityStateDescriptor = Object.getOwnPropertyDescriptor(
      Document.prototype,
      'visibilityState',
    );
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });

    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(200);

    expect(isResizing()).toBe(false);
    expect(settledCount).toBe(1);

    if (visibilityStateDescriptor) {
      Object.defineProperty(document, 'visibilityState', visibilityStateDescriptor);
    } else {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
  });
});
