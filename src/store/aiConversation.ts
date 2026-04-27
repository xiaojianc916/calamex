import type { IAiChatMessage } from '@/types/ai';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

export interface IAiThreadSummary {
  id: string;
  title: string;
  updatedAt: string;
}

const createThreadId = (): string => `ai-thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const useAiConversationStore = defineStore('ai-conversation', () => {
  const activeThreadId = ref<string | null>(createThreadId());
  const threads = ref<IAiThreadSummary[]>([]);
  const activeMessages = ref<IAiChatMessage[]>([]);

  const hasMessages = computed(() => activeMessages.value.length > 0);

  const appendMessage = (message: IAiChatMessage): void => {
    activeMessages.value = [...activeMessages.value, message];
  };

  const replaceMessages = (messages: IAiChatMessage[]): void => {
    activeMessages.value = messages;
  };

  const clearActiveThread = (): void => {
    activeThreadId.value = createThreadId();
    activeMessages.value = [];
  };

  return {
    activeThreadId,
    threads,
    activeMessages,
    hasMessages,
    appendMessage,
    replaceMessages,
    clearActiveThread,
  };
});
