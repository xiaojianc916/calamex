<script setup lang="ts">
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { HTMLAttributes } from 'vue';

const props = withDefaults(defineProps<{
  class?: HTMLAttributes['class'];
}>(), {
  class: undefined,
});
</script>

<template>
  <Badge
    :class="
      cn(
        'gap-1 border-transparent bg-muted px-2 py-0.5 font-normal text-foreground text-xs',
        props.class,
      )
    "
    variant="secondary"
    v-bind="$attrs"
  >
    <slot />
  </Badge>
</template>
