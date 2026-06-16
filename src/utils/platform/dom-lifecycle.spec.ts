import { describe, expect, it, vi } from 'vitest';
import {
  addDisposableEventListener,
  requestDisposableAnimationFrame,
  requestDisposableTimeout,
} from '@/utils/platform/dom-lifecycle';

describe('dom-lifecycle', () => {
  describe('addDisposableEventListener', () => {
    it('返回幂等 disposer，释放后不再收到事件', () => {
      const target = new EventTarget();
      const listener = vi.fn();

      const dispose = addDisposableEventListener(target, 'change', listener);
      target.dispatchEvent(new Event('change'));
      dispose();
      dispose();
      target.dispatchEvent(new Event('change'));

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('释放时使用相同 options 移除捕获阶段监听', () => {
      const target = new EventTarget();
      const listener = vi.fn();
      const options = { capture: true };

      const dispose = addDisposableEventListener(target, 'change', listener, options);
      dispose();
      target.dispatchEvent(new Event('change'));

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('requestDisposableAnimationFrame', () => {
    it('dispose 会取消尚未触发的 animation frame', () => {
      const callback = vi.fn();
      const requestAnimationFrame = vi.fn(() => 42);
      const cancelAnimationFrame = vi.fn();

      const dispose = requestDisposableAnimationFrame(callback, {
        requestAnimationFrame,
        cancelAnimationFrame,
      });
      dispose();
      dispose();

      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
      expect(cancelAnimationFrame).toHaveBeenCalledOnce();
      expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
      expect(callback).not.toHaveBeenCalled();
    });

    it('frame 触发后 disposer 不会重复取消', () => {
      const callback = vi.fn();
      const cancelAnimationFrame = vi.fn();
      let frameCallback: FrameRequestCallback | null = null;
      const requestAnimationFrame = vi.fn((nextCallback: FrameRequestCallback) => {
        frameCallback = nextCallback;
        return 7;
      });

      const dispose = requestDisposableAnimationFrame(callback, {
        requestAnimationFrame,
        cancelAnimationFrame,
      });
      frameCallback?.(16);
      dispose();

      expect(callback).toHaveBeenCalledWith(16);
      expect(cancelAnimationFrame).not.toHaveBeenCalled();
    });
  });

  describe('requestDisposableTimeout', () => {
    it('dispose 会取消尚未触发的 timeout', () => {
      const callback = vi.fn();
      const setTimeout = vi.fn(() => 13);
      const clearTimeout = vi.fn();

      const dispose = requestDisposableTimeout(callback, 160, {
        setTimeout,
        clearTimeout,
      });
      dispose();
      dispose();

      expect(setTimeout).toHaveBeenCalledTimes(1);
      expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 160);
      expect(clearTimeout).toHaveBeenCalledOnce();
      expect(clearTimeout).toHaveBeenCalledWith(13);
      expect(callback).not.toHaveBeenCalled();
    });

    it('timeout 触发后 disposer 不会重复取消', () => {
      const callback = vi.fn();
      const clearTimeout = vi.fn();
      let timeoutCallback: (() => void) | null = null;
      const setTimeout = vi.fn((nextCallback: () => void) => {
        timeoutCallback = nextCallback;
        return 21;
      });

      const dispose = requestDisposableTimeout(callback, 200, {
        setTimeout,
        clearTimeout,
      });
      timeoutCallback?.();
      dispose();

      expect(callback).toHaveBeenCalledOnce();
      expect(clearTimeout).not.toHaveBeenCalled();
    });
  });
});
