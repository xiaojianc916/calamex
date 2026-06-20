import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';

import { useAiThreadStore } from '@/store/aiThread';
import type { TAiThreadReduceEvent } from '@/store/aiThread/events';
import type { IAiThread, IAiThreadEntry } from '@/types/ai/thread';

const AT = '2026-01-01T00:00:00.000Z';

const userEntry = (id: string, text: string, createdAt: string = AT): IAiThreadEntry => ({
  type: 'user_message',
  id,
  createdAt,
  content: text ? [{ type: 'text', text }] : [],
  references: [],
});

const userEvent = (id: string, text: string, createdAt: string = AT): TAiThreadReduceEvent => ({
  kind: 'user_message',
  id,
  createdAt,
  blocks: [{ type: 'text', text }],
  references: [],
});

const scroll = (scrollTop: number) => ({
  scrollTop,
  scrollHeight: 1000,
  clientHeight: 500,
  distanceFromBottom: 0,
  updatedAt: AT,
});

describe('useAiThreadStore Step8砖2b 权威读写（未接线，零行为）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('初始权威状态持有一个空线程，且不影响既有渲染派生', () => {
    const store = useAiThreadStore();
    expect(store.authoritativeThreads).toHaveLength(1);
    expect(store.authoritativeActiveThreadId).toBe(store.authoritativeThreads[0].id);
    expect(store.authoritativeActiveEntries).toEqual([]);
    expect(store.authoritativeHasEntries).toBe(false);
    // 渲染权威仍走 legacy 投影，未被新状态影响。
    expect(store.activeEntries).toEqual([]);
  });

  it('applyReduceEvent 写入权威 active 线程，渲染派生 activeEntries 不受影响', () => {
    const store = useAiThreadStore();
    store.applyReduceEvent(userEvent('m1', 'first question'));
    expect(store.authoritativeActiveEntries).toHaveLength(1);
    expect(store.authoritativeActiveEntries[0].type).toBe('user_message');
    const active = store.authoritativeThreads.find(
      (thread) => thread.id === store.authoritativeActiveThreadId,
    );
    expect(active?.title).toBe('first question');
    // 关键零行为断言：未接线，渲染权威 activeEntries 仍为空。
    expect(store.activeEntries).toEqual([]);
  });

  it('startNewThread / switchThread 管理权威线程', () => {
    const store = useAiThreadStore();
    store.applyReduceEvent(userEvent('m1', 'q'));
    const firstId = store.authoritativeActiveThreadId as string;
    store.startNewThread();
    expect(store.authoritativeThreads).toHaveLength(2);
    expect(store.authoritativeActiveThreadId).not.toBe(firstId);
    store.switchThread(firstId);
    expect(store.authoritativeActiveThreadId).toBe(firstId);
    store.switchThread('missing');
    expect(store.authoritativeActiveThreadId).toBe(firstId);
  });

  it('deleteThread 命中返回 true 并移除，未命中返回 false', () => {
    const store = useAiThreadStore();
    store.applyReduceEvent(userEvent('m1', 'q'));
    store.startNewThread();
    const ids = store.authoritativeThreads.map((thread) => thread.id);
    expect(store.deleteThread(ids[0])).toBe(true);
    expect(store.authoritativeThreads.some((thread) => thread.id === ids[0])).toBe(false);
    expect(store.deleteThread('missing')).toBe(false);
  });

  it('clearActiveThread 丢弃当前 active 换空线程', () => {
    const store = useAiThreadStore();
    store.applyReduceEvent(userEvent('m1', 'q'));
    const before = store.authoritativeActiveThreadId;
    store.clearActiveThread();
    expect(store.authoritativeActiveThreadId).not.toBe(before);
    expect(store.authoritativeActiveEntries).toEqual([]);
    expect(store.authoritativeThreads.some((thread) => thread.id === before)).toBe(false);
  });

  it('滚动状态节流：updateThreadScrollState 缓冲，flush 后写入归一整数', () => {
    const store = useAiThreadStore();
    const threadId = store.authoritativeActiveThreadId as string;
    store.updateThreadScrollState(threadId, scroll(12.7));
    const beforeFlush = store.authoritativeThreads.find((thread) => thread.id === threadId);
    expect(beforeFlush?.scrollState).toBeUndefined();
    store.flushPendingScrollStateUpdates();
    const afterFlush = store.authoritativeThreads.find((thread) => thread.id === threadId);
    expect(afterFlush?.scrollState?.scrollTop).toBe(13);
  });

  it('标题生成：generating -> generated，且 generated 不被 failed 回退', () => {
    const store = useAiThreadStore();
    store.applyReduceEvent(userEvent('m1', 'q'));
    const threadId = store.authoritativeActiveThreadId as string;
    store.markThreadTitleGenerating(threadId);
    expect(store.getThreadTitleStatus(threadId)).toBe('generating');
    store.completeThreadTitleGeneration(threadId, '  新标题  ');
    expect(store.getThreadTitleStatus(threadId)).toBe('generated');
    store.failThreadTitleGeneration(threadId);
    expect(store.getThreadTitleStatus(threadId)).toBe('generated');
  });

  it('setAuthoritativeThreads + getFirstRoundForTitle 取首轮问答', () => {
    const store = useAiThreadStore();
    const thread: IAiThread = {
      id: 'seed',
      title: 'seed',
      titleStatus: 'temporary',
      createdAt: AT,
      updatedAt: AT,
      entries: [
        userEntry('u', 'question'),
        {
          type: 'assistant_message',
          id: 'a',
          createdAt: AT,
          chunks: [{ type: 'message', block: { type: 'text', text: 'answer' } }],
        },
      ],
    };
    store.setAuthoritativeThreads([thread], 'seed');
    expect(store.getFirstRoundForTitle('seed')).toEqual({
      userMessage: 'question',
      assistantMessage: 'answer',
    });
  });
});
