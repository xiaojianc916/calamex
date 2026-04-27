<script setup lang="ts">
import type { IAiContextReference } from '@/types/ai';

defineProps<{
  references: IAiContextReference[];
}>();
</script>

<template>
  <div v-if="references.length" class="ai-context-chips" aria-label="AI 上下文引用">
    <span v-for="reference in references" :key="reference.id" class="ai-context-chip">
      @{{ reference.kind }} · {{ reference.label }}
    </span>
  </div>
</template>

<style scoped>
.ai-context-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 12px 0;
}

.ai-context-chip {
  max-width: 100%;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 88%, transparent);
  border-radius: 999px;
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 20px;
  padding: 0 8px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
