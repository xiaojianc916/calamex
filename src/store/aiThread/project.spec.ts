import { describe, expect, it } from 'vitest';
import { resolvePersistedThreads } from '@/store/aiThread/hydrate';
import {
  projectConversationThreadsToEntries,
  projectConversationToThreadPersist,
} from '@/store/aiThread/project';
import type { IAiConversationThread } from '@/types/ai/conversation.schema';
import { AI_THREAD_PERSIST_VERSION, aiThreadPersistSchema } from '@/types/ai/thread/persist.schema';

const makeLegacyThread = (
  id: string,
  overrides: Record<string, unknown> = {},
): IAiConversationThread =>
  ({
    id,
    title: 'T-' + id,
    titleStatus: 'temporary',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messages: [],
    ...overrides,
  }) as unknown as IAiConversationThread;

describe('projectConversationToThreadPersist', () => {
  it('空线程 → version + null active + 空数组', () => {
    const result = projectConversationToThreadPersist({ activeThreadId: null, threads: [] });
    expect(result.version).toBe(AI_THREAD_PERSIST_VERSION);
    expect(result.activeThreadId).toBeNull();
    expect(result.threads).toEqual([]);
    expect(aiThreadPersistSchema.safeParse(result).success).toBe(true);
  });

  it('单线程 → active 落在该线程, 且 schema 合法', () => {
    const result = projectConversationToThreadPersist({
      activeThreadId: 'a',
      threads: [makeLegacyThread('a')],
    });
    expect(result.threads).toHaveLength(1);
    expect(result.activeThreadId).toBe('a');
    expect(aiThreadPersistSchema.safeParse(result).success).toBe(true);
  });

  it('active 指向不存在的线程 → 归一到首个线程', () => {
    const result = projectConversationToThreadPersist({
      activeThreadId: 'missing',
      threads: [makeLegacyThread('a'), makeLegacyThread('b')],
    });
    expect(result.activeThreadId).toBe('a');
  });

  it('active 为 null 但有线程 → 归一到首个线程', () => {
    const result = projectConversationToThreadPersist({
      activeThreadId: null,
      threads: [makeLegacyThread('x'), makeLegacyThread('y')],
    });
    expect(result.activeThreadId).toBe('x');
  });

  it('保持线程顺序', () => {
    const result = projectConversationToThreadPersist({
      activeThreadId: 'b',
      threads: [makeLegacyThread('a'), makeLegacyThread('b'), makeLegacyThread('c')],
    });
    expect(result.threads.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('往返对称: project → parse → resolvePersistedThreads 得 entries', () => {
    const projected = projectConversationToThreadPersist({
      activeThreadId: 'a',
      threads: [makeLegacyThread('a'), makeLegacyThread('b')],
    });
    const parsed = aiThreadPersistSchema.safeParse(projected);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const resolved = resolvePersistedThreads({
      rawEntriesSnapshot: parsed.data,
      legacyActiveThreadId: null,
      legacyThreads: [],
    });
    expect(resolved.source).toBe('entries');
    expect(resolved.threads.map((t) => t.id)).toEqual(['a', 'b']);
    expect(resolved.activeThreadId).toBe('a');
  });
});

describe('projectConversationThreadsToEntries', () => {
  it('逐线程映射且保持顺序', () => {
    const out = projectConversationThreadsToEntries([makeLegacyThread('a'), makeLegacyThread('b')]);
    expect(out.map((t) => t.id)).toEqual(['a', 'b']);
  });
});
