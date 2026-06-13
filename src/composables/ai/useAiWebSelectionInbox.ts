import { ref } from 'vue';

/**
 * Structured context captured when the user picks an element inside the built-in
 * browser preview (CSS selector label, source URL, outer HTML, and an optional
 * comment).
 */
export interface IAiWebSelectionContext {
  url: string;
  label: string;
  outerHtml: string;
  comment: string;
}

// Module-level singleton so the web preview sidebar (producer) and the AI
// assistant composable (consumer) share one channel without prop drilling
// through the workspace surface.
const pendingSelection = ref<IAiWebSelectionContext | null>(null);

export const useAiWebSelectionInbox = () => {
  const submitSelection = (selection: IAiWebSelectionContext): void => {
    pendingSelection.value = selection;
  };

  const consumeSelection = (): void => {
    pendingSelection.value = null;
  };

  return {
    pendingSelection,
    submitSelection,
    consumeSelection,
  };
};
