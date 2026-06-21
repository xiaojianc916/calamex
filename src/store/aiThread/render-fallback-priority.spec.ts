/* ============================================================================
 * 渲染回退「三路优先级」回归 harness（ADR-0014 Step 7 收尾 / Step 8 安全网）
 *
 * 在删除双轨期开关与旧渲染分支（Step 8）之前，把当前已稳定的契约钉死：
 *   1) activeThread 两路回退优先级：liveThread > persistedActiveThread
 *      —— legacy 投影（projectedActiveThread）随 aiConversation store 退役已移除，
 *      此前的 projected 档一并下线，仅保留 live / persisted 两路回归锁。
 *   2) 启动读管线端到端（7.5a 组合器 → 7.5b store 回退槽）：
 *      entries 快照 → resolvePersistedThreads 归一 → setPersistedThreads → activeThread。
 *   3) 坏快照回退 legacy（“迁移失败不致空白”）。
 *
 * 隔离策略与 persisted-read.spec.ts 对齐：指针恢复被 mock，
 * read 管线通过 7.5a/7.5c 暴露的 DI 缝注入假快照与真 resolver。
 * ========================================================================== */
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { useAiThreadStore } from '@/store/aiThread';
import { hydrateAiThreadEntriesForRender } from '@/store/aiThread/entriesRenderHydrate';
import { resolvePersistedThreads } from '@/store/aiThread/hydrate';
import { projectConversationToThreadPersist } from '@/store/aiThread/project';
import { runStartupPersistedRead } from '@/store/aiThread/startupPersistedReadWiring';
import type { IAiConversationThread } from '@/types/ai/conversation.schema';
import type { IAiThread } from '@/types/ai/thread';

vi.mock('@/store/plugins/attachmentPreviewStorage', () => ({
  restoreAttachmentPreviewPointers: async (value: unknown) => ({ changed: false, value }),
}));

const makeThread = (id: string): IAiThread =>
  ({ id, title: id, entries: [] }) as unknown as IAiThread;

const makeLegacyThread = (id: string): IAiConversationThread =>
  ({
    id,
    title: 'T-' + id,
    titleStatus: 'temporary',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messages: [],
  }) as unknown as IAiConversationThread;

// 冲刷 watcher(nextTick) 与异步指针恢复(微任务链)。
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await nextTick();
    await Promise.resolve();
  }
};

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('渲染回退两路优先级（回归 harness）', () => {
  it('persisted 缺席 → activeThread 为 null', async () => {
    const store = useAiThreadStore();
    expect(store.activeThread).toBeNull();
  });

  it('两路同存：live > persisted（legacy 投影退役后）', async () => {
    const store = useAiThreadStore();

    store.setPersistedThreads([makeThread('persisted')], 'persisted');
    await flush();
    expect(store.activeThread?.id).toBe('persisted');

    store.setLiveThread(makeThread('live'));
    expect(store.activeThread?.id).toBe('live');

    store.setLiveThread(null);
    expect(store.activeThread?.id).toBe('persisted');
  });

  it('activeEntries 跟随 activeThread', async () => {
    const store = useAiThreadStore();
    store.setPersistedThreads([makeThread('persisted')], 'persisted');
    await flush();
    expect(store.activeEntries).toBe(store.activeThread?.entries);
  });
});

describe('启动读管线端到端（7.5a 组合器 → 7.5b store）', () => {
  it('entries 快照 → resolve → persisted → activeThread', async () => {
    const store = useAiThreadStore();
    const snapshot = JSON.stringify(
      projectConversationToThreadPersist({
        activeThreadId: 'e2',
        threads: [makeLegacyThread('e1'), makeLegacyThread('e2')],
      }),
    );

    await runStartupPersistedRead({
      readLegacy: () => ({ legacyActiveThreadId: null, legacyThreads: [] }),
      hydrateForRender: (input) =>
        hydrateAiThreadEntriesForRender(input, {
          loadSnapshot: async () => ({ status: 'loaded', raw: snapshot }),
          resolve: resolvePersistedThreads,
          restorePointers: async (thread) => ({ changed: false, value: thread }),
        }),
      applyPersisted: (threads, activeThreadId) => {
        store.setPersistedThreads(threads, activeThreadId);
      },
    });
    await flush();

    expect(store.persistedThreads.map((thread) => thread.id)).toEqual(['e1', 'e2']);
    expect(store.activeThread?.id).toBe('e2');
  });

  it('坏快照 → resolver 回退 legacy，store 仍非空（不致空白）', async () => {
    const store = useAiThreadStore();

    await runStartupPersistedRead({
      readLegacy: () => ({ legacyActiveThreadId: 'L1', legacyThreads: [makeLegacyThread('L1')] }),
      hydrateForRender: (input) =>
        hydrateAiThreadEntriesForRender(input, {
          loadSnapshot: async () => ({ status: 'loaded', raw: '{ broken json' }),
          resolve: resolvePersistedThreads,
          restorePointers: async (thread) => ({ changed: false, value: thread }),
        }),
      applyPersisted: (threads, activeThreadId) => {
        store.setPersistedThreads(threads, activeThreadId);
      },
    });
    await flush();

    expect(store.persistedThreads.map((thread) => thread.id)).toEqual(['L1']);
    expect(store.activeThread?.id).toBe('L1');
  });
});
