<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { computed } from 'vue';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { useContextValue } from './context';
import { formatTokensInK } from './token-format';

const props = defineProps<{
  class?: HTMLAttributes['class'];
}>();

const PERCENT_MAX = 100;

const { usedTokens, maxTokens } = useContextValue();

const hasKnownLimit = computed(() => maxTokens.value > 0);

const usedPercent = computed(() => {
  // 上限未知（undefined / NaN / <=0）时一律按 0 处理，避免渲染出 NaN% 这类脏值。
  if (!hasKnownLimit.value) {
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

const used = computed(() => formatTokensInK(usedTokens.value));
const total = computed(() => (hasKnownLimit.value ? formatTokensInK(maxTokens.value) : '未知'));
</script>

<template>
  <div :class="cn('w-full space-y-2 p-3', props.class)">
    <slot v-if="$slots.default" />

    <template v-else>
      <div class="flex items-center justify-between gap-3 text-xs">
        <p class="text-[#09090b]"> {{displayPercent}} </p>
        <p class="font-mono text-[var(--text-secondary)]">
           {{used}}  /  {{total}} 
        </p>
      </div>
      <Progress class="context-token-progress" :model-value="usedPercent * PERCENT_MAX" />
    </template>
  </div>
</template>

<style scoped>
.context-token-progress[data-slot='progress'] {
  background: #f4f4f5;
}

.context-token-progress :deep([data-slot='progress-indicator']) {
  background: #18181b;
}
</style>
