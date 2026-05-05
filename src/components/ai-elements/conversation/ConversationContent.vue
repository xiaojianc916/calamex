<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { cn } from '@/lib/utils';

const props = withDefaults(defineProps<{
  class?: HTMLAttributes['class'];
}>(), {
  class: undefined,
});
</script>

<template>
  <div :class="cn('flex flex-col gap-8 p-4', props.class)">
    <slot />
  </div>
</template>
