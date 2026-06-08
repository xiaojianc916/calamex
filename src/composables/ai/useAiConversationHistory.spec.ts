import { mount } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

import type { useAiAssistant } from '@/composables/ai/useAiAssistant';
import type { IAiChatMessage } from '@/types/ai';

import { useAiConversationHistory } from './useAiConversationHistory';

type AiAssistantApi = ReturnType<typeof useAiAssistant>;

const withSetup = <T>(factory: () => T): T => {
  let result: T | undefined;
  mount(
    defineComponent({
      setup() {
        result = factory();
        return () => null;
      },
    }),
  );

  if (result === undefined) {
    throw new Error('composable setup did not run');
  }

  return result;
};

const createThread = (id: string, updatedAt: string, messageCount: number) => ({
  id,
  title: `会话 ${id}`,
  createdAt: updatedAt,
  updatedAt,
  messages: Array.from({ length: messageCount }, () => ({}) as IAiChatMessage),
});

const createAssistantStub = () => {
  const historyThreads = ref([
    createThread('a', '2026-06-01T10:00:00.000Z', 1),
    createThread('b', '2026-06-09T10:00:00.000Z', 2),
    createThread('c', '2026-06-05T10:00:00.000Z', 3),
  ]);
  const activeConversationId = ref<string | null>('c');
  const isClearDialogOpen = ref(false);
  const isSending = ref(false);
  const stopCurrentRequest = vi.fn();
  const startNewConversation = vi.fn();
  const switchConversation = vi.fn();
  const deleteConversation = vi.fn();

  const assistant = {
    historyThreads,
    activeConversationId,
    isClearDialogOpen,
    isSending,
    stopCurrentRequest,
    startNewConversation,
    switchConversation,
    deleteConversation,
  } as unknown as AiAssistantApi;

  return {
    assistant,
    activeConversationId,
    isClearDialogOpen,
    isSending,
    stopCurrentRequest,
    startNewConversation,
    switchConversation,
    deleteConversation,
  };
};

describe('useAiConversationHistory', () => {
  it('按更新时间倒序排列历史', () => {
    const { assistant } = createAssistantStub();
    const history = withSetup(() => useAiConversationHistory(assistant));

    expect(history.historyThreads.value.map((thread) => thread.id)).toEqual(['b', 'c', 'a']);
  });

  it('识别当前会话', () => {
    const { assistant } = createAssistantStub();
    const history = withSetup(() => useAiConversationHistory(assistant));

    expect(history.activeHistoryThread.value?.id).toBe('c');
  });

  it('切换折叠状态', () => {
    const { assistant } = createAssistantStub();
    const history = withSetup(() => useAiConversationHistory(assistant));

    expect(history.isHistoryOpen.value).toBe(false);
    history.toggleHistoryPopover();
    expect(history.isHistoryOpen.value).toBe(true);
  });

  it('打开历史会话时切换并关闭浮层', () => {
    const { assistant, switchConversation, isSending, stopCurrentRequest } = createAssistantStub();
    const history = withSetup(() => useAiConversationHistory(assistant));
    isSending.value = true;
    history.toggleHistoryPopover();

    history.openHistoryThread('a');

    expect(stopCurrentRequest).toHaveBeenCalledTimes(1);
    expect(switchConversation).toHaveBeenCalledWith('a');
    expect(history.isHistoryOpen.value).toBe(false);
  });

  it('新建对话时关闭浮层并委托 assistant', () => {
    const { assistant, startNewConversation } = createAssistantStub();
    const history = withSetup(() => useAiConversationHistory(assistant));
    history.toggleHistoryPopover();

    history.startNewConversation();

    expect(startNewConversation).toHaveBeenCalledTimes(1);
    expect(history.isHistoryOpen.value).toBe(false);
  });

  it('删除对话弹窗流程', () => {
    const { assistant, isClearDialogOpen, deleteConversation } = createAssistantStub();
    const history = withSetup(() => useAiConversationHistory(assistant));

    history.openDeleteConversationDialog('b');
    expect(isClearDialogOpen.value).toBe(true);
    expect(history.pendingDeleteThread.value?.id).toBe('b');
    expect(history.deleteDialogTitle.value).toContain('会话 b');
    expect(history.deleteDialogDescription.value).toContain('2 条消息');

    history.confirmClearConversation();
    expect(deleteConversation).toHaveBeenCalledWith('b');
    expect(isClearDialogOpen.value).toBe(false);
  });

  it('取消删除重置状态', () => {
    const { assistant, isClearDialogOpen, deleteConversation } = createAssistantStub();
    const history = withSetup(() => useAiConversationHistory(assistant));

    history.openDeleteConversationDialog('b');
    history.cancelClearConversation();

    expect(isClearDialogOpen.value).toBe(false);
    expect(history.pendingDeleteThread.value).toBeNull();
    expect(deleteConversation).not.toHaveBeenCalled();
  });

  it('提供时间戳与消息数标签', () => {
    const { assistant } = createAssistantStub();
    const history = withSetup(() => useAiConversationHistory(assistant));

    expect(typeof history.getHistoryTimestampLabel('2026-06-09T10:00:00.000Z')).toBe('string');
    expect(history.getHistoryMessageCountLabel([{}, {}] as IAiChatMessage[])).toBe('2 条消息');
  });
});
