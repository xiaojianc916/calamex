<script setup lang="ts">
import { Collapsible } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { useVModel } from '@vueuse/core';
import { computed, provide, ref, watch, type HTMLAttributes } from 'vue';
import { ReasoningKey } from './context';

interface IReasoningProps {
  class?: HTMLAttributes['class'];
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  duration?: number;
}

const props = withDefaults(defineProps<IReasoningProps>(), {
  class: undefined,
  isStreaming: false,
  open: undefined,
  defaultOpen: true,
  duration: undefined,
});

const emit = defineEmits<{
  'update:open': [value: boolean];
  'update:duration': [value: number];
}>();

const isOpen = useVModel(props, 'open', emit, {
  defaultValue: props.defaultOpen,
  passive: true,
});
const internalDuration = ref<number | undefined>(props.duration);
const hasAutoClosed = ref(false);
const startTime = ref<number | null>(null);

const MS_IN_SECOND = 1000;
const AUTO_CLOSE_DELAY_MS = 1000;

watch(() => props.duration, (duration) => {
  internalDuration.value = duration;
});

const updateDuration = (duration: number): void => {
  internalDuration.value = duration;
  emit('update:duration', duration);
};

watch(() => props.isStreaming, (isStreaming) => {
  if (isStreaming) {
    isOpen.value = true;
    hasAutoClosed.value = false;

    if (startTime.value === null && props.duration === undefined) {
      startTime.value = Date.now();
    }

    return;
  }

  if (startTime.value !== null) {
    updateDuration(Math.ceil((Date.now() - startTime.value) / MS_IN_SECOND));
    startTime.value = null;
  }
}, { immediate: true });

watch([() => props.isStreaming, isOpen, () => props.defaultOpen, hasAutoClosed], (_value, _oldValue, onCleanup) => {
  if (!props.defaultOpen || props.isStreaming || !isOpen.value || hasAutoClosed.value) {
    return;
  }

  const timer = window.setTimeout(() => {
    isOpen.value = false;
    hasAutoClosed.value = true;
  }, AUTO_CLOSE_DELAY_MS);

  onCleanup(() => window.clearTimeout(timer));
}, { immediate: true });

provide(ReasoningKey, {
  isStreaming: computed(() => props.isStreaming),
  isOpen,
  setIsOpen: (open: boolean): void => {
    isOpen.value = open;
  },
  duration: computed(() => internalDuration.value),
});
</script>

<template>
  <Collapsible v-model:open="isOpen" :class="cn('not-prose mb-4', props.class)" v-bind="$attrs">
    <slot />
  </Collapsible>
</template>
