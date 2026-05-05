<script setup lang="ts">
import { CollapsibleContent } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type { HTMLAttributes } from 'vue';

const props = withDefaults(defineProps<{
  class?: HTMLAttributes['class'];
}>(), {
  class: undefined,
});
</script>

<template>
  <CollapsibleContent
    :class="
      cn(
        'text-popover-foreground outline-none',
        'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2',
        'data-[state=open]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=open]:animate-in',
        props.class,
      )
    "
    v-bind="$attrs"
  >
    <div class="mt-4 space-y-2 border-l-2 border-muted pl-4">
      <slot />
    </div>
  </CollapsibleContent>
</template>
