import { describe, expect, it } from 'vitest';

import type { IAiConversationThread } from '@/store/aiConversation';
import type { IHydrateAiThreadEntriesForRenderInput } from '@/store/aiThread/entriesRenderHydrate';
import type { IResolvedPersistedThreads } from '@/store/aiThread/hydrate';
import { runStartupPersistedRead } from '@/store/aiThread/startupPersistedReadWiring';
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

describe('runStartupPersistedRead', () => {
  it('把 legacy 快照透传给 7.5a 组合器，并灌入归一结果', async () => {
    const legacyThreads: IAiConversationThread[] = [];
    let hydrateInput: IHydrateAiThreadEntriesForRenderInput | null = null;
    const applied: Array<{ threads: IAiThread[]; activeThreadId: string | null }> = [];
    const resolved: IResolvedPersistedThreads = {
      source: 'entries',
      activeThreadId: 't1',
      threads: [makeThread('t1')],
    };

    await runStartupPersistedRead({
      readLegacy: () => ({ legacyActiveThreadId: 'leg-1', legacyThreads }),
      hydrateForRender: async (input) => {
        hydrateInput = input;
        return resolved;
      },
      applyPersisted: (threads, activeThreadId) => {
        applied.push({ threads, activeThreadId });
      },
    });

    expect(hydrateInput).toEqual({ legacyActiveThreadId: 'leg-1', legacyThreads });
    expect(applied).toEqual([{ threads: resolved.threads, activeThreadId: 't1' }]);
  });

  it('先读 legacy 再 hydrate 再灌入，且只灌一次', async () => {
    const order: string[] = [];
    const resolved: IResolvedPersistedThreads = {
      source: 'empty',
      activeThreadId: null,
      threads: [],
    };

    await runStartupPersistedRead({
      readLegacy: () => {
        order.push('read');
        return { legacyActiveThreadId: null, legacyThreads: [] };
      },
      hydrateForRender: async () => {
        order.push('hydrate');
        return resolved;
      },
      applyPersisted: () => {
        order.push('apply');
      },
    });

    expect(order).toEqual(['read', 'hydrate', 'apply']);
  });
});
