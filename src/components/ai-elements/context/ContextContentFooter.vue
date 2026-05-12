<script setup lang="ts">
import { cn } from '@/lib/utils';
import type { HTMLAttributes } from 'vue';
import { computed } from 'vue';
import { useContextValue } from './context';
import { computeDeepSeekCostBreakdown, formatCnyCost } from './deepseek-pricing';

const props = defineProps<{
  class?: HTMLAttributes['class'];
}>();

const { modelId, usage } = useContextValue();

const totalCost = computed(() => {
  const pricing = computeDeepSeekCostBreakdown(modelId.value, usage.value);

  if (!pricing) {
    return '暂无价格';
  }

  return formatCnyCost(pricing.totalCostCny);
});
</script>

<template>
  <div :class="cn('flex w-full items-center justify-between gap-3 bg-[var(--surface-soft)] p-3 text-xs', props.class)">
    <slot v-if="$slots.default" />

    <template v-else>
      <span class="text-[var(--text-secondary)]">预计成本</span>
      <span class="text-[#09090b]">{{ totalCost }}</span>
    </template>
  </div>
</template>
