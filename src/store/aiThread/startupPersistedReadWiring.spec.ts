import { describe, expect, it } from 'vitest';
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
  it('hydrate 归一后灌入结果', async () => {
    const applied: Array<{ threads: IAiThread[]; activeThreadId: string | null }> = [];
    const resolved: IResolvedPersistedThreads = {
      source: 'entries',
      activeThreadId: 't1',
      threads: [makeThread('t1')],
    };

    await runStartupPersistedRead({
      hydrateForRender: async () => resolved,
      applyPersisted: (threads, activeThreadId) => {
        applied.push({ threads, activeThreadId });
      },
    });

    expect(applied).toEqual([{ threads: resolved.threads, activeThreadId: 't1' }]);
  });

  it('先 hydrate 再灌入，且只灌一次', async () => {
    const order: string[] = [];
    const resolved: IResolvedPersistedThreads = {
      source: 'empty',
      activeThreadId: null,
      threads: [],
    };

    await runStartupPersistedRead({
      hydrateForRender: async () => {
        order.push('hydrate');
        return resolved;
      },
      applyPersisted: () => {
        order.push('apply');
      },
    });

    expect(order).toEqual(['hydrate', 'apply']);
  });
});
