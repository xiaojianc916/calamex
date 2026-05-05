<script setup lang="ts">
import { CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { BrainIcon, ChevronDownIcon } from 'lucide-vue-next';
import { computed, type HTMLAttributes } from 'vue';
import { useReasoningContext } from './context';

const props = withDefaults(defineProps<{
  class?: HTMLAttributes['class'];
}>(), {
  class: undefined,
});

const { isStreaming, isOpen, duration } = useReasoningContext();

const thinkingMessage = computed(() => {
  if (isStreaming.value || duration.value === 0) {
    return 'thinking';
  }

  if (duration.value === undefined) {
    return 'default_done';
  }

  return 'duration_done';
});
</script>

<template>
  <CollapsibleTrigger
    :class="
      cn(
        'flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground',
        props.class,
      )
    "
    v-bind="$attrs"
  >
    <slot>
      <BrainIcon class="size-4" aria-hidden="true" />

      <span v-if="thinkingMessage === 'thinking'" class="reasoning-trigger-shimmer">
        Thinking...
      </span>
      <p v-else-if="thinkingMessage === 'default_done'">Thought for a few seconds</p>
      <p v-else>Thought for {{ duration }} seconds</p>

      <ChevronDownIcon
        :class="cn('size-4 transition-transform', isOpen ? 'rotate-180' : 'rotate-0')"
        aria-hidden="true"
      />
    </slot>
  </CollapsibleTrigger>
</template>

<style scoped>
.reasoning-trigger-shimmer {
  display: inline-block;
  background:
    linear-gradient(
      90deg,
      transparent 0%,
      color-mix(in srgb, var(--text-primary) 86%, transparent) 50%,
      transparent 100%
    ),
    color-mix(in srgb, var(--text-quaternary) 88%, transparent);
  background-clip: text;
  background-size: 220% 100%;
  color: transparent;
  animation: reasoning-trigger-shimmer 1s linear infinite;
}

@keyframes reasoning-trigger-shimmer {
  from {
    background-position: 100% 0;
  }

  to {
    background-position: -120% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .reasoning-trigger-shimmer {
    animation: none;
    color: var(--text-tertiary);
  }
}
</style>
