import { describe, expect, it, vi } from 'vitest';
import { createRuntimeScope } from '@/utils/runtime-scope';

const createDeferred = <T,>() => {
  const state: {
    resolve?: (value: T) => void;
  } = {};
  const promise = new Promise<T>((resolve) => {
    state.resolve = resolve;
  });

  return {
    promise,
    resolve(value: T) {
      if (!state.resolve) {
        throw new Error('Deferred resolver is not ready');
      }
      state.resolve(value);
    },
  };
};

describe('createRuntimeScope', () => {
  it('释放作用域时会先取消 signal，再按栈顺序释放资源', async () => {
    const scope = createRuntimeScope('root');
    const calls: string[] = [];

    scope.add(() => calls.push(scope.signal.aborted ? 'first:aborted' : 'first:active'));
    scope.add(() => calls.push(scope.signal.aborted ? 'second:aborted' : 'second:active'));

    await scope.dispose();

    expect(calls).toEqual(['second:aborted', 'first:aborted']);
    expect(scope.state).toBe('disposed');
    expect(scope.disposed).toBe(true);
  });

  it('父作用域取消会级联取消子作用域', () => {
    const parent = createRuntimeScope('workbench');
    const child = parent.child('terminal');

    expect(child.name).toBe('workbench.terminal');
    expect(child.signal.aborted).toBe(false);

    parent.cancel('closed');

    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe('closed');
  });

  it('父作用域释放时会先释放后注册的子作用域', async () => {
    const parent = createRuntimeScope('parent');
    const calls: string[] = [];

    parent.add(() => calls.push('parent'));
    const child = parent.child('child');
    child.add(() => calls.push('child'));

    await parent.dispose();

    expect(calls).toEqual(['child', 'parent']);
    expect(child.disposed).toBe(true);
  });

  it('dispose 保持并发幂等', async () => {
    const scope = createRuntimeScope('root');
    const cleanup = vi.fn();
    scope.add(cleanup);

    await Promise.all([scope.dispose(), scope.dispose()]);

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('作用域释放会取消挂载在作用域上的 latest task', async () => {
    const scope = createRuntimeScope('root');
    const runner = scope.latestTask('load');
    const deferred = createDeferred<string>();
    const signals: AbortSignal[] = [];

    const result = runner.run((signal) => {
      signals.push(signal);
      return deferred.promise;
    });

    await scope.dispose();
    expect(signals[0]?.aborted).toBe(true);

    deferred.resolve('late');
    await expect(result).resolves.toEqual({ status: 'canceled' });
  });

  it('作用域释放会清理定时器', async () => {
    vi.useFakeTimers();
    try {
      const scope = createRuntimeScope('root');
      const callback = vi.fn();

      scope.setTimeout(callback, 10);
      await scope.dispose();
      await vi.runAllTimersAsync();

      expect(callback).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
