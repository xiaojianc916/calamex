<script setup lang="ts">
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import type { HTMLAttributes } from 'vue';

const props = withDefaults(defineProps<{
  class?: HTMLAttributes['class'];
}>(), {
  class: undefined,
});
</script>

<template>
  <div :class="cn('flex items-center gap-0.5 text-muted-foreground overflow-hidden', props.class)" v-bind="$attrs">
    <slot />
    <Separator />
  </div>
</template>
