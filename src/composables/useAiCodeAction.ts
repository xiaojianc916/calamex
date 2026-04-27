import { ref } from 'vue';
import { aiService } from '@/services/modules/ai';
import type { IAiCodeActionRequest, IAiCodeActionResult } from '@/types/ai';

export type TAiCodeActionKind = IAiCodeActionRequest['kind'];

export const useAiCodeAction = () => {
  const result = ref<IAiCodeActionResult | null>(null);
  const isLoading = ref(false);

  const runCodeAction = async (payload: IAiCodeActionRequest): Promise<IAiCodeActionResult> => {
    isLoading.value = true;
    try {
      const nextResult = await aiService.codeAction(payload);
      result.value = nextResult;
      return nextResult;
    } finally {
      isLoading.value = false;
    }
  };

  const runSelectionAction = async (
    kind: TAiCodeActionKind,
    selection: string,
    options: { filePath?: string | null; language?: string; diagnostics?: string[] } = {},
  ): Promise<IAiCodeActionResult> =>
    runCodeAction({
      kind,
      filePath: options.filePath ?? null,
      language: options.language ?? 'text',
      selection,
      diagnostics: options.diagnostics ?? [],
    });

  return { result, isLoading, runCodeAction, runSelectionAction };
};