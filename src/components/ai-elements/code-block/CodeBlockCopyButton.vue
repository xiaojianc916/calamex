<script setup lang="ts">
import { reactiveOmit, useTimeoutFn } from '@vueuse/core';
import type { HTMLAttributes } from 'vue';
import { computed, ref } from 'vue';
import { Button } from '@/components/ui/button';
import LucideIcon from '@/components/ui/icon/LucideIcon.vue';
import { cn } from '@/lib/utils';
import { useCodeBlockContext } from './context';

interface IProps {
  timeout?: number;
  class?: HTMLAttributes['class'];
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
}

const props = withDefaults(defineProps<IProps>(), {
  timeout: 2000,
  class: undefined,
  disabled: false,
  type: 'button',
});

const emit = defineEmits<{
  copy: [];
  error: [error: Error];
}>();

const delegatedProps = reactiveOmit(props, 'timeout', 'class');
const { code } = useCodeBlockContext();

const isCopied = ref(false);
// immediate: false —— 仅在复制成功后手动 start()，到期复位 isCopied；
// 组件卸载时 vueuse 自动 stop，无需 onBeforeUnmount 清理。
const { start: scheduleReset } = useTimeoutFn(
  () => {
    isCopied.value = false;
  },
  () => props.timeout,
  { immediate: false },
);

const icon = computed(() => (isCopied.value ? 'check' : 'copy'));

async function copyToClipboard(): Promise<void> {
  if (typeof window === 'undefined' || !navigator?.clipboard?.writeText) {
    emit('error', new Error('Clipboard API 不可用'));
    return;
  }

  try {
    await navigator.clipboard.writeText(code.value);
    isCopied.value = true;
    emit('copy');
    scheduleReset();
  } catch (error) {
    emit('error', error instanceof Error ? error : new Error('复制代码失败'));
  }
}
</script>

<template>
  <Button data-slot="code-block-copy-button" v-bind="delegatedProps" :class="cn('shrink-0', props.class)" size="icon"
    variant="ghost" @click="copyToClipboard">
    <slot>
      <LucideIcon :name="icon" class="size-3.5" />
    </slot>
  </Button>
</template>
