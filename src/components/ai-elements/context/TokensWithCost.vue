<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  tokens?: number;
  costText?: string;
}>();

const formattedTokens = computed(() => {
  if (props.tokens === undefined) {
    return '-';
  }

  return new Intl.NumberFormat('zh-CN', {
    notation: 'compact',
  }).format(props.tokens);
});
</script>

<template>
  <span>
    {{ formattedTokens }}
    <span v-if="costText" class="ml-2 text-[var(--text-secondary)]">
      · {{ costText }}
    </span>
  </span>
</template>
