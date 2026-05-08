<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { cn } from '@/lib/utils';
import { getUsage } from 'tokenlens';
import { computed } from 'vue';
import { useContextValue } from './context';

const props = defineProps<{
  class?: HTMLAttributes['class'];
}>();

const { modelId, usage } = useContextValue();

const totalCost = computed(() => {
  if (!modelId.value) {
    return '暂无价格';
  }

  const costUSD = getUsage({
    modelId: modelId.value,
    usage: {
      input: usage.value?.inputTokens ?? 0,
      output: usage.value?.outputTokens ?? 0,
      reasoningTokens: usage.value?.outputTokenDetails.reasoningTokens ?? usage.value?.reasoningTokens ?? 0,
      cacheReads: usage.value?.inputTokenDetails.cacheReadTokens ?? usage.value?.cachedInputTokens ?? 0,
    },
  }).costUSD?.totalUSD;

  if (typeof costUSD !== 'number') {
    return '暂无价格';
  }

  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'USD',
  }).format(costUSD);
});
</script>

<template>
  <div
    :class="cn('flex w-full items-center justify-between gap-3 bg-[var(--surface-soft)] p-3 text-xs', props.class)"
  >
    <slot v-if="$slots.default" />

    <template v-else>
      <span class="text-[var(--text-secondary)]">总费用</span>
      <span>{{ totalCost }}</span>
    </template>
  </div>
</template>
