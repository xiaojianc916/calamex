<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { computed } from 'vue';
import { cn } from '@/lib/utils';
import { useContextValue } from './context';

const props = defineProps<{
  class?: HTMLAttributes['class'];
}>();

const { cost, usageSource } = useContextValue();
const costLabel = computed(() => (usageSource.value === 'official' ? 'usage 成本' : '预计成本'));

const totalCost = computed(() => cost.value?.totalCostText ?? '');
</script>

<template>
  <div :class="cn('flex w-full items-center justify-between gap-3 bg-[var(--surface-soft)] p-3 text-xs', props.class)">
    <slot v-if="$slots.default" />

    <template v-else>
      <span class="text-[var(--text-secondary)]">{{ costLabel }}</span>
      <span class="text-[#09090b]">{{ totalCost }}</span>
    </template>
  </div>
</template>
