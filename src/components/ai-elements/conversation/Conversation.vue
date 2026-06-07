<script setup lang="ts">
import { reactiveOmit } from '@vueuse/core';
import type { HTMLAttributes } from 'vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { StickToBottom } from 'vue-stick-to-bottom';
import { cn } from '@/lib/utils';
import {
  SHELL_WINDOW_RESIZE_END_EVENT,
  SHELL_WINDOW_RESIZE_SETTLED_EVENT,
  SHELL_WINDOW_RESIZE_START_EVENT,
} from '@/utils/window-resize-events';

interface Props {
  ariaLabel?: string;
  class?: HTMLAttributes['class'];
  initial?: boolean | 'instant' | { damping?: number; stiffness?: number; mass?: number };
  resize?: 'instant' | { damping?: number; stiffness?: number; mass?: number };
  damping?: number;
  stiffness?: number;
  mass?: number;
  anchor?: 'auto' | 'none';
  restoreKey?: string | null;
  initialScrollTop?: number | null;
  initialDistanceFromBottom?: number | null;
}

const props = withDefaults(defineProps<Props>(), {
  ariaLabel: 'Conversation',
  class: undefined,
  initial: true,
  resize: undefined,
  damping: 0.7,
  stiffness: 0.05,
  mass: 1.25,
  anchor: 'none',
  restoreKey: null,
  initialScrollTop: null,
  initialDistanceFromBottom: null,
});

const emit = defineEmits<{
  scrollStateChange: [
    state: {
      scrollTop: number;
      scrollHeight: number;
      clientHeight: number;
      distanceFromBottom: number;
    },
  ];
}>();

const SCROLL_BOTTOM_RESTORE_THRESHOLD = 4;
const stickToBottomRef = ref<{ scrollRef: HTMLElement | null } | null>(null);
const delegatedProps = reactiveOmit(
  props,
  'class',
  'restoreKey',
  'initialScrollTop',
  'initialDistanceFromBottom',
  'resize',
);
const isShellWindowResizing = ref(false);
const resolvedResize = computed(() => (isShellWindowResizing.value ? 'instant' : props.resize));
let scrollListenerCleanup: (() => void) | null = null;
let pendingScrollStateTimer: ReturnType<typeof setTimeout> | null = null;
let restoreFrame: number | null = null;
let resizeLifecycleCleanup: (() => void) | null = null;

const cancelRestoreFrame = (): void => {
  if (restoreFrame !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(restoreFrame);
  }

  restoreFrame = null;
};

const getScrollElement = (): HTMLElement | null => stickToBottomRef.value?.scrollRef ?? null;

const emitScrollState = (scrollElement: HTMLElement): void => {
  const scrollTop = Math.max(0, Math.round(scrollElement.scrollTop));
  const scrollHeight = Math.max(0, Math.round(scrollElement.scrollHeight));
  const clientHeight = Math.max(0, Math.round(scrollElement.clientHeight));
  const distanceFromBottom = Math.max(0, Math.round(scrollHeight - clientHeight - scrollTop));

  emit('scrollStateChange', {
    scrollTop,
    scrollHeight,
    clientHeight,
    distanceFromBottom,
  });
};

const queueScrollStateEmit = (scrollElement: HTMLElement): void => {
  if (pendingScrollStateTimer !== null) {
    clearTimeout(pendingScrollStateTimer);
  }

  pendingScrollStateTimer = setTimeout(() => {
    pendingScrollStateTimer = null;
    emitScrollState(scrollElement);
  }, 120);
};

const resolveRestoredScrollTop = (scrollElement: HTMLElement): number => {
  const maxScrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
  if (props.initialScrollTop === null) {
    return maxScrollTop;
  }

  const restoredScrollTop = props.initialScrollTop ?? 0;
  const distanceFromBottom = props.initialDistanceFromBottom;
  const target =
    distanceFromBottom !== null && distanceFromBottom <= SCROLL_BOTTOM_RESTORE_THRESHOLD
      ? maxScrollTop
      : restoredScrollTop;

  return Math.min(Math.max(0, target), maxScrollTop);
};

const restoreScrollPosition = async (): Promise<void> => {
  if (!props.restoreKey) {
    return;
  }

  cancelRestoreFrame();
  await nextTick();

  restoreFrame = requestAnimationFrame(() => {
    restoreFrame = null;
    const scrollElement = getScrollElement();

    if (!scrollElement) {
      return;
    }

    scrollElement.scrollTop = resolveRestoredScrollTop(scrollElement);
    emitScrollState(scrollElement);
  });
};

const bindScrollListener = (): void => {
  scrollListenerCleanup?.();

  const scrollElement = getScrollElement();

  if (!scrollElement) {
    scrollListenerCleanup = null;
    return;
  }

  const handleScroll = (): void => {
    queueScrollStateEmit(scrollElement);
  };

  scrollElement.addEventListener('scroll', handleScroll, { passive: true });
  scrollListenerCleanup = () => {
    scrollElement.removeEventListener('scroll', handleScroll);
  };
};

const bindResizeLifecycle = (): void => {
  const handleResizeStart = (): void => {
    isShellWindowResizing.value = true;
  };
  const handleResizeEnd = (): void => {
    isShellWindowResizing.value = false;
  };

  window.addEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleResizeStart);
  window.addEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleResizeEnd);
  window.addEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleResizeEnd);
  resizeLifecycleCleanup = () => {
    window.removeEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleResizeStart);
    window.removeEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleResizeEnd);
    window.removeEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleResizeEnd);
    resizeLifecycleCleanup = null;
  };
};

onMounted(() => {
  bindResizeLifecycle();
  void nextTick(() => {
    bindScrollListener();
    void restoreScrollPosition();
  });
});

watch(
  () => props.restoreKey,
  () => {
    void restoreScrollPosition();
  },
);

onBeforeUnmount(() => {
  const scrollElement = getScrollElement();

  if (scrollElement) {
    emitScrollState(scrollElement);
  }

  scrollListenerCleanup?.();
  resizeLifecycleCleanup?.();
  cancelRestoreFrame();

  if (pendingScrollStateTimer !== null) {
    clearTimeout(pendingScrollStateTimer);
    pendingScrollStateTimer = null;
  }
});
</script>

<template>
  <StickToBottom
    ref="stickToBottomRef"
    v-bind="delegatedProps"
    :resize="resolvedResize"
    :class="cn('relative flex-1 overflow-y-hidden', props.class)"
    role="log"
  >
    <slot />
  </StickToBottom>
</template>
