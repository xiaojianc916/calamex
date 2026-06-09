<script setup lang="ts">
import { Trash2 } from '@lucide/vue';
import type { HTMLAttributes } from 'vue';
import { inject } from 'vue';
import { cn } from '@/lib/utils';
import { TerminalKey } from './context';

const props = defineProps<{ class?: HTMLAttributes['class'] }>();
const terminal = inject(TerminalKey);

const handleClear = (): void => {
  terminal?.clearOutput();
};
</script>

<template>
  <button
    type="button"
    :class="cn('ai-terminal-icon-button', props.class)"
    aria-label="清空终端输出"
    title="清空终端输出"
    @click="handleClear"
  >
    <Trash2 aria-hidden="true" />
  </button>
</template>
