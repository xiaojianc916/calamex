import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IAiChatMessage } from '@/types/ai';
import {
  AI_CONVERSATION_HISTORY_LIMIT,
  normalizeHydratedMessage,
  salvageHydratedThreads,
  useAiConversationStore,
} from './aiConversation';

const createMessage = (index: number): IAiChatMessage => ({
  id: `message-${index}`,
  role: index % 2 === 0 ? 'assistant' : 'user',
  content: `第 ${index} 条对话`,
  createdAt: new Date(Date.UTC(2026, 3, 28, 10, index % 60, 0)).toISOString(),
  references: [],
});

const createImageMessage = (index: number): IAiChatMessage => ({
  ...createMessage(index),
  role: 'user',
  references: [
    {
      id: `image-reference-${index}-1`,
      kind: 'image-attachment',
      label: `图片附件 · image-${index}-1.png`,
      path: `image-${index}-1.png`,
      range: null,
      contentPreview: `第 ${index} 个会话的第 1 张图片`,
      redacted: false,
      attachmentPreview: {
        src: `data:image/png;base64,thread-${index}-image-1`,
        width: 320,
        height: 200,
        mimeType: 'image/png',
      },
    },
    {
      id: `image-reference-${index}-2`,
      kind: 'image-attachment',
      label: `图片附件 · image-${index}-2.png`,
      path: `image-${index}-2.png`,
      range: null,
      contentPreview: `第 ${index} 个会话的第 2 张图片`,
      redacted: false,
      attachmentPreview: {
        src: `data:image/png;base64,thread-${index}-image-2`,
        width: 640,
        height: 480,
        mimeType: 'image/png',
      },
    },
  ],
});

