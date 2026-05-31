<script setup lang="ts">
// import type { InputGroupButtonVariants } from '@/components/ui/input-group'

import type { ChatStatus } from 'ai';
import type { HTMLAttributes } from 'vue';
import { computed } from 'vue';
import type { InputGroupButtonVariants } from '@/components/ui/input-group';
import { InputGroupButton } from '@/components/ui/input-group';
import { cn } from '@/lib/utils';

type TPromptInputButtonVariant = 'default' | 'outline' | 'ghost';

interface Props {
  class?: HTMLAttributes['class'];
  status?: ChatStatus;
  variant?: TPromptInputButtonVariant;
  size?: InputGroupButtonVariants['size'];
}

const props = withDefaults(defineProps<Props>(), {
  class: undefined,
  status: undefined,
  variant: 'default',
  size: 'icon-sm',
});

const icon = computed(() => {
  if (props.status === 'submitted') return 'icon-[lucide--loader-circle]';
  if (props.status === 'streaming') return 'icon-[lucide--square]';
  if (props.status === 'error') return 'icon-[lucide--x]';
  return 'icon-[lucide--corner-down-left]';
});

const iconClass = computed(() => {
  if (props.status === 'submitted') {
    return 'size-4 animate-spin';
  }
  return 'size-4';
});
</script>

<template>
  <InputGroupButton aria-label="Submit" :class="cn(props.class)" :size="props.size" :variant="props.variant"
    type="submit" v-bind="$attrs">
    <slot>
      <span :class="[icon, iconClass]" />
    </slot>
  </InputGroupButton>
</template>
