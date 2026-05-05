<script setup lang="ts">
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type { HTMLAttributes } from 'vue';
import { useChainOfThought } from './context';

const props = withDefaults(defineProps<{
  class?: HTMLAttributes['class'];
}>(), {
  class: undefined,
});

const { isOpen } = useChainOfThought();
</script>

<template>
  <Collapsible :open="isOpen">
    <CollapsibleContent
      :class="
        cn(
          'mt-2 space-y-3 text-popover-foreground outline-none',
          'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2',
          'data-[state=open]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=open]:animate-in',
          props.class,
        )
      "
      v-bind="$attrs"
    >
      <slot />
    </CollapsibleContent>
  </Collapsible>
</template>
