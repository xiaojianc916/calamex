<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { cn } from '@/lib/utils';
import { getUsage } from 'tokenlens';
import { computed } from 'vue';
import { useContextValue } from './context';
import TokensWithCost from './TokensWithCost.vue';

const props = defineProps<{
  class?: HTMLAttributes['class'];
}>();

const { usage, modelId } = useContextValue();

const reasoningTokens = computed(() =>
  usage.value?.outputTokenDetails.reasoningTokens ?? usage.value?.reasoningTokens ?? 0,
);

const reasoningCostText = computed(() => {
  if (!modelId.value || reasoningTokens.value <= 0) {
    return undefined;
  }

  const reasoningCost = getUsage({
    modelId: modelId.value,
    usage: { reasoningTokens: reasoningTokens.value },
  }).costUSD?.totalUSD;

  if (typeof reasoningCost !== 'number') {
    return undefined;
  }

  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'USD',
  }).format(reasoningCost);
});
</script>

<template>
  <slot v-if="$slots.default" />

  <div
    v-else-if="reasoningTokens > 0"
    :class="cn('flex items-center justify-between text-xs', props.class)"
    v-bind="$attrs"
  >
    <span class="text-[var(--text-secondary)]">推理</span>
    <TokensWithCost :cost-text="reasoningCostText" :tokens="reasoningTokens" />
  </div>
</template>
