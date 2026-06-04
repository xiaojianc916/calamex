// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IAiChatMessage } from '@/types/ai';

import { useAiConversationStore } from './aiConversation';

// 懒解析依赖 idb-keyval 读取 attachmentPreview base64；此处用内存 Map 模拟。
const { idbMock } = vi.hoisted(() => {
  const map = new Map<string, string>();
  return {
    idbMock: {
      map,
      createStore: vi.fn(() => ({})),
      get: vi.fn(async (key: string) => map.get(key)),
      set: vi.fn(async (key: string, value: string) => {
        map.set(key, value);
      }),
      del: vi.fn(async (key: string) => {
        map.delete(key);
      }),
    },
  };
});

vi.mock('idb-keyval', () => ({
  createStore: idbMock.createStore,
  get: idbMock.get,
  set: idbMock.set,
  del: idbMock.del,
}));

const POINTER = 'idb://ai-conversation-attachment-preview/lazy1';
const PREVIEW_KEY = 'ai-conversation-attachment-preview:lazy1';
const BASE64 = 'data:image/png;base64,LAZY-RESOLVED';

const createPointerImageMessage = (index: number): IAiChatMessage => ({
  id: `message-${index}`,
  role: 'user',
  content: `第 ${index} 条`,
  createdAt: new Date(Date.UTC(2026, 3, 28, 10, index % 60, 0)).toISOString(),
  references: [
    {
      id: `image-${index}`,
      kind: 'image-attachment',
      label: '图片附件',
      path: 'pasted.png',
      range: null,
      contentPreview: '图片附件',
      redacted: false,
      attachmentPreview: { src: POINTER, width: 1, height: 1, mimeType: 'image/png' },
    },
  ],
});

const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe('useAiConversationStore 懒加载图片解析', () => {
  beforeEach(() => {
    idbMock.map.clear();
    idbMock.get.mockClear();
    setActivePinia(createPinia());
  });

  it('切换到含指针的历史线程时按需把指针解析回 base64', async () => {
    idbMock.map.set(PREVIEW_KEY, BASE64);
    const store = useAiConversationStore();

    // 线程 1：含图片指针（模拟 hydrate 后未解析的历史线程）
    store.replaceMessages([createPointerImageMessage(1)]);
    const firstThreadId = store.activeThreadId ?? '';
    // 线程 2：设为 active，让线程 1 成为非 active
    store.startNewThread();
    store.replaceMessages([createPointerImageMessage(2)]);

    // 切回线程 1 触发懒解析
    store.switchThread(firstThreadId);
    await flushMicrotasks();

    const firstThread = store.threads.find((thread) => thread.id === firstThreadId);
    expect(firstThread?.messages[0]?.references[0]?.attachmentPreview?.src).toBe(BASE64);
  });

  it('线程消息无指针时不触发 idb 读取', async () => {
    const store = useAiConversationStore();
    store.replaceMessages([
      {
        id: 'message-1',
        role: 'user',
        content: '纯文本',
        createdAt: new Date().toISOString(),
        references: [],
      },
    ]);
    const threadId = store.activeThreadId ?? '';
    idbMock.get.mockClear();

    store.switchThread(threadId);
    await flushMicrotasks();

    expect(idbMock.get).not.toHaveBeenCalled();
  });
});
