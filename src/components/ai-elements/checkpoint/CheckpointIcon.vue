<script setup lang="ts">
import { Bookmark } from '@lucide/vue';
import type { HTMLAttributes } from 'vue';
import { cn } from '@/lib/utils';

const props = withDefaults(
  defineProps<{
    class?: HTMLAttributes['class'];
  }>(),
  {
    class: undefined,
  },
);
</script>

<template>
  <slot v-if="$slots.default" />
  <Bookmark v-else :class="cn('size-4 shrink-0', props.class)" v-bind="$attrs" />
</template>
