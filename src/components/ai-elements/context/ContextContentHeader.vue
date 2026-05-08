<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { computed } from 'vue';
import { useContextValue } from './context';

const props = defineProps<{
  class?: HTMLAttributes['class'];
}>();

const PERCENT_MAX = 100;

const { usedTokens, maxTokens } = useContextValue();

const compactFormatter = new Intl.NumberFormat('zh-CN', { notation: 'compact' });

const usedPercent = computed(() => {
  if (maxTokens.value <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(1, usedTokens.value / maxTokens.value));
});

const displayPercent = computed(() =>
  new Intl.NumberFormat('zh-CN', {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(usedPercent.value),
);

const used = computed(() => compactFormatter.format(usedTokens.value));
const total = computed(() => (maxTokens.value > 0 ? compactFormatter.format(maxTokens.value) : '未知'));
</script>

<template>
  <div :class="cn('w-full space-y-2 p-3', props.class)">
    <slot v-if="$slots.default" />

    <template v-else>
      <div class="flex items-center justify-between gap-3 text-xs">
        <p>{{ displayPercent }}</p>
        <p class="font-mono text-[var(--text-secondary)]">
          {{ used }} / {{ total }}
        </p>
      </div>
      <Progress class="bg-[var(--border-subtle)]" :model-value="usedPercent * PERCENT_MAX" />
    </template>
  </div>
</template>
