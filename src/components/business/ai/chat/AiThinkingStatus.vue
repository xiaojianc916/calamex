<script setup lang="ts">
import { Brain } from '@lucide/vue';
import { Shimmer } from '@/components/ai-elements/shimmer';

defineProps<{
  label: string;
}>();
</script>

<template>
  <div class="ai-thinking-status" role="status" aria-live="polite">
    <Brain class="ai-thinking-status__icon" aria-hidden="true" />
    <Shimmer as="span" class="ai-thinking-status__label">
      {{ label }}
    </Shimmer>
  </div>
</template>

<style scoped>
.ai-thinking-status {
  display: inline-flex;
  min-width: 0;
  min-height: calc(var(--app-density-scale) * 1.5rem);
  align-items: center;
  gap: calc(var(--app-density-scale) * 0.5rem);
  color: var(--text-quaternary);
  font-size: calc(var(--app-ui-font-size) * 1);
  line-height: 1.55;
}

.ai-thinking-status__icon {
  width: calc(var(--app-density-scale) * 1rem);
  height: calc(var(--app-density-scale) * 1rem);
  flex: 0 0 auto;
  color: var(--text-tertiary);
  stroke-width: 1.8;
}

.ai-thinking-status__label {
  min-width: 0;
  max-width: 100%;
  line-height: inherit;
}
</style>
