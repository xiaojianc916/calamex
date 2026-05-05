<script setup lang="ts">
import { CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { ChevronDown, Search } from 'lucide-vue-next';
import type { HTMLAttributes } from 'vue';

const props = withDefaults(defineProps<{
  title: string;
  class?: HTMLAttributes['class'];
}>(), {
  class: undefined,
});
</script>

<template>
  <CollapsibleTrigger as-child :class="cn('group', props.class)">
    <slot>
      <div class="flex w-full cursor-pointer items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground">
        <Search class="size-4" aria-hidden="true" />
        <p class="text-sm">{{ props.title }}</p>
        <ChevronDown class="size-4 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
      </div>
    </slot>
  </CollapsibleTrigger>
</template>
