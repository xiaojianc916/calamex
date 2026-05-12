<script setup lang="ts">
import { cn } from '@/lib/utils';
import type { HTMLAttributes } from 'vue';
import { computed } from 'vue';
import { useContextValue } from './context';
import { computeDeepSeekCostBreakdown, formatCnyCost } from './deepseek-pricing';
import TokensWithCost from './TokensWithCost.vue';

const props = defineProps<{
  class?: HTMLAttributes['class'];
}>();

const { usage, modelId } = useContextValue();

const pricing = computed(() => computeDeepSeekCostBreakdown(modelId.value, usage.value));
const inputTokens = computed(() => pricing.value?.usage.inputTokens ?? usage.value?.inputTokens ?? 0);

const inputCostText = computed(() => {
  if (!pricing.value) {
    return undefined;
  }

  return formatCnyCost(pricing.value.inputCostCny);
});
</script>

<template>
  <slot v-if="$slots.default" />

  <div :class="cn('flex items-center justify-between text-xs', props.class)" v-bind="$attrs">
    <span class="text-[var(--text-secondary)]">预计输入</span>
    <TokensWithCost :cost-text="inputCostText" :tokens="inputTokens" />
  </div>
</template>
