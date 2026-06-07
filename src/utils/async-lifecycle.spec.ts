import { describe, expect, it, vi } from 'vitest';
import { createRunOnceScheduler, createSequencer } from '@/utils/async-lifecycle';

const createDeferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
};

describe('createSequencer', () => {
  it('按入队顺序串行执行异步任务', async () => {
    const sequencer = createSequencer();
    const first = createDeferred();
    const calls: string[] = [];

    const firstRun = sequencer.queue(async () => {
      calls.push('first:start');
      await first.promise;
      calls.push('first:end');
      return 'first';
    });
    const secondRun = sequencer.queue(async () => {
      calls.push('second');
      return 'second';
    });

    await Promise.resolve();
    expect(calls).toEqual(['first:start']);

    first.resolve();
    await expect(firstRun).resolves.toBe('first');
    await expect(secondRun).resolves.toBe('second');
    expect(calls).toEqual(['first:start', 'first:end', 'second']);
  });

  it('前一个任务失败后仍允许后续任务继续执行', async () => {
    const sequencer = createSequencer();
    const error = new Error('boom');

    await expect(sequencer.queue(async () => Promise.reject(error))).rejects.toBe(error);
    await expect(sequencer.queue(async () => 'recovered')).resolves.toBe('recovered');
  });
});

describe('createRunOnceScheduler', () => {
  it('重复 schedule 只运行最后一次计划', async () => {
    vi.useFakeTimers();
    const runner = vi.fn();
    const scheduler = createRunOnceScheduler(runner, 100);

    scheduler.schedule();
    scheduler.schedule(200);

    await vi.advanceTimersByTimeAsync(199);
    expect(runner).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(runner).toHaveBeenCalledOnce();
    expect(scheduler.isScheduled()).toBe(false);

    vi.useRealTimers();
  });

  it('cancel 会取消尚未触发的计划', async () => {
    vi.useFakeTimers();
    const runner = vi.fn();
    const scheduler = createRunOnceScheduler(runner, 100);

    scheduler.schedule();
    scheduler.cancel();
    await vi.advanceTimersByTimeAsync(100);

    expect(runner).not.toHaveBeenCalled();
    expect(scheduler.isScheduled()).toBe(false);

    vi.useRealTimers();
  });

  it('flush 会立即执行已计划任务', () => {
    vi.useFakeTimers();
    const runner = vi.fn();
    const scheduler = createRunOnceScheduler(runner, 100);

    scheduler.schedule();
    scheduler.flush();

    expect(runner).toHaveBeenCalledOnce();
    expect(scheduler.isScheduled()).toBe(false);

    vi.useRealTimers();
  });

  it('dispose 后不会再执行任务', async () => {
    vi.useFakeTimers();
    const runner = vi.fn();
    const scheduler = createRunOnceScheduler(runner, 100);

    scheduler.schedule();
    scheduler.dispose();
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(100);

    expect(runner).not.toHaveBeenCalled();
    expect(scheduler.disposed).toBe(true);

    vi.useRealTimers();
  });
});
