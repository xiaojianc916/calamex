import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import type { IAiThread } from '@/types/ai/thread';

// 隔离持久化读路径：legacy 投影置空 (activeThread=null)；指针恢复注入假实现。
const { restoreMock } = vi.hoisted(() => ({ restoreMock: vi.fn() }));

vi.mock('@/store/aiConversation', () => ({
  useAiConversationStore: () => ({ activeThread: null }),
}));
vi.mock('@/store/plugins/debouncedPersistStorage', () => ({
  restoreAttachmentPreviewPointers: (value: unknown) => restoreMock(value),
}));

type UseAiThreadStore = typeof import('@/store/aiThread')['useAiThreadStore'];
let useAiThreadStore: UseAiThreadStore;

const makeThread = (id: string, title = id): IAiThread =>
  ({ id, title, entries: [] }) as unknown as IAiThread;

// 冲刷 watcher(nextTick) 与异步恢复(微任务链)。
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await nextTick();
    await Promise.resolve();
  }
};

beforeEach(async () => {
  setActivePinia(createPinia());
  restoreMock.mockReset();
  restoreMock.mockImplementation(async (value: unknown) => ({ changed: false, value }));
  ({ useAiThreadStore } = await import('@/store/aiThread'));
});

describe('aiThread store — 7.5b 持久化读路径', () => {
  it('activeThread 优先级 live > persisted > projected', async () => {
    const store = useAiThreadStore();
    expect(store.activeThread).toBeNull(); // projected 为 null（mock）

    store.setPersistedThreads([makeThread('a'), makeThread('b')], 'b');
    await flush();
    expect(store.persistedActiveThread?.id).toBe('b');
    expect(store.activeThread?.id).toBe('b');

    store.setLiveThread(makeThread('live'));
    expect(store.activeThread?.id).toBe('live');

    store.setLiveThread(null);
    expect(store.activeThread?.id).toBe('b');
  });

  it('persistedActiveThread 按 id 解析；空/不存在 → null', async () => {
    const store = useAiThreadStore();
    store.setPersistedThreads([makeThread('a'), makeThread('b')], null);
    await flush();
    expect(store.persistedActiveThread).toBeNull();

    store.setPersistedActiveThreadId('zzz');
    await flush();
    expect(store.persistedActiveThread).toBeNull();

    store.setPersistedActiveThreadId('a');
    await flush();
    expect(store.persistedActiveThread?.id).toBe('a');
  });

  it('换库 + 切换线程惰性恢复指针，且每线程仅恢复一次', async () => {
    restoreMock.mockImplementation(async (value: { title?: string }) => ({
      changed: true,
      value: { ...value, title: 'RESTORED' },
    }));

    const store = useAiThreadStore();
    store.setPersistedThreads([makeThread('a'), makeThread('b')], 'a');
    await flush();

    expect(restoreMock).toHaveBeenCalledTimes(1); // 仅活动线程 'a'
    expect(store.persistedThreads.find((t) => t.id === 'a')?.title).toBe('RESTORED');
    expect(store.persistedThreads.find((t) => t.id === 'b')?.title).toBe('b');

    store.setPersistedActiveThreadId('b');
    await flush();
    expect(restoreMock).toHaveBeenCalledTimes(2);
    expect(store.persistedThreads.find((t) => t.id === 'b')?.title).toBe('RESTORED');

    store.setPersistedActiveThreadId('a'); // 已恢复 → 不再调用
    await flush();
    expect(restoreMock).toHaveBeenCalledTimes(2);
  });

  it('changed:false 时不替换数组（保持对象身份）', async () => {
    const store = useAiThreadStore();
    const a = makeThread('a');
    store.setPersistedThreads([a], 'a');
    await flush();
    expect(restoreMock).toHaveBeenCalledTimes(1);
    expect(store.persistedThreads[0]).toBe(a);
  });

  it('setPersistedThreads 重置去重集：同 id 换库后再次恢复', async () => {
    restoreMock.mockImplementation(async (value: { title?: string }) => ({
      changed: true,
      value: { ...value, title: 'RESTORED' },
    }));
    const store = useAiThreadStore();

    store.setPersistedThreads([makeThread('a')], 'a');
    await flush();
    expect(restoreMock).toHaveBeenCalledTimes(1);

    store.setPersistedThreads([makeThread('a')], 'a'); // 新对象、同 id
    await flush();
    expect(restoreMock).toHaveBeenCalledTimes(2);
  });
});
