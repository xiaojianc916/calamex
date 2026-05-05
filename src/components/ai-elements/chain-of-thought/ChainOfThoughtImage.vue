<script setup lang="ts">
import { cn } from '@/lib/utils';
import type { HTMLAttributes } from 'vue';

const props = withDefaults(defineProps<{
  caption?: string;
  class?: HTMLAttributes['class'];
}>(), {
  caption: undefined,
  class: undefined,
});
</script>

<template>
  <div :class="cn('mt-2 space-y-2', props.class)" v-bind="$attrs">
    <div
      class="
        relative flex max-h-[22rem] items-center justify-center overflow-hidden
        rounded-lg bg-muted p-3
      "
    >
      <slot />
    </div>
    <p v-if="props.caption" class="text-muted-foreground text-xs">
      {{ props.caption }}
    </p>
  </div>
</template>
