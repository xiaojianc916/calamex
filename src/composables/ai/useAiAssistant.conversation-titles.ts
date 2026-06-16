import { getCurrentScope, onScopeDispose } from 'vue';
import { aiService } from '@/services/ipc/ai.service';
import type { useAiConversationStore } from '@/store/aiConversation';
import { logger } from '@/utils/platform/logger';

const CONVERSATION_TITLE_RETRY_DELAYS_MS = [1500, 3000, 5000, 9000, 16000, 30000, 60000] as const;

type IAiConversationStore = ReturnType<typeof useAiConversationStore>;

export interface IUseAiConversationTitlesDeps {
  conversationStore: IAiConversationStore;
}

/**
 * 会话标题的后台生成与失败重试。
 *
 * 仅依赖会话 store 与 AI service，不触碰消息流 / patch / sidecar 等状态，
 * 因此从 useAiAssistant 主闭包中拆出，便于独立测试与维护。
 */
export const useAiConversationTitles = (deps: IUseAiConversationTitlesDeps) => {
  const { conversationStore } = deps;

  const pendingTitleThreadIds = new Set<string>();
  const pendingTitleRetryTimers = new Map<string, ReturnType<typeof window.setTimeout>>();
  const titleRetryAttemptByThreadId = new Map<string, number>();

  const clearConversationTitleRetryTimer = (threadId: string): void => {
    const timerId = pendingTitleRetryTimers.get(threadId);

    if (timerId === undefined || typeof window === 'undefined') {
      pendingTitleRetryTimers.delete(threadId);
      return;
    }

    window.clearTimeout(timerId);
    pendingTitleRetryTimers.delete(threadId);
  };

  const maybeGenerateConversationTitle = async (threadId: string | null): Promise<void> => {
    if (!threadId || pendingTitleThreadIds.has(threadId)) {
      return;
    }

    const titleStatus = conversationStore.getThreadTitleStatus(threadId);
    const retryAttempt = titleRetryAttemptByThreadId.get(threadId) ?? 0;
    const canRetryFailedTitle =
      retryAttempt > 0 && retryAttempt <= CONVERSATION_TITLE_RETRY_DELAYS_MS.length;

    if (titleStatus !== 'temporary' && !canRetryFailedTitle) {
      return;
    }

    const firstRound = conversationStore.getFirstRoundForTitle(threadId);

    if (!firstRound) {
      return;
    }

    pendingTitleThreadIds.add(threadId);
    clearConversationTitleRetryTimer(threadId);
    conversationStore.markThreadTitleGenerating(threadId);

    try {
      const payload = await aiService.generateConversationTitle(firstRound);
      conversationStore.completeThreadTitleGeneration(threadId, payload.title);
      clearConversationTitleRetryTimer(threadId);
      titleRetryAttemptByThreadId.delete(threadId);
    } catch (error) {
      conversationStore.failThreadTitleGeneration(threadId);
      const nextRetryAttempt = (titleRetryAttemptByThreadId.get(threadId) ?? 0) + 1;
      titleRetryAttemptByThreadId.set(threadId, nextRetryAttempt);
      const retryDelay = CONVERSATION_TITLE_RETRY_DELAYS_MS[nextRetryAttempt - 1];
      const hasScope = typeof window !== 'undefined';

      if (hasScope && retryDelay !== undefined) {
        const retryTimer = window.setTimeout(() => {
          pendingTitleRetryTimers.delete(threadId);
          void maybeGenerateConversationTitle(threadId);
        }, retryDelay);
        pendingTitleRetryTimers.set(threadId, retryTimer);
      } else if (retryDelay === undefined) {
        titleRetryAttemptByThreadId.delete(threadId);
      }

      logger.warn({
        event: 'ai.conversation_title.failed',
        err: error,
        threadId,
        retryDelay,
        retryAttempt: nextRetryAttempt,
      });
    } finally {
      pendingTitleThreadIds.delete(threadId);
    }
  };

  if (getCurrentScope()) {
    onScopeDispose(() => {
      pendingTitleRetryTimers.forEach((timerId) => {
        window.clearTimeout(timerId);
      });
      pendingTitleRetryTimers.clear();
      titleRetryAttemptByThreadId.clear();
    });
  }

  return {
    maybeGenerateConversationTitle,
  };
};
