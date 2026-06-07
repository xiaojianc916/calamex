import { describe, expect, it, vi } from 'vitest';
import { createDisposableBag } from '@/utils/disposable';

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