describe('useAiConversationStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('新建对话时保留旧会话并切到新的空白会话', () => {
    const store = useAiConversationStore();
    store.replaceMessages([createMessage(1), createMessage(2)]);
    const firstThreadId = store.activeThreadId;
    const firstThreadMessages = [...store.activeMessages];
    store.startNewThread();
    expect(store.activeThreadId).not.toBe(firstThreadId);
    expect(store.activeMessages).toHaveLength(0);
    expect(store.historyThreads).toHaveLength(1);
    expect(store.historyThreads[0]?.messages).toEqual(firstThreadMessages);
  });

  it('只保留最近的会话存储上限', () => {
    const store = useAiConversationStore();
    store.replaceMessages([createMessage(1)]);
    for (let index = 2; index <= AI_CONVERSATION_HISTORY_LIMIT + 2; index += 1) {
      store.startNewThread();
      store.replaceMessages([createMessage(index)]);
    }
    expect(store.historyThreads).toHaveLength(AI_CONVERSATION_HISTORY_LIMIT);
    expect(store.historyThreads[0]?.messages[0]?.id).toBe('message-3');
    expect(store.historyThreads.at(-1)?.messages[0]?.id).toBe(
      `message-${AI_CONVERSATION_HISTORY_LIMIT + 2}`,
    );
  });

  it('裁剪过期会话时会连同会话内全部图片预览一起移除', () => {
    const store = useAiConversationStore();
    store.replaceMessages([createImageMessage(1)]);
    for (let index = 2; index <= AI_CONVERSATION_HISTORY_LIMIT + 2; index += 1) {
      store.startNewThread();
      store.replaceMessages([createImageMessage(index)]);
    }
    const retainedPreviewSources = store.historyThreads.flatMap((thread) =>
      thread.messages.flatMap((message) =>
        message.references
          .map((reference) => reference.attachmentPreview?.src ?? null)
          .filter((src): src is string => src !== null),
      ),
    );
    expect(store.historyThreads).toHaveLength(AI_CONVERSATION_HISTORY_LIMIT);
    expect(retainedPreviewSources).toHaveLength(AI_CONVERSATION_HISTORY_LIMIT * 2);
    expect(retainedPreviewSources).not.toContain('data:image/png;base64,thread-1-image-1');
    expect(retainedPreviewSources).not.toContain('data:image/png;base64,thread-2-image-2');
    expect(retainedPreviewSources).toContain('data:image/png;base64,thread-3-image-1');
    expect(retainedPreviewSources).toContain(
      `data:image/png;base64,thread-${AI_CONVERSATION_HISTORY_LIMIT + 2}-image-2`,
    );
  });

  it('当前空白新会话不占用历史会话名额', () => {
    const store = useAiConversationStore();
    store.replaceMessages([createMessage(1)]);
    for (let index = 2; index <= AI_CONVERSATION_HISTORY_LIMIT; index += 1) {
      store.startNewThread();
      store.replaceMessages([createMessage(index)]);
    }
    store.startNewThread();
    expect(store.historyThreads).toHaveLength(AI_CONVERSATION_HISTORY_LIMIT);
    expect(store.activeMessages).toHaveLength(0);
    expect(store.historyThreads[0]?.messages[0]?.id).toBe('message-1');
    expect(store.historyThreads.at(-1)?.messages[0]?.id).toBe(
      `message-${AI_CONVERSATION_HISTORY_LIMIT}`,
    );
  });

  it('清空当前对话时只删除当前会话', () => {
    const store = useAiConversationStore();
    store.replaceMessages([createMessage(1)]);
    store.startNewThread();
    store.replaceMessages([createMessage(2)]);
    store.clearActiveThread();
    expect(store.historyThreads).toHaveLength(1);
    expect(store.historyThreads[0]?.messages[0]?.id).toBe('message-1');
    expect(store.activeMessages).toHaveLength(0);
  });

  it('删除指定历史会话时不会影响当前会话', () => {
    const store = useAiConversationStore();
    store.replaceMessages([createMessage(1)]);
    const firstThreadId = store.activeThreadId;
    store.startNewThread();
    store.replaceMessages([createMessage(2)]);
    const deleted = store.deleteThread(firstThreadId ?? '');
    expect(deleted).toBe(true);
    expect(store.activeMessages[0]?.id).toBe('message-2');
    expect(store.historyThreads).toHaveLength(1);
    expect(store.historyThreads[0]?.messages[0]?.id).toBe('message-2');
  });

  it('删除当前历史会话后切到剩余最近会话', () => {
    const store = useAiConversationStore();
    store.replaceMessages([createMessage(1)]);
    const firstThreadId = store.activeThreadId;
    store.startNewThread();
    store.replaceMessages([createMessage(2)]);
    const deleted = store.deleteThread(store.activeThreadId ?? '');
    expect(deleted).toBe(true);
    expect(store.activeThreadId).toBe(firstThreadId);
    expect(store.activeMessages[0]?.id).toBe('message-1');
    expect(store.historyThreads).toHaveLength(1);
  });

  it('按会话保存滚动高度状态', async () => {
    vi.useFakeTimers();
    try {
      const store = useAiConversationStore();
      store.replaceMessages([createMessage(1)]);
      const threadId = store.activeThreadId;
      store.updateThreadScrollState(threadId ?? '', {
        scrollTop: 320,
        scrollHeight: 1280,
        clientHeight: 640,
        distanceFromBottom: 320,
        updatedAt: '2026-05-10T12:00:00.000Z',
      });
      await vi.advanceTimersByTimeAsync(120);
      expect(store.activeThread?.scrollState).toEqual({
        scrollTop: 320,
        scrollHeight: 1280,
        clientHeight: 640,
        distanceFromBottom: 320,
        updatedAt: '2026-05-10T12:00:00.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('用用户第一条消息作为临时标题', () => {
    const store = useAiConversationStore();
    store.replaceMessages([
      {
        ...createMessage(1),
        content: ' 修复 AI 会话记录弹窗的滚动和布局 ',
      },
      {
        ...createMessage(2),
        content: '我来检查弹窗布局。',
      },
      {
        ...createMessage(3),
        content: '后续追问不应影响标题',
      },
    ]);
    expect(store.activeThread?.title).toBe('修复 AI 会话记录弹窗的滚动和布局');
    expect(store.activeThread?.titleStatus).toBe('temporary');
  });

  it('正式标题生成后不会被后续消息覆盖', () => {
    const store = useAiConversationStore();
    store.replaceMessages([createMessage(1), createMessage(2)]);
    const threadId = store.activeThreadId;
    expect(threadId).toBeTruthy();
    store.completeThreadTitleGeneration(threadId ?? '', '弹窗滚动修复');
    store.replaceMessages([...store.activeMessages, createMessage(3)]);
    expect(store.activeThread?.title).toBe('弹窗滚动修复');
    expect(store.activeThread?.titleStatus).toBe('generated');
  });

  it('按线程回写消息时同步标题与更新时间', () => {
    const store = useAiConversationStore();
    store.replaceMessages([createMessage(1)]);
    const firstThreadId = store.activeThreadId;
    store.startNewThread();
    const nextMessage = {
      ...createMessage(2),
      role: 'user' as const,
      content: '切换后回写原会话',
    };
    store.replaceThreadMessages(firstThreadId ?? '', [nextMessage]);
    const firstThread = store.threads.find((thread) => thread.id === firstThreadId);
    expect(firstThread?.title).toBe('切换后回写原会话');
    expect(firstThread?.updatedAt).toBe(nextMessage.createdAt);
    expect(store.activeMessages).toHaveLength(0);
  });

  it('只提取第一轮问答用于后台标题生成', () => {
    const store = useAiConversationStore();
    store.replaceMessages([
      {
        ...createMessage(1),
        role: 'user',
        content: '第一句用户问题',
      },
      {
        ...createMessage(2),
        role: 'assistant',
        content: '第一句 AI 回答',
      },
      {
        ...createMessage(3),
        role: 'user',
        content: '第二轮用户追问',
      },
      {
        ...createMessage(4),
        role: 'assistant',
        content: '第二轮 AI 回答',
      },
    ]);
    const firstRound = store.getFirstRoundForTitle(store.activeThreadId ?? '');
    expect(firstRound).toEqual({
      userMessage: '第一句用户问题',
      assistantMessage: '第一句 AI 回答',
    });
  });
});

describe('normalizeHydratedMessage', () => {
  it('把流式中断的消息收尾为 cancelled 并标记 interrupted', () => {
    const result = normalizeHydratedMessage({
      id: 'm-streaming',
      role: 'assistant',
      content: '部分回答',
      createdAt: '2026-06-06T00:00:00.000Z',
      references: [],
      stream: { status: 'streaming' },
    });
    expect(result.stream?.status).toBe('cancelled');
    expect(result.stream?.interrupted).toBe(true);
  });

  it('对非流式消息原样返回且不打 interrupted 标记', () => {
    const message: IAiChatMessage = {
      id: 'm-completed',
      role: 'assistant',
      content: '完整回答',
      createdAt: '2026-06-06T00:00:00.000Z',
      references: [],
      stream: { status: 'completed' },
    };
    expect(normalizeHydratedMessage(message)).toBe(message);
    expect(message.stream?.interrupted).toBeUndefined();
  });

  it('对无 stream 的消息原样返回', () => {
    const message = createMessage(1);
    expect(normalizeHydratedMessage(message)).toBe(message);
  });
});
