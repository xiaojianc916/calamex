import { computed } from 'vue';

import { formatHistoryClockTime } from '@/components/business/ai/shell/history-format';
import type { IAiConversationCheckpoint, useAiAssistant } from '@/composables/ai/useAiAssistant';

type AiAssistantApi = ReturnType<typeof useAiAssistant>;

/**
 * 从 AiAssistantPanel 抽出的会话检查点逻辑：按消息 ID 索引检查点，并提供恢复动作。
 */
export const useAiConversationCheckpoints = (assistant: AiAssistantApi) => {
  const conversationCheckpointByMessageId = computed<Record<string, IAiConversationCheckpoint>>(
    () => {
      const checkpointMap: Record<string, IAiConversationCheckpoint> = {};

      assistant.conversationCheckpoints.value.forEach((checkpoint) => {
        checkpointMap[checkpoint.messageId] = checkpoint;
      });

      return checkpointMap;
    },
  );

  const isCheckpointRestorePending = computed(() => assistant.restoringCheckpointId.value !== null);
  const isConversationCheckpointDisabled = computed(
    () => assistant.isSending.value || isCheckpointRestorePending.value,
  );

  const getConversationCheckpoint = (messageId: string): IAiConversationCheckpoint | null =>
    conversationCheckpointByMessageId.value[messageId] ?? null;

  const isConversationCheckpointRestoring = (messageId: string): boolean => {
    const checkpoint = getConversationCheckpoint(messageId);

    return checkpoint !== null && assistant.restoringCheckpointId.value === checkpoint.id;
  };

  const getConversationCheckpointLabel = (messageId: string): string => {
    const checkpoint = getConversationCheckpoint(messageId);

    if (!checkpoint) {
      return '';
    }

    if (assistant.restoringCheckpointId.value === checkpoint.id) {
      return '正在恢复检查点';
    }

    return `恢复到 ${formatHistoryClockTime(checkpoint.createdAt)} 检查点`;
  };

  const handleRestoreConversationCheckpoint = async (messageId: string): Promise<void> => {
    const checkpoint = getConversationCheckpoint(messageId);

    if (!checkpoint || isConversationCheckpointDisabled.value) {
      return;
    }

    await assistant.restoreConversationCheckpoint(checkpoint.id);
  };

  return {
    isConversationCheckpointDisabled,
    getConversationCheckpoint,
    isConversationCheckpointRestoring,
    getConversationCheckpointLabel,
    handleRestoreConversationCheckpoint,
  };
};
