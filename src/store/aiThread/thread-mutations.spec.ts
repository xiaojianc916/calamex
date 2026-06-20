import { describe, expect, it } from 'vitest';

import type { TAiThreadReduceEvent } from '@/store/aiThread/events';
import {
  AI_THREAD_HISTORY_LIMIT,
  applyReduceEvent,
  clearActiveThread,
  commitThreadsState,
  completeThreadTitleGeneration,
  createThread,
  deleteThread,
  deriveTemporaryThreadTitle,
  failThreadTitleGeneration,
  getFirstRoundFromEntries,
  type IAiThreadScrollState,
  type IAiThreadState,
  markThreadTitleGenerating,
  normalizeGeneratedTitle,
  setThreadScrollState,
  startNewThread,
  switchThread,
} from '@/store/aiThread/thread-mutations';
import type { IAiThread, IAiThreadEntry } from '@/types/ai/thread';

const AT = '2026-01-01T00:00:00.000Z';

const userEntry = (id: string, text: string, createdAt: string = AT): IAiThreadEntry => ({
  type: 'user_message',
  id,
  createdAt,
  content: text ? [{ type: 'text', text }] : [],
  references: [],
});

const nonEmptyThread = (id: string): IAiThread => ({
  id,
  title: 'thread ' + id,
  titleStatus: 'temporary',
  createdAt: AT,
  updatedAt: AT,
  entries: [userEntry(id + '-u', 'hi')],
});

const userEvent = (id: string, text: string, createdAt: string = AT): TAiThreadReduceEvent => ({
  kind: 'user_message',
  id,
  createdAt,
  blocks: [{ type: 'text', text }],
  references: [],
});

const scroll = (scrollTop: number): IAiThreadScrollState => ({
  scrollTop,
  scrollHeight: 1000,
  clientHeight: 500,
  distanceFromBottom: 0,
  updatedAt: AT,
});

describe('thread-mutations 标题派生', () => {
  it('createThread 空线程标题为「新对话」、状态 temporary、无 entries', () => {
    const thread = createThread([], AT);
    expect(thread.title).toBe('新对话');
    expect(thread.titleStatus).toBe('temporary');
    expect(thread.entries).toEqual([]);
    expect(thread.createdAt).toBe(AT);
    expect(thread.updatedAt).toBe(AT);
  });

  it('deriveTemporaryThreadTitle 取首条 user_message 文本，折叠空白并裁剪到 24 字', () => {
    expect(deriveTemporaryThreadTitle([userEntry('u1', '  hello   world  ')])).toBe('hello world');
    const long = 'x'.repeat(40);
    const title = deriveTemporaryThreadTitle([userEntry('u2', long)]);
    expect(Array.from(title)).toHaveLength(25); // 24 + 省略号
    expect(title.endsWith('…')).toBe(true);
  });

  it('normalizeGeneratedTitle 去引号、裁剪到 10 字、去尾省略号', () => {
    expect(normalizeGeneratedTitle('“标题”')).toBe('标题');
    const clipped = normalizeGeneratedTitle('一二三四五六七八九十十一十二');
    expect(Array.from(clipped)).toHaveLength(10);
    expect(clipped.endsWith('…')).toBe(false);
  });
});

describe('thread-mutations reduce 提交', () => {
  it('applyReduceEvent 在空态下新建线程并追加 user_message entry', () => {
    const state: IAiThreadState = { threads: [], activeThreadId: null };
    const next = applyReduceEvent(
      state,
      userEvent('m1', 'first question', '2026-02-02T00:00:00.000Z'),
    );
    expect(next.threads).toHaveLength(1);
    expect(next.activeThreadId).toBe(next.threads[0].id);
    expect(next.threads[0].entries).toHaveLength(1);
    expect(next.threads[0].entries[0].type).toBe('user_message');
    expect(next.threads[0].title).toBe('first question');
    expect(next.threads[0].updatedAt).toBe('2026-02-02T00:00:00.000Z');
  });
});

