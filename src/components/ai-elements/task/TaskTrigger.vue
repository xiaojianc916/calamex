<script setup lang="ts">
import { ChevronDown } from '@lucide/vue';
import type { HTMLAttributes } from 'vue';
import { CollapsibleTrigger } from '@/components/ui/collapsible';
import LucideIcon from '@/components/ui/icon/LucideIcon.vue';
import { cn } from '@/lib/utils';

type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'error';

interface Props {
  title?: string;
  status?: TaskStatus;
  class?: HTMLAttributes['class'];
}

const props = withDefaults(defineProps<Props>(), {
  title: '',
  status: 'pending',
  class: '',
});

const statusMap: Record<TaskStatus, { icon: string; class: string }> = {
  pending: { icon: 'circle', class: 'text-muted-foreground' },
  in_progress: { icon: 'loader-circle', class: 'text-blue-500 animate-spin' },
  completed: { icon: 'check', class: 'text-emerald-500' },
  error: { icon: 'circle-alert', class: 'text-red-500' },
};
</script>

<template>
  <CollapsibleTrigger as-child :class="cn('group w-full', props.class)">
    <slot :status="props.status" :title="props.title">
      <button type="button" class="flex w-full cursor-pointer items-center gap-2 text-sm
               text-muted-foreground transition-colors hover:text-foreground">
        <LucideIcon :name="statusMap[props.status].icon" :class="['size-4 shrink-0', statusMap[props.status].class]" />
        <span class="truncate text-foreground">{{ props.title }}</span>
        <ChevronDown class="ml-auto size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
      </button>
    </slot>
  </CollapsibleTrigger>
</template>
