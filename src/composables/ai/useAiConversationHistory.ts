import { useEventListener } from '@vueuse/core';
import { computed, ref } from 'vue';

import { formatHistoryTimestamp } from '@/components/business/ai/shell/history-format';
import type { useAiAssistant } from '@/composables/ai/useAiAssistant';
import { aiService } from '@/services/ipc/ai.service';
import type { IAiThread } from '@/types/ai/thread';

type AiAssistantApi = ReturnType<typeof useAiAssistant>;

const HISTORY_PAGE_SIZE = 20;
const HISTORY_LOAD_MORE_THRESHOLD_PX = 64;

/**
 * 从 AiAssistantPanel 抽出的会话历史浮层逻辑：历史列表、新建/切换/删除对话，
 * 以及点击浮层外部自动关闭的交互。
 */
export const useAiConversationHistory = (assistant: AiAssistantApi) => {
  const isHistoryOpen = ref(false);
  const pendingDeleteThreadId = ref<string | null>(null);
  const historyAnchorRef = ref<HTMLElement | null>(null);
  const historyPopoverRef = ref<HTMLElement | null>(null);
  const visibleHistoryLimit = ref(HISTORY_PAGE_SIZE);

  const sortedHistoryThreads = computed(() =>
    [...assistant.historyThreads.value].sort(
      (first, second) => Date.parse(second.updatedAt) - Date.parse(first.updatedAt),
    ),
  );
  const historyThreads = computed(() =>
    sortedHistoryThreads.value.slice(0, visibleHistoryLimit.value),
  );
  const hasMoreHistoryThreads = computed(
    () => visibleHistoryLimit.value < sortedHistoryThreads.value.length,
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

  // entries-native 计数：统计映射为可见消息的条目（user_message / assistant_message），
  // 取代依赖 message 桥（thread.messages）的 length；其余条目（tool_call / changed_files 等）
  // 是消息的子条目，不计入「N 条消息」。
  const countThreadMessages = (thread: IAiThread): number =>
    thread.entries.reduce(
      (count, entry) =>
        entry.type === 'user_message' || entry.type === 'assistant_message' ? count + 1 : count,
      0,
    );

  const getHistoryMessageCountLabel = (thread: IAiThread): string =>
    `${countThreadMessages(thread)} 条消息`;

  const resetHistoryPagination = (): void => {
    visibleHistoryLimit.value = HISTORY_PAGE_SIZE;
  };

  const loadMoreHistoryThreads = (): void => {
    if (!hasMoreHistoryThreads.value) return;
    visibleHistoryLimit.value = Math.min(
      visibleHistoryLimit.value + HISTORY_PAGE_SIZE,
      sortedHistoryThreads.value.length,
    );
  };

  const handleHistoryScroll = (event: Event): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;

    const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (distanceFromBottom <= HISTORY_LOAD_MORE_THRESHOLD_PX) {
      loadMoreHistoryThreads();
    }
  };

  const deleteDialogTitle = computed<string>(() => {
    const thread = pendingDeleteThread.value;

    if (!thread) {
      return '删除对话记录？';
    }

    return `删除“${thread.title}”？`;
  });

  const deleteDialogDescription = computed<string>(() => {
    const thread = pendingDeleteThread.value;
    const messageCountLabel = thread ? getHistoryMessageCountLabel(thread) : '这条记录';

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
    const nextOpen = !isHistoryOpen.value;
    if (nextOpen) {
      resetHistoryPagination();
    }
    isHistoryOpen.value = nextOpen;
  };

  const closeHistory = (): void => {
    isHistoryOpen.value = false;
    resetHistoryPagination();
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
    // R3：删除对话即驱逐其后端 ACP 会话态（thread↔session / config_options / available_commands），
    // 根治这些按 thread/session 键的表随会话数单调增长的泄漏。fire-and-forget，不阻塞 UI。
    void aiService.evictThread(threadId);
  };

  useEventListener(document, 'pointerdown', handleHistoryPointerDown);

  return {
    isHistoryOpen,
    historyAnchorRef,
    historyPopoverRef,
    historyThreads,
    hasMoreHistoryThreads,
    activeHistoryThread,
    pendingDeleteThread,
    getHistoryMessageCountLabel,
    getHistoryTimestampLabel: formatHistoryTimestamp,
    deleteDialogTitle,
    deleteDialogDescription,
    toggleHistoryPopover,
    closeHistory,
    handleHistoryScroll,
    startNewConversation,
    openHistoryThread,
    openDeleteConversationDialog,
    cancelClearConversation,
    confirmClearConversation,
  };
};
