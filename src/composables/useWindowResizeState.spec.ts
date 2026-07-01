import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
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

  beforeEach(() => {
    vi.useFakeTimers();
    capturedCallback = null;
    document.documentElement.classList.remove('is-resizing');
    scope = effectScope();
    scope.run(() => {
      useWindowResizeState();
    });
  });

  afterEach(() => {
    scope?.stop();
    scope = null;
    document.documentElement.classList.remove('is-resizing');
    vi.useRealTimers();
  });

  it('ResizeObserver 回调触发后立即标记 is-resizing', () => {
    fireResize();
    expect(isResizing()).toBe(true);
  });

  it('停止收到新回调超过去抖时长后自动移除 is-resizing，无需任何看门狗', () => {
    fireResize();
    vi.advanceTimersByTime(120);
    expect(isResizing()).toBe(true);
    vi.advanceTimersByTime(60);
    expect(isResizing()).toBe(false);
  });

  it('连续多次回调期间持续在场，每次都会重置去抖计时器', () => {
    fireResize();
    vi.advanceTimersByTime(120);
    fireResize();
    vi.advanceTimersByTime(120);
    expect(isResizing()).toBe(true);
    vi.advanceTimersByTime(60);
    expect(isResizing()).toBe(false);
  });

  it('作用域销毁时立即清理 is-resizing 状态', () => {
    fireResize();
    expect(isResizing()).toBe(true);
    scope?.stop();
    expect(isResizing()).toBe(false);
  });
});
