<script setup lang="ts">
import type { LanguageModelUsage } from 'ai';
import { HoverCard } from '@/components/ui/hover-card';
import { computed, provide } from 'vue';
import { ContextKey, type TContextModelId } from './context';

defineOptions({
  inheritAttrs: false,
});

const props = defineProps<{
  usedTokens: number;
  maxTokens: number;
  usage?: LanguageModelUsage;
  modelId?: TContextModelId;
}>();

provide(ContextKey, {
  usedTokens: computed(() => props.usedTokens),
  maxTokens: computed(() => props.maxTokens),
  usage: computed(() => props.usage),
  modelId: computed(() => props.modelId),
});
</script>

<template>
  <HoverCard :close-delay="0" :open-delay="0" v-bind="$attrs">
    <slot />
  </HoverCard>
</template>
