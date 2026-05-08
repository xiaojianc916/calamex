<script setup lang="ts">
import { Button } from '@/components/ui/button';
import { HoverCardTrigger } from '@/components/ui/hover-card';
import { computed } from 'vue';
import { useContextValue } from './context';
import ContextIcon from './ContextIcon.vue';

const { usedTokens, maxTokens } = useContextValue();

const renderedPercent = computed(() => {
  if (maxTokens.value <= 0) {
    return '0%';
  }

  return new Intl.NumberFormat('zh-CN', {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(usedTokens.value / maxTokens.value);
});
</script>

<template>
  <HoverCardTrigger as-child>
    <slot v-if="$slots.default" />

    <Button v-else type="button" variant="ghost" v-bind="$attrs">
      <span class="font-medium text-[var(--text-secondary)]">
        {{ renderedPercent }}
      </span>
      <ContextIcon />
    </Button>
  </HoverCardTrigger>
</template>
