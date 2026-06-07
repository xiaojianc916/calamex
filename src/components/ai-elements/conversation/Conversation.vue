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
const SCROLLBAR_IDLE_HIDE_DELAY_MS = 900;
const SCROLLBAR_GUTTER_WIDTH = 4;
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
const isScrollbarActive = ref(false);
const resolvedResize = computed(() => (isShellWindowResizing.value ? 'instant' : props.resize));
let scrollListenerCleanup: (() => void) | null = null;
let pendingScrollStateTimer: ReturnType<typeof setTimeout> | null = null;
let scrollbarIdleTimer: ReturnType<typeof setTimeout> | null = null;
let scrollbarPointerCleanup: (() => void) | null = null;
let restoreFrame: number | null = null;
let resizeLifecycleCleanup: (() => void) | null = null;

const cancelRestoreFrame = (): void => {
  if (restoreFrame !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(restoreFrame);
  }

  restoreFrame = null;
};

const clearScrollbarIdleTimer = (): void => {
  if (scrollbarIdleTimer !== null) {
    clearTimeout(scrollbarIdleTimer);
    scrollbarIdleTimer = null;
  }
};

const showScrollbarTemporarily = (): void => {
  clearScrollbarIdleTimer();
  isScrollbarActive.value = true;
  scrollbarIdleTimer = setTimeout(() => {
    scrollbarIdleTimer = null;
    isScrollbarActive.value = false;
  }, SCROLLBAR_IDLE_HIDE_DELAY_MS);
};

const getScrollElement = (): HTMLElement | null => stickToBottomRef.value?.scrollRef ?? null;

const isPointerInScrollbarGutter = (event: PointerEvent, scrollElement: HTMLElement): boolean => {
  const rect = scrollElement.getBoundingClientRect();

  return event.clientX >= rect.right - SCROLLBAR_GUTTER_WIDTH && event.clientX <= rect.right;
};

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
  scrollbarPointerCleanup?.();

  const scrollElement = getScrollElement();

  if (!scrollElement) {
    scrollListenerCleanup = null;
    scrollbarPointerCleanup = null;
    return;
  }

  const handleScroll = (): void => {
    showScrollbarTemporarily();
    queueScrollStateEmit(scrollElement);
  };
  const handlePointerMove = (event: PointerEvent): void => {
    if (isPointerInScrollbarGutter(event, scrollElement)) {
      showScrollbarTemporarily();
    }
  };
  const handlePointerDown = (event: PointerEvent): void => {
    if (!isPointerInScrollbarGutter(event, scrollElement)) {
      return;
    }

    clearScrollbarIdleTimer();
    isScrollbarActive.value = true;

    const handlePointerUp = (): void => {
      showScrollbarTemporarily();
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      scrollbarPointerCleanup = null;
    };

    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    scrollbarPointerCleanup = () => {
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      scrollbarPointerCleanup = null;
    };
  };

  scrollElement.addEventListener('scroll', handleScroll, { passive: true });
  scrollElement.addEventListener('pointermove', handlePointerMove, { passive: true });
  scrollElement.addEventListener('pointerdown', handlePointerDown);
  scrollListenerCleanup = () => {
    scrollElement.removeEventListener('scroll', handleScroll);
    scrollElement.removeEventListener('pointermove', handlePointerMove);
    scrollElement.removeEventListener('pointerdown', handlePointerDown);
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
  scrollbarPointerCleanup?.();
  resizeLifecycleCleanup?.();
  clearScrollbarIdleTimer();
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
    :class="cn('relative flex-1 overflow-y-hidden', { 'is-scrollbar-active': isScrollbarActive }, props.class)"
    role="log"
  >
    <slot />
  </StickToBottom>
</template>
