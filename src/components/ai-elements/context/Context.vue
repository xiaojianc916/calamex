<script setup lang="ts">
import { computed, provide } from 'vue';
import { HoverCard } from '@/components/ui/hover-card';
import type { TAiTokenUsageSource } from '@/composables/ai/useAiTokenContext';
import type { IAiLanguageModelUsage } from '@/types/ai';
import { ContextKey, type IContextUsageCost, type TContextModelId } from './context';

defineOptions({
  inheritAttrs: false,
});

const props = defineProps<{
  usedTokens: number;
  maxTokens: number;
  usage?: IAiLanguageModelUsage;
  usageSource?: TAiTokenUsageSource;
  modelId?: TContextModelId;
  cost?: IContextUsageCost;
}>();

provide(ContextKey, {
  usedTokens: computed(() => props.usedTokens),
  maxTokens: computed(() => props.maxTokens),
  usage: computed(() => props.usage),
  usageSource: computed(() => props.usageSource ?? 'estimated'),
  modelId: computed(() => props.modelId),
  cost: computed(() => props.cost),
});
</script>

<template>
  <HoverCard :close-delay="0" :open-delay="0" v-bind="$attrs">
    <slot />
  </HoverCard>
</template>
