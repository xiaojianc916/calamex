<script setup lang="ts">
import { cn } from '@/lib/utils';
import type { HTMLAttributes } from 'vue';

const props = withDefaults(defineProps<{
  class?: HTMLAttributes['class'];
}>(), {
  class: undefined,
});
</script>

<template>
  <div :class="cn('text-sm text-muted-foreground', props.class)" v-bind="$attrs">
    <slot />
  </div>
</template>
