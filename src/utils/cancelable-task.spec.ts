import { describe, expect, it } from 'vitest';
import { createLatestTaskRunner } from '@/utils/cancelable-task';

const createDeferred = <T,>() => {
  const state: {
    resolve?: (value: T) => void;
    reject?: (reason?: unknown) => void;
  } = {};
  const promise = new Promise<T>((resolve, reject) => {
    state.resolve = resolve;
    state.reject = reject;
  });

  return {
    promise,
    resolve(value: T) {
      if (!state.resolve) {
        throw new Error('Deferred resolver is not ready');
      }
      state.resolve(value);
    },
    reject(reason?: unknown) {
      if (!state.reject) {
        throw new Error('Deferred rejecter is not ready');
      }
      state.reject(reason);
    },
  };
};

describe('createLatestTaskRunner', () => {
  it('启动新任务时取消旧任务，旧结果不会落地', async () => {
    const runner = createLatestTaskRunner();
    const first = createDeferred<string>();
    const second = createDeferred<string>();
    const signals: AbortSignal[] = [];

    const firstResult = runner.run((signal) => {
      signals.push(signal);
      return first.promise;
    });
    const secondResult = runner.run((signal) => {
      signals.push(signal);
      return second.promise;
    });

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    first.resolve('stale');
    second.resolve('fresh');

    await expect(firstResult).resolves.toEqual({ status: 'canceled' });
    await expect(secondResult).resolves.toEqual({ status: 'completed', value: 'fresh' });
  });

  it('cancel 会中止当前任务并返回 canceled', async () => {
    const runner = createLatestTaskRunner();
    const deferred = createDeferred<string>();
    const signals: AbortSignal[] = [];

    const result = runner.run((signal) => {
      signals.push(signal);
      return deferred.promise;
    });

    runner.cancel();
    expect(signals[0]?.aborted).toBe(true);

    deferred.resolve('late');
    await expect(result).resolves.toEqual({ status: 'canceled' });
    expect(runner.signal).toBeNull();
  });

  it('当前任务的真实错误继续向上抛出', async () => {
    const runner = createLatestTaskRunner();
    const error = new Error('boom');

    await expect(
      runner.run(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });

  it('AbortError 被归类为取消结果', async () => {
    const runner = createLatestTaskRunner();

    await expect(
      runner.run(async () => {
        throw new DOMException('aborted', 'AbortError');
      }),
    ).resolves.toEqual({ status: 'canceled' });
  });
});
