import { describe, expect, it } from 'vitest';
import { resolvePersistedThreads } from '@/store/aiThread/hydrate';
import type { IAiConversationThread } from '@/types/ai/conversation.schema';

const ISO_A = '2026-06-19T10:00:00.000Z';
const ISO_B = '2026-06-19T10:01:00.000Z';

const userMessageEntry = (id: string, text: string) => ({
  type: 'user_message',
  id,
  createdAt: ISO_A,
  content: text.length > 0 ? [{ type: 'text', text }] : [],
  references: [],
});

const entriesThread = (id: string, entries: unknown[]) => ({
  id,
  title: 'Thread ' + id,
  titleStatus: 'generated',
  createdAt: ISO_A,
  updatedAt: ISO_B,
  entries,
});

const legacyUserThread = (id: string): IAiConversationThread =>
  ({
    id,
    title: 'Legacy ' + id,
    titleStatus: 'generated',
    createdAt: ISO_A,
    updatedAt: ISO_B,
    messages: [{ role: 'user', id: 'm-' + id, createdAt: ISO_A, content: 'hello', references: [] }],
  }) as unknown as IAiConversationThread;

describe('resolvePersistedThreads（Step 7.3 读路径优先级）', () => {
  it('新 key 严格解析成功 → 直接采用 entries', () => {
    const snapshot = {
      version: 1,
      activeThreadId: 't1',
      threads: [entriesThread('t1', [userMessageEntry('u1', 'hi')])],
    };
    const result = resolvePersistedThreads({
      rawEntriesSnapshot: snapshot,
      legacyActiveThreadId: null,
      legacyThreads: [],
    });
    expect(result.source).toBe('entries');
    expect(result.activeThreadId).toBe('t1');
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0].entries).toHaveLength(1);
  });

  it('新 key 含单条坏 entry → 逐条救援，丢坏留好', () => {
    const snapshot = {
      version: 1,
      activeThreadId: 't1',
      threads: [
        entriesThread('t1', [userMessageEntry('u1', 'ok'), userMessageEntry('', 'bad-empty-id')]),
      ],
    };
    const result = resolvePersistedThreads({
      rawEntriesSnapshot: snapshot,
      legacyActiveThreadId: null,
      legacyThreads: [],
    });
    expect(result.source).toBe('entries-salvaged');
    expect(result.threads[0].entries).toHaveLength(1);
    expect(result.threads[0].entries[0].type).toBe('user_message');
  });

  it('新 key 缺失 → 回退 legacy，按线程投影为 entries', () => {
    const result = resolvePersistedThreads({
      rawEntriesSnapshot: null,
      legacyActiveThreadId: 'L1',
      legacyThreads: [legacyUserThread('L1')],
    });
    expect(result.source).toBe('legacy');
    expect(result.activeThreadId).toBe('L1');
    expect(result.threads[0].entries[0].type).toBe('user_message');
  });

  it('新 key 存在但不可救援（threads 非数组）→ 回退 legacy', () => {
    const result = resolvePersistedThreads({
      rawEntriesSnapshot: { version: 1, activeThreadId: 'x', threads: 'not-an-array' },
      legacyActiveThreadId: 'L1',
      legacyThreads: [legacyUserThread('L1')],
    });
    expect(result.source).toBe('legacy');
  });

  it('新旧 key 都空 → 空态', () => {
    const result = resolvePersistedThreads({
      rawEntriesSnapshot: null,
      legacyActiveThreadId: null,
      legacyThreads: [],
    });
    expect(result.source).toBe('empty');
    expect(result.activeThreadId).toBeNull();
    expect(result.threads).toEqual([]);
  });

  it('activeThreadId 指向不存在线程 → 校正为首个线程', () => {
    const snapshot = {
      version: 1,
      activeThreadId: 'nope',
      threads: [entriesThread('t1', [userMessageEntry('u1', 'hi')])],
    };
    const result = resolvePersistedThreads({
      rawEntriesSnapshot: snapshot,
      legacyActiveThreadId: null,
      legacyThreads: [],
    });
    expect(result.source).toBe('entries');
    expect(result.activeThreadId).toBe('t1');
  });

  it('新 key 严格成功但 threads 为空 → 尊重空态，不复活 legacy', () => {
    const result = resolvePersistedThreads({
      rawEntriesSnapshot: { version: 1, activeThreadId: null, threads: [] },
      legacyActiveThreadId: 'L1',
      legacyThreads: [legacyUserThread('L1')],
    });
    expect(result.source).toBe('entries');
    expect(result.threads).toEqual([]);
    expect(result.activeThreadId).toBeNull();
  });
});
