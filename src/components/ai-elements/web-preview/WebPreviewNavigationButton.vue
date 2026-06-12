<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { cn } from '@/lib/utils';

const props = withDefaults(
  defineProps<{
    tooltip?: string;
    disabled?: boolean;
    class?: HTMLAttributes['class'];
  }>(),
  {
    tooltip: undefined,
    disabled: false,
    class: undefined,
  },
);
</script>

<template>
  <button
    type="button"
    :title="props.tooltip"
    :aria-label="props.tooltip"
    :disabled="props.disabled"
    :class="cn('ai-web-preview-navigation-button', props.class)"
  >
    <slot />
  </button>
</template>

<style scoped>
.ai-web-preview-navigation-button {
  display: inline-flex;
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-tertiary);
  transition:
    color 120ms ease,
    background-color 120ms ease,
    border-radius 120ms ease;
}

.ai-web-preview-navigation-button:hover:not(:disabled) {
  border: 0;
  border-radius: 6px;
  background: #f4f4f5;
  color: var(--text-primary);
}

.ai-web-preview-navigation-button:disabled {
  cursor: default;
  opacity: 0.45;
}

.ai-web-preview-navigation-button :deep(svg) {
  width: 16px;
  height: 16px;
  stroke-width: 1.8;
}
</style>
