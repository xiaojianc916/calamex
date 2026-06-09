<script setup lang="ts">
import { Plus } from '@lucide/vue';
import type { DropdownMenuTriggerProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import PromptInputButton from './PromptInputButton.vue';

interface Props extends DropdownMenuTriggerProps {
  class?: HTMLAttributes['class'];
}

const props = defineProps<Props>();
</script>

<template>
  <DropdownMenuTrigger as-child>
    <PromptInputButton :class="props.class" v-bind="props">
      <slot><Plus class="size-4" /></slot>
    </PromptInputButton>
  </DropdownMenuTrigger>
</template>
