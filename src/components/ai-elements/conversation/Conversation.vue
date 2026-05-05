<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { cn } from '@/lib/utils';
import { reactiveOmit } from '@vueuse/core';
import { StickToBottom } from 'vue-stick-to-bottom';

interface IConversationProps {
  ariaLabel?: string;
  class?: HTMLAttributes['class'];
  initial?: boolean | 'instant' | { damping?: number; stiffness?: number; mass?: number };
  resize?: 'instant' | { damping?: number; stiffness?: number; mass?: number };
  damping?: number;
  stiffness?: number;
  mass?: number;
  anchor?: 'auto' | 'none';
}

const props = withDefaults(defineProps<IConversationProps>(), {
  ariaLabel: 'AI 对话记录',
  class: undefined,
  initial: true,
  resize: undefined,
  damping: 0.7,
  stiffness: 0.05,
  mass: 1.25,
  anchor: 'auto',
});

const delegatedProps = reactiveOmit(props, 'class');
</script>

<template>
  <StickToBottom
    v-bind="delegatedProps"
    :class="cn('relative flex min-h-0 flex-1 overflow-y-hidden', props.class)"
    role="log"
  >
    <slot />
    <template #overlay>
      <slot name="overlay" />
    </template>
    <template #after>
      <slot name="after" />
    </template>
  </StickToBottom>
</template>