describe('thread-mutations 生命周期', () => {
  it('startNewThread 追加空线程并切为 active', () => {
    const base: IAiThreadState = { threads: [nonEmptyThread('a')], activeThreadId: 'a' };
    const next = startNewThread(base);
    expect(next.threads).toHaveLength(2);
    expect(next.activeThreadId).not.toBe('a');
    const active = next.threads.find((thread) => thread.id === next.activeThreadId);
    expect(active?.entries).toEqual([]);
  });

  it('switchThread 命中才切换，未命中保持原引用', () => {
    const base: IAiThreadState = {
      threads: [nonEmptyThread('a'), nonEmptyThread('b')],
      activeThreadId: 'a',
    };
    expect(switchThread(base, 'b').activeThreadId).toBe('b');
    expect(switchThread(base, 'missing')).toBe(base);
  });

  it('deleteThread 删除 active 时回退到末尾线程', () => {
    const base: IAiThreadState = {
      threads: [nonEmptyThread('a'), nonEmptyThread('b'), nonEmptyThread('c')],
      activeThreadId: 'b',
    };
    const next = deleteThread(base, 'b');
    expect(next.threads.map((thread) => thread.id)).toEqual(['a', 'c']);
    expect(next.activeThreadId).toBe('c');
  });

  it('deleteThread 删除最后一条线程时兜底新建空线程', () => {
    const base: IAiThreadState = { threads: [nonEmptyThread('only')], activeThreadId: 'only' };
    const next = deleteThread(base, 'only');
    expect(next.threads).toHaveLength(1);
    expect(next.threads[0].id).not.toBe('only');
    expect(next.threads[0].entries).toEqual([]);
    expect(next.activeThreadId).toBe(next.threads[0].id);
  });

  it('clearActiveThread 移除当前 active 并以空线程顶替', () => {
    const base: IAiThreadState = { threads: [nonEmptyThread('a')], activeThreadId: 'a' };
    const next = clearActiveThread(base);
    expect(next.threads.some((thread) => thread.id === 'a')).toBe(false);
    expect(next.threads).toHaveLength(1);
    expect(next.threads[0].entries).toEqual([]);
  });
});

describe('thread-mutations 裁剪', () => {
  it('线程数超过上限时裁剪，但始终保住 active', () => {
    const threads: IAiThread[] = [];
    for (let index = 0; index <= AI_THREAD_HISTORY_LIMIT; index += 1) {
      threads.push(nonEmptyThread('t' + index));
    }
    const next = commitThreadsState({ threads, activeThreadId: 't0' });
    expect(next.threads.length).toBe(AI_THREAD_HISTORY_LIMIT + 1);
    expect(next.threads.some((thread) => thread.id === 't0')).toBe(true);
    expect(next.activeThreadId).toBe('t0');
  });
});

describe('thread-mutations 标题生成', () => {
  it('markThreadTitleGenerating 把非 generated 置为 generating', () => {
    const base: IAiThreadState = { threads: [nonEmptyThread('a')], activeThreadId: 'a' };
    expect(markThreadTitleGenerating(base, 'a').threads[0].titleStatus).toBe('generating');
  });

  it('completeThreadTitleGeneration 成功写入归一标题，空标题落 failed', () => {
    const base: IAiThreadState = { threads: [nonEmptyThread('a')], activeThreadId: 'a' };
    const ok = completeThreadTitleGeneration(base, 'a', '  新标题  ');
    expect(ok.threads[0].title).toBe('新标题');
    expect(ok.threads[0].titleStatus).toBe('generated');
    const empty = completeThreadTitleGeneration(base, 'a', '   ');
    expect(empty.threads[0].titleStatus).toBe('failed');
  });

  it('failThreadTitleGeneration 把非 generated 置为 failed', () => {
    const base: IAiThreadState = { threads: [nonEmptyThread('a')], activeThreadId: 'a' };
    expect(failThreadTitleGeneration(base, 'a').threads[0].titleStatus).toBe('failed');
  });

  it('getFirstRoundFromEntries 取首轮 user / assistant 文本', () => {
    const entries: IAiThreadEntry[] = [
      userEntry('u', 'question'),
      {
        type: 'assistant_message',
        id: 'a',
        createdAt: AT,
        chunks: [{ type: 'message', block: { type: 'text', text: 'answer' } }],
      },
    ];
    expect(getFirstRoundFromEntries(entries)).toEqual({
      userMessage: 'question',
      assistantMessage: 'answer',
    });
    expect(getFirstRoundFromEntries([userEntry('u', 'only question')])).toBeNull();
  });
});

describe('thread-mutations 滚动状态', () => {
  it('setThreadScrollState 写入归一化后的整数滚动位置', () => {
    const base: IAiThreadState = { threads: [nonEmptyThread('a')], activeThreadId: 'a' };
    const next = setThreadScrollState(base, 'a', scroll(12.7));
    expect(next.threads[0].scrollState?.scrollTop).toBe(13);
  });

  it('setThreadScrollState 对等价(四舍五入相同)滚动状态短路返回原状态', () => {
    const base: IAiThreadState = { threads: [nonEmptyThread('a')], activeThreadId: 'a' };
    const once = setThreadScrollState(base, 'a', scroll(12.7));
    const twice = setThreadScrollState(once, 'a', scroll(13.2));
    expect(twice).toBe(once);
  });
});
