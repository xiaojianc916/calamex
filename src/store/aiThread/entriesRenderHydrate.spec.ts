import { describe, expect, it } from 'vitest';
import { hydrateAiThreadEntriesForRender } from '@/store/aiThread/entriesRenderHydrate';
import type {
  IResolvedPersistedThreads,
  IResolvePersistedThreadsInput,
} from '@/store/aiThread/hydrate';
import type { IAiConversationThread } from '@/types/ai/conversation.schema';
import type { IAiThread } from '@/types/ai/thread';

function makeThread(id: string): IAiThread {
  return {
    id,
    title: 'Thread ' + id,
    titleStatus: 'temporary',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    entries: [],
  };
}

describe('hydrateAiThreadEntriesForRender', () => {
  it('解析原始快照 JSON 并把 legacy 入参透传给 resolver', async () => {
    const receivedInputs: IResolvePersistedThreadsInput[] = [];
    const legacyThreads: IAiConversationThread[] = [];
    const resolved: IResolvedPersistedThreads = {
      source: 'entries',
      activeThreadId: null,
      threads: [],
    };

    const result = await hydrateAiThreadEntriesForRender(
      { legacyActiveThreadId: 'legacy-1', legacyThreads },
      {
        loadSnapshot: async () => ({ status: 'loaded', raw: JSON.stringify({ hello: 'world' }) }),
        resolve: (input) => {
          receivedInputs.push(input);
          return resolved;
        },
        restorePointers: async (value: IAiThread) => ({ changed: false, value }),
      },
    );

    const received = receivedInputs[0];
    expect(received).toBeDefined();
    expect(received?.rawEntriesSnapshot).toEqual({ hello: 'world' });
    expect(received?.legacyActiveThreadId).toBe('legacy-1');
    expect(received?.legacyThreads).toBe(legacyThreads);
    expect(result).toBe(resolved);
  });

  it('坏 JSON 容错为 null（交由 resolver 回退 legacy）', async () => {
    const receivedInputs: IResolvePersistedThreadsInput[] = [];
    const resolved: IResolvedPersistedThreads = {
      source: 'legacy',
      activeThreadId: null,
      threads: [],
    };

    await hydrateAiThreadEntriesForRender(
      { legacyActiveThreadId: null, legacyThreads: [] },
      {
        loadSnapshot: async () => ({ status: 'loaded', raw: '{ not valid json' }),
        resolve: (input) => {
          receivedInputs.push(input);
          return resolved;
        },
        restorePointers: async (value: IAiThread) => ({ changed: false, value }),
      },
    );

    expect(receivedInputs[0]?.rawEntriesSnapshot).toBeNull();
  });

  it('仅对活动线程即时恢复指针，且不可变替换', async () => {
    const t1 = makeThread('t1');
    const t2 = makeThread('t2');
    const restoredT2: IAiThread = { ...makeThread('t2'), title: 'restored' };
    const threads = [t1, t2];
    const resolved: IResolvedPersistedThreads = {
      source: 'entries',
      activeThreadId: 't2',
      threads,
    };
    const restoreCalls: IAiThread[] = [];

    const result = await hydrateAiThreadEntriesForRender(
      { legacyActiveThreadId: null, legacyThreads: [] },
      {
        loadSnapshot: async () => ({ status: 'loaded', raw: '{}' }),
        resolve: () => resolved,
        restorePointers: async (value: IAiThread) => {
          restoreCalls.push(value);
          return { changed: true, value: restoredT2 };
        },
      },
    );

    expect(restoreCalls).toEqual([t2]);
    expect(result.threads[0]).toBe(t1);
    expect(result.threads[1]).toBe(restoredT2);
    expect(threads[1]).toBe(t2);
    expect(result.threads).not.toBe(threads);
  });

  it('指针恢复抛错非致命，原样返回 resolved', async () => {
    const t1 = makeThread('t1');
    const resolved: IResolvedPersistedThreads = {
      source: 'entries',
      activeThreadId: 't1',
      threads: [t1],
    };

    const result = await hydrateAiThreadEntriesForRender(
      { legacyActiveThreadId: null, legacyThreads: [] },
      {
        loadSnapshot: async () => ({ status: 'loaded', raw: '{}' }),
        resolve: () => resolved,
        restorePointers: async () => {
          throw new Error('idb down');
        },
      },
    );

    expect(result).toBe(resolved);
    expect(result.threads[0]).toBe(t1);
  });
});
