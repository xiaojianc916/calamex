import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IAiChatMessage } from '@/types/ai';

import { useAiConversationStore } from './aiConversation';

const createMessage = (index: number): IAiChatMessage => ({
  id: `message-${index}`,
  role: index % 2 === 0 ? 'assistant' : 'user',
  content: `第 ${index} 条对话`,
  createdAt: new Date(Date.UTC(2026, 3, 28, 10, index % 60, 0)).toISOString(),
  references: [],
});

// 这些用例锁定 A 优化的核心保证: 单条线程变更不应重建其它线程对象,
// 即未改动线程保持引用稳定(结构共享), 从而避免对全部线程重跑 syncThreadMeta。
describe('useAiConversationStore 结构共享(性能)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('向 active 线程追加消息时不重建其它历史线程对象', () => {
    const store = useAiConversationStore();

    store.replaceMessages([createMessage(1)]);
    const firstThreadId = store.activeThreadId;
    store.startNewThread();
    store.replaceMessages([createMessage(2)]);

    const firstThreadRef = store.threads.find((thread) => thread.id === firstThreadId);
    expect(firstThreadRef).toBeTruthy();

    store.appendMessage(createMessage(3));

    const firstThreadRefAfter = store.threads.find((thread) => thread.id === firstThreadId);
    expect(firstThreadRefAfter).toBe(firstThreadRef);
  });

  it('更新某线程滚动状态时不重建其它线程对象', () => {
    const store = useAiConversationStore();

    store.replaceMessages([createMessage(1)]);
    const firstThreadId = store.activeThreadId;
    store.startNewThread();
    store.replaceMessages([createMessage(2)]);
    const secondThreadId = store.activeThreadId;

    const firstThreadRef = store.threads.find((thread) => thread.id === firstThreadId);

    store.updateThreadScrollState(secondThreadId ?? '', {
      scrollTop: 320,
      scrollHeight: 1280,
      clientHeight: 640,
      distanceFromBottom: 320,
      updatedAt: '2026-05-10T12:00:00.000Z',
    });

    expect(store.threads.find((thread) => thread.id === firstThreadId)).toBe(firstThreadRef);
  });

  it('回写非当前线程消息时仍同步其标题与更新时间, 且不影响当前线程引用', () => {
    const store = useAiConversationStore();

    store.replaceMessages([createMessage(1)]);
    const firstThreadId = store.activeThreadId;
    store.startNewThread();
    store.replaceMessages([createMessage(2)]);
    const activeThreadRef = store.activeThread;

    const rewritten: IAiChatMessage = {
      ...createMessage(9),
      role: 'user',
      content: '回写后的首条消息',
    };
    store.replaceThreadMessages(firstThreadId ?? '', [rewritten]);

    const firstThread = store.threads.find((thread) => thread.id === firstThreadId);
    expect(firstThread?.title).toBe('回写后的首条消息');
    expect(firstThread?.updatedAt).toBe(rewritten.createdAt);
    expect(store.activeThread).toBe(activeThreadRef);
  });
});
