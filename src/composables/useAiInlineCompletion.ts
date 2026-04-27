import { ref } from 'vue';
import { aiService } from '@/services/modules/ai';
import type { IAiInlineCompletionRequest, IAiInlineCompletionResult } from '@/types/ai';

export const useAiInlineCompletion = () => {
  const result = ref<IAiInlineCompletionResult | null>(null);
  const isLoading = ref(false);
  let requestId = 0;

  const requestCompletion = async (payload: IAiInlineCompletionRequest): Promise<IAiInlineCompletionResult | null> => {
    requestId += 1;
    const currentRequestId = requestId;
    isLoading.value = true;
    try {
      const next = await aiService.inlineComplete(payload);
      if (currentRequestId !== requestId) return result.value;
      result.value = next.insertText ? next : null;
      return result.value;
    } finally {
      if (currentRequestId === requestId) isLoading.value = false;
    }
  };

  const cancel = (): void => {
    requestId += 1;
    isLoading.value = false;
    result.value = null;
  };

  return { result, isLoading, requestCompletion, cancel };
};
