<script setup lang="ts">
import { X } from '@lucide/vue';
import type { HTMLAttributes } from 'vue';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAttachmentContext } from './context';

interface IProps {
  label?: string;
  class?: HTMLAttributes['class'];
  disabled?: boolean;
}

const props = withDefaults(defineProps<IProps>(), {
  label: '移除附件',
  class: undefined,
  disabled: false,
});

const { remove, variant } = useAttachmentContext();

function handleClick(event: Event): void {
  event.stopPropagation();
  remove?.();
}
</script>

<template>
  <Button
    v-if="remove"
    :aria-label="props.label"
    :class="cn(
      variant === 'grid' && [
        'absolute top-2 right-2 size-6 rounded-full p-0',
        'bg-background/80 backdrop-blur-sm',
        'opacity-0 transition-opacity group-hover:opacity-100',
        'hover:bg-background',
        '[&>svg]:size-3',
      ],
      variant === 'inline' && [
        'size-5 rounded p-0',
        'opacity-0 transition-opacity group-hover:opacity-100',
        '[&>svg]:size-2.5',
      ],
      variant === 'list' && ['size-8 shrink-0 rounded p-0', '[&>svg]:size-4'],
      props.class,
    )"
    :disabled="props.disabled"
    type="button"
    variant="ghost"
    @click="handleClick"
  >
    <slot>
      <X />
    </slot>
    <span class="sr-only">{{ props.label }}</span>
  </Button>
</template>
