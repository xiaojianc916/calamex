<script setup lang="ts">
import type { TAiChatRole } from '@/types/ai';
import type { HTMLAttributes } from 'vue';
import { cn } from '@/lib/utils';

const props = withDefaults(defineProps<{
  from: TAiChatRole;
  class?: HTMLAttributes['class'];
}>(), {
  class: undefined,
});
</script>

<template>
  <div
    :class="cn('group flex w-full max-w-[80%] gap-2', props.from === 'user' ? 'is-user ml-auto justify-end' : 'is-assistant', props.class)"
    v-bind="$attrs"
  >
    <slot />
  </div>
</template>
