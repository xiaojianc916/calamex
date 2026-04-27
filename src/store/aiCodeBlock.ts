import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useAiCodeBlockStore = defineStore('aiCodeBlock', () => {
  const foldedBlockIds = ref<Set<string>>(new Set());
  const wrappedBlockIds = ref<Set<string>>(new Set());
  const recentlyCopiedId = ref<string | null>(null);
  const lineNumberMode = ref<'auto' | 'always' | 'never'>('auto');

  const toggleFold = (id: string): void => {
    const next = new Set(foldedBlockIds.value);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    foldedBlockIds.value = next;
  };

  const toggleWrap = (id: string): void => {
    const next = new Set(wrappedBlockIds.value);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    wrappedBlockIds.value = next;
  };

  const markCopied = (id: string): void => {
    recentlyCopiedId.value = id;
    window.setTimeout(() => {
      if (recentlyCopiedId.value === id) {
        recentlyCopiedId.value = null;
      }
    }, 1400);
  };

  return {
    foldedBlockIds,
    wrappedBlockIds,
    recentlyCopiedId,
    lineNumberMode,
    toggleFold,
    toggleWrap,
    markCopied,
  };
});
