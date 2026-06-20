import { describe, expect, it, vi } from 'vitest';

import type { IAiThread } from '@/types/ai/thread';

import {
  installAuthoritativeEntriesMirror,
  mirrorAuthoritativeToEntries,
  projectAuthoritativeToThreadPersist,
} from './authoritativeEntriesMirror';

const makeThread = (id: string): IAiThread => ({
  id,
  title: `线程 ${id}`,
  titleStatus: 'temporary',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  entries: [],
});

interface IFakeStore {
  authoritativeThreads: IAiThread[];
  authoritativeActiveThreadId: string | null;
  $subscribe: (callback: () => void) => () => void;
}

const createFakeStore = (
  threads: IAiThread[],
  activeThreadId: string | null,
): { store: IFakeStore; emit: () => void; stop: ReturnType<typeof vi.fn> } => {
  let subscriber: (() => void) | null = null;
  const stop = vi.fn();
  const store: IFakeStore = {
    authoritativeThreads: threads,
    authoritativeActiveThreadId: activeThreadId,
    $subscribe: (callback) => {
      subscriber = callback;
      return stop;
    },
  };
  return { store, emit: () => subscriber?.(), stop };
};

describe('projectAuthoritativeToThreadPersist', () => {
  it('归一 activeThreadId 并标注当前版本（指向不存在的线程时落到首个）', () => {
    const threads = [makeThread('a'), makeThread('b')];
    const persist = projectAuthoritativeToThreadPersist({ activeThreadId: 'missing', threads });
    expect(persist.version).toBe(1);
    expect(persist.activeThreadId).toBe('a');
    expect(persist.threads).toBe(threads);
  });

  it('空库归一为 activeThreadId=null', () => {
    const persist = projectAuthoritativeToThreadPersist({ activeThreadId: 'x', threads: [] });
    expect(persist.activeThreadId).toBeNull();
    expect(persist.threads).toEqual([]);
  });
});

describe('mirrorAuthoritativeToEntries', () => {
  it('投影权威状态并把 JSON 快照交给 schedulePersist', () => {
    const schedulePersist = vi.fn();
    const { store } = createFakeStore([makeThread('a')], 'a');
    mirrorAuthoritativeToEntries(store, { schedulePersist });
    expect(schedulePersist).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(schedulePersist.mock.calls[0]![0] as string);
    expect(payload.version).toBe(1);
    expect(payload.activeThreadId).toBe('a');
    expect(payload.threads).toHaveLength(1);
    expect(payload.threads[0].id).toBe('a');
  });
});

describe('installAuthoritativeEntriesMirror', () => {
  it('立即镜像一次，并在每次 store 变更后继续镜像；返回取消订阅句柄', () => {
    const schedulePersist = vi.fn();
    const { store, emit, stop } = createFakeStore([makeThread('a')], 'a');
    const dispose = installAuthoritativeEntriesMirror(store, { schedulePersist });
    expect(schedulePersist).toHaveBeenCalledTimes(1);
    emit();
    expect(schedulePersist).toHaveBeenCalledTimes(2);
    expect(dispose).toBeTypeOf('function');
    dispose();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
