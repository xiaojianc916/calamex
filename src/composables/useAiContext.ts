import { computed, type Ref } from 'vue';
import { buildCurrentFileReference } from '@/services/modules/ai-context';
import type { IAiContextReference } from '@/types/ai';
import type { IEditorDocument } from '@/types/editor';

export const useAiContext = (document: Ref<IEditorDocument>) => {
  const currentFileReference = computed<IAiContextReference | null>(() =>
    buildCurrentFileReference(document.value),
  );

  const defaultReferences = computed(() =>
    currentFileReference.value ? [currentFileReference.value] : [],
  );

  return {
    currentFileReference,
    defaultReferences,
  };
};
