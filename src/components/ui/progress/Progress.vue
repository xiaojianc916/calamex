<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { computed } from 'vue';
import { ProgressIndicator, ProgressRoot, type ProgressRootProps } from 'reka-ui';
import { cn } from '@/lib/utils';

const props = withDefaults(
  defineProps<ProgressRootProps & {
    class?: HTMLAttributes['class'];
  }>(),
  {
    class: undefined,
    modelValue: 0,
  },
);

const indicatorStyle = computed(() => {
  const value = props.modelValue ?? 0;
  const offset = 100 - Math.max(0, Math.min(100, value));

  return {
    transform: `translateX(-${offset}%)`,
  };
});
</script>

<template>
  <ProgressRoot
    data-slot="progress"
    :class="cn('relative h-2 w-full overflow-hidden rounded-full bg-[var(--muted)]', props.class)"
    v-bind="$attrs"
    :model-value="props.modelValue"
  >
    <ProgressIndicator
      data-slot="progress-indicator"
      class="h-full w-full flex-1 bg-[var(--foreground)] transition-transform"
      :style="indicatorStyle"
    />
  </ProgressRoot>
</template>
