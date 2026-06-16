import { describe, expect, it, vi } from 'vitest';
import { createDisposableBag, createMutableDisposable } from '@/utils/core/disposable';

describe('createDisposableBag', () => {
  it('按后进先出顺序释放资源', async () => {
    const bag = createDisposableBag();
    const calls: string[] = [];

    bag.add(() => calls.push('first'));
    bag.add(() => calls.push('second'));

    await bag.dispose();

    expect(calls).toEqual(['second', 'first']);
    expect(bag.disposed).toBe(true);
  });

  it('dispose 保持幂等，避免重复释放', async () => {
    const bag = createDisposableBag();
    const cleanup = vi.fn();
    bag.add(cleanup);

    await bag.dispose();
    await bag.dispose();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('支持移除尚未释放的资源', async () => {
    const bag = createDisposableBag();
    const kept = vi.fn();
    const removed = vi.fn();

    bag.add(kept);
    const remove = bag.add(removed);
    remove();

    await bag.dispose();

    expect(kept).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
  });

  it('已释放后新增资源会立即释放', async () => {
    const bag = createDisposableBag();
    const cleanup = vi.fn();

    await bag.dispose();
    bag.add(cleanup);
    await Promise.resolve();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('createMutableDisposable', () => {
  it('设置新资源时释放旧资源', async () => {
    const mutable = createMutableDisposable();
    const first = vi.fn();
    const second = vi.fn();

    mutable.set(first);
    mutable.set(second);
    await Promise.resolve();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(mutable.value).toBe(second);
  });

  it('clear 会释放当前资源并置空', async () => {
    const mutable = createMutableDisposable();
    const cleanup = vi.fn();

    mutable.set(cleanup);
    mutable.clear();
    await Promise.resolve();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(mutable.value).toBeNull();
  });

  it('dispose 会释放当前资源并保持幂等', async () => {
    const mutable = createMutableDisposable();
    const cleanup = vi.fn();

    mutable.set(cleanup);
    await mutable.dispose();
    await mutable.dispose();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(mutable.disposed).toBe(true);
    expect(mutable.value).toBeNull();
  });

  it('已 dispose 后设置新资源会立即释放', async () => {
    const mutable = createMutableDisposable();
    const cleanup = vi.fn();

    await mutable.dispose();
    mutable.set(cleanup);
    await Promise.resolve();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(mutable.value).toBeNull();
  });

  it('clearAndLeak 会移除当前资源但不释放', () => {
    const mutable = createMutableDisposable();
    const cleanup = vi.fn();

    mutable.set(cleanup);
    const leaked = mutable.clearAndLeak();

    expect(leaked).toBe(cleanup);
    expect(cleanup).not.toHaveBeenCalled();
    expect(mutable.value).toBeNull();
  });
});
