<script setup lang="ts">
import { CollapsibleContent } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { computed, useSlots, type HTMLAttributes } from 'vue';

const props = withDefaults(defineProps<{
  class?: HTMLAttributes['class'];
  content?: string;
}>(), {
  class: undefined,
  content: '',
});

const slots = useSlots();

const hasDefaultSlot = computed(() => Boolean(slots.default));
const textContent = computed(() => props.content ?? '');
</script>

<template>
  <CollapsibleContent
    :class="
      cn(
        'mt-4 text-sm text-muted-foreground outline-none',
        'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2',
        'data-[state=open]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=open]:animate-in',
        props.class,
      )
    "
    v-bind="$attrs"
  >
    <slot v-if="hasDefaultSlot" />
    <p v-else class="reasoning-content-text">{{ textContent }}</p>
  </CollapsibleContent>
</template>

<style scoped>
.reasoning-content-text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}
</style>
