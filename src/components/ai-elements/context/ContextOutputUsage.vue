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

const { usage, usageSource, modelId } = useContextValue();

const pricing = computed(() => computeDeepSeekCostBreakdown(modelId.value, usage.value));
const outputTokens = computed(() => pricing.value?.usage.outputTokens ?? usage.value?.outputTokens ?? 0);
const outputLabel = computed(() => (usageSource.value === 'official' ? '官方输出' : '估算输出'));

const outputCostText = computed(() => {
  if (!pricing.value) {
    return undefined;
  }

  return formatCnyCost(pricing.value.outputCostCny);
});
</script>

<template>
  <slot v-if="$slots.default" />

  <div :class="cn('flex items-center justify-between text-xs', props.class)" v-bind="$attrs">
    <span class="text-[var(--text-secondary)]">{{ outputLabel }}</span>
    <TokensWithCost :cost-text="outputCostText" :tokens="outputTokens" />
  </div>
</template>
