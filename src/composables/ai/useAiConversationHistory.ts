import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { formatHistoryTimestamp } from '@/components/business/ai/shell/history-format';
import type { useAiAssistant } from '@/composables/ai/useAiAssistant';
import type { IAiChatMessage } from '@/types/ai';

type AiAssistantApi = ReturnType<typeof useAiAssistant>;

const MAX_HISTORY_THREADS = 20;

/**
 * 从 AiAssistantPanel 抽出的会话历史浮层逻辑：历史列表、新建/切换/删除对话，
 * 以及点击浮层外部自动关闭的交互。
 */
export const useAiConversationHistory = (assistant: AiAssistantApi) => {
  const isHistoryOpen = ref(false);
  const pendingDeleteThreadId = ref<string | null>(null);
  const historyAnchorRef = ref<HTMLElement | null>(null);
  const historyPopoverRef = ref<HTMLElement | null>(null);

  const historyThreads = computed(() =>
    [...assistant.historyThreads.value]
      .sort((first, second) => Date.parse(second.updatedAt) - Date.parse(first.updatedAt))
      .slice(0, MAX_HISTORY_THREADS),
  );
  const activeHistoryThread = computed(
    () =>
      assistant.historyThreads.value.find(
        (thread) => thread.id === assistant.activeConversationId.value,
      ) ?? null,
  );
  const pendingDeleteThread = computed(
    () =>
      assistant.historyThreads.value.find((thread) => thread.id === pendingDeleteThreadId.value) ??
      null,
  );

  const getHistoryMessageCountLabel = (messages: IAiChatMessage[]): string =>
    `${messages.length} 条消息`;

  const deleteDialogTitle = computed<string>(() => {
    const thread = pendingDeleteThread.value;

    if (!thread) {
      return '删除对话记录？';
    }

    return `删除“${thread.title}”？`;
  });

  const deleteDialogDescription = computed<string>(() => {
    const thread = pendingDeleteThread.value;
    const messageCountLabel = thread ? getHistoryMessageCountLabel(thread.messages) : '这条记录';

    return `只会删除这条对话记录（${messageCountLabel}），不会删除文件或其他对话。`;
  });

  const isHistoryEventInside = (eventTarget: EventTarget | null): boolean => {
    const targetNode = eventTarget instanceof Node ? eventTarget : null;

    if (!targetNode) {
      return false;
    }

    return Boolean(
      historyAnchorRef.value?.contains(targetNode) || historyPopoverRef.value?.contains(targetNode),
    );
  };

  const handleHistoryPointerDown = (event: PointerEvent): void => {
    if (!isHistoryOpen.value || assistant.isClearDialogOpen.value) {
      return;
    }

    if (isHistoryEventInside(event.target)) {
      return;
    }

    isHistoryOpen.value = false;
  };

  const toggleHistoryPopover = (): void => {
    isHistoryOpen.value = !isHistoryOpen.value;
  };

  const closeHistory = (): void => {
    isHistoryOpen.value = false;
  };

  const startNewConversation = (): void => {
    if (assistant.isSending.value) {
      assistant.stopCurrentRequest();
    }

    isHistoryOpen.value = false;
    assistant.startNewConversation();
  };

  const openHistoryThread = (threadId: string): void => {
    if (assistant.isSending.value) {
      assistant.stopCurrentRequest();
    }

    assistant.switchConversation(threadId);
    isHistoryOpen.value = false;
  };

  const openDeleteConversationDialog = (threadId: string): void => {
    pendingDeleteThreadId.value = threadId;
    assistant.isClearDialogOpen.value = true;
  };

  const cancelClearConversation = (): void => {
    pendingDeleteThreadId.value = null;
    assistant.isClearDialogOpen.value = false;
  };

  const confirmClearConversation = (): void => {
    const threadId = pendingDeleteThreadId.value;
    pendingDeleteThreadId.value = null;
    assistant.isClearDialogOpen.value = false;

    if (!threadId) {
      return;
    }

    if (assistant.isSending.value && threadId === assistant.activeConversationId.value) {
      assistant.stopCurrentRequest();
    }

    assistant.deleteConversation(threadId);
  };

  onMounted(() => {
    document.addEventListener('pointerdown', handleHistoryPointerDown);
  });

  onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', handleHistoryPointerDown);
  });

  return {
    isHistoryOpen,
    historyAnchorRef,
    historyPopoverRef,
    historyThreads,
    activeHistoryThread,
    pendingDeleteThread,
    getHistoryMessageCountLabel,
    getHistoryTimestampLabel: formatHistoryTimestamp,
    deleteDialogTitle,
    deleteDialogDescription,
    toggleHistoryPopover,
    closeHistory,
    startNewConversation,
    openHistoryThread,
    openDeleteConversationDialog,
    cancelClearConversation,
    confirmClearConversation,
  };
};
