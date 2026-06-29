import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBackgroundQueue } from './use-background-queue';

// 微任务冲刷：确保定时器回调触发的异步 drain 循环跑完。
const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('useBackgroundQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 强制走 setTimeout 路径，使 fake timers 可控（不依赖环境是否提供 requestIdleCallback）。
    vi.stubGlobal('requestIdleCallback', undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('按延迟批量处理入队项并对同一 id 去重', async () => {
    const processed: string[] = [];
    const queue = useBackgroundQueue({
      process: async (id) => {
        processed.push(id);
      },
      delayMs: 100,
      failureLogEvent: 'test.failed',
      logger: { warn: vi.fn() },
    });

    queue.enqueue('a');
    queue.enqueue('a');
    queue.enqueue('b');

    expect(processed).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    await flushMicrotasks();

    expect(processed).toEqual(['a', 'b']);
  });

  it('shouldSkip 命中的 id 不会入队也不会被处理', async () => {
    const processed: string[] = [];
    const queue = useBackgroundQueue({
      process: async (id) => {
        processed.push(id);
      },
      shouldSkip: (id) => id === 'skip',
      delayMs: 50,
      failureLogEvent: 'test.failed',
      logger: { warn: vi.fn() },
    });

    queue.enqueue('skip');
    queue.enqueue('keep');
    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();

    expect(processed).toEqual(['keep']);
  });

  it('process 抛错时记录日志且不中断后续项', async () => {
    const processed: string[] = [];
    const warn = vi.fn();
    const queue = useBackgroundQueue({
      process: async (id) => {
        if (id === 'boom') {
          throw new Error('boom');
        }
        processed.push(id);
      },
      delayMs: 10,
      failureLogEvent: 'test.failed',
      logger: { warn },
    });

    queue.enqueue('boom');
    queue.enqueue('ok');
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();

    expect(processed).toEqual(['ok']);
    expect(warn).toHaveBeenCalledWith({ event: 'test.failed', err: expect.any(Error) });
  });

  it('clear 取消待处理的定时任务', async () => {
    const processed: string[] = [];
    const queue = useBackgroundQueue({
      process: async (id) => {
        processed.push(id);
      },
      delayMs: 100,
      failureLogEvent: 'test.failed',
      logger: { warn: vi.fn() },
    });

    queue.enqueue('a');
    queue.clear();
    await vi.advanceTimersByTimeAsync(100);
    await flushMicrotasks();

    expect(processed).toEqual([]);
  });
});
