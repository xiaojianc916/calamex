<script setup lang="ts">
import { computed, type HTMLAttributes, provide } from 'vue';
import { cn } from '@/lib/utils';
import { AttachmentKey, useAttachmentsContext } from './context';
import type { TAttachmentData } from './types';
import { getMediaCategory } from './utils';

interface IProps {
  data: TAttachmentData;
  class?: HTMLAttributes['class'];
}

const props = defineProps<IProps>();

const emit = defineEmits<{
  remove: [];
}>();

const { variant } = useAttachmentsContext();
const attachmentData = computed(() => props.data);
const mediaCategory = computed(() => getMediaCategory(props.data));

function handleRemove(): void {
  emit('remove');
}

provide(AttachmentKey, {
  data: attachmentData,
  mediaCategory,
  remove: handleRemove,
  variant,
});
</script>

<template>
  <div
    :class="cn(
      'group relative',
      variant === 'grid' && 'size-24 overflow-hidden rounded-lg',
      variant === 'inline' && [
        'flex h-8 cursor-pointer select-none items-center gap-1.5',
        'rounded-md border border-border px-1.5',
        'font-medium text-sm transition-all',
        'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
      ],
      variant === 'list' && [
        'flex w-full items-center gap-3 rounded-lg border p-3',
        'hover:bg-accent/50',
      ],
      props.class,
    )"
    v-bind="$attrs"
  >
    <slot />
  </div>
</template>
