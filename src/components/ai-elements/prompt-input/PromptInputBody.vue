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
  <div :class="cn('contents', props.class)" v-bind="$attrs">
    <slot />
  </div>
</template>
