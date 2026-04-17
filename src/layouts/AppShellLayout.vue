<template>
  <div class="app-surface h-screen">
    <div class="app-window-shell relative flex h-full flex-col overflow-hidden border border-[var(--shell-divider)]">
      <template v-if="isDesktopRuntime">
        <div
          v-for="handle in resizeHandles"
          :key="handle.direction"
          class="window-resize-handle"
          :class="handle.className"
          @mousedown.prevent.stop="startWindowResize(handle.direction, $event)"
        />
      </template>

      <slot name="titlebar" />

      <div class="grid min-h-0 flex-1 grid-cols-[52px_288px_minmax(0,1fr)] overflow-hidden">
        <div class="border-r border-[var(--shell-divider)] bg-[var(--activity-bg)]">
          <slot name="activity" />
        </div>
        <div class="border-r border-[var(--shell-divider)] bg-[var(--sidebar-bg)]">
          <slot name="sidebar" />
        </div>
        <div class="flex min-h-0 flex-col bg-[var(--editor-bg)]">
          <slot name="header" />
          <main ref="mainRef" class="grid min-h-0 flex-1" :style="mainGridStyle">
            <section class="min-h-0 editor-surface">
              <slot />
            </section>

            <button
              v-show="terminalVisible"
              type="button"
              class="terminal-resize-handle"
              aria-label="调整终端高度"
              @mousedown.prevent="startTerminalResize"
            >
              <span class="terminal-resize-handle-bar" />
            </button>

            <section
              v-show="terminalVisible"
              class="min-h-0 bg-[var(--panel-bg)]"
            >
              <slot name="terminal" />
            </section>
          </main>
          <slot name="statusbar" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

type TResizeDirection =
  | 'North'
  | 'South'
  | 'East'
  | 'West'
  | 'NorthEast'
  | 'NorthWest'
  | 'SouthEast'
  | 'SouthWest';

const TERMINAL_MIN_HEIGHT = 140;
const EDITOR_MIN_HEIGHT = 220;
const SPLITTER_HEIGHT = 0;

const props = withDefaults(
  defineProps<{
    isDesktopRuntime?: boolean;
    terminalVisible?: boolean;
    terminalHeight?: number;
  }>(),
  {
    isDesktopRuntime: false,
    terminalVisible: true,
    terminalHeight: 236,
  },
);

const emit = defineEmits<{
  'update:terminalHeight': [value: number];
}>();

const mainRef = ref<HTMLElement | null>(null);
let resizeObserver: ResizeObserver | null = null;
let terminalResizeCleanup: (() => void) | null = null;

const resizeHandles: Array<{ direction: TResizeDirection; className: string }> = [
  { direction: 'North', className: 'is-top' },
  { direction: 'South', className: 'is-bottom' },
  { direction: 'East', className: 'is-right' },
  { direction: 'West', className: 'is-left' },
  { direction: 'NorthEast', className: 'is-top-right' },
  { direction: 'NorthWest', className: 'is-top-left' },
  { direction: 'SouthEast', className: 'is-bottom-right' },
  { direction: 'SouthWest', className: 'is-bottom-left' },
];

const clampTerminalHeight = (rawHeight: number): number => {
  if (!mainRef.value) {
    return Math.max(TERMINAL_MIN_HEIGHT, Math.round(rawHeight));
  }

  const availableHeight = mainRef.value.clientHeight;
  const maxHeight = Math.max(
    TERMINAL_MIN_HEIGHT,
    availableHeight - EDITOR_MIN_HEIGHT - SPLITTER_HEIGHT,
  );

  return Math.min(maxHeight, Math.max(TERMINAL_MIN_HEIGHT, Math.round(rawHeight)));
};

const mainGridStyle = computed(() => {
  if (!props.terminalVisible) {
    return {
      gridTemplateRows: 'minmax(0, 1fr)',
    };
  }

  const terminalHeight = clampTerminalHeight(props.terminalHeight);
  return {
    gridTemplateRows: `minmax(${EDITOR_MIN_HEIGHT}px, 1fr) ${SPLITTER_HEIGHT}px ${terminalHeight}px`,
  };
});

const syncTerminalHeightWithinViewport = (): void => {
  if (!props.terminalVisible) {
    return;
  }

  const normalizedHeight = clampTerminalHeight(props.terminalHeight);
  if (normalizedHeight !== props.terminalHeight) {
    emit('update:terminalHeight', normalizedHeight);
  }
};

const startTerminalResize = (event: MouseEvent): void => {
  if (!props.terminalVisible || !mainRef.value || event.button !== 0) {
    return;
  }

  const startY = event.clientY;
  const startHeight = clampTerminalHeight(props.terminalHeight);

  const handleMouseMove = (moveEvent: MouseEvent): void => {
    const nextHeight = clampTerminalHeight(startHeight + (startY - moveEvent.clientY));
    emit('update:terminalHeight', nextHeight);
  };

  const stopResize = (): void => {
    window.removeEventListener('mousemove', handleMouseMove);
    window.removeEventListener('mouseup', stopResize);
    terminalResizeCleanup = null;
  };

  terminalResizeCleanup = stopResize;
  window.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('mouseup', stopResize, { once: true });
};

const startWindowResize = async (
  direction: TResizeDirection,
  event: MouseEvent,
): Promise<void> => {
  if (!props.isDesktopRuntime || event.button !== 0) {
    return;
  }

  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().startResizeDragging(direction);
  } catch (error) {
    console.warn('窗口边缘拉伸失败', error);
  }
};

watch(
  () => [props.terminalVisible, props.terminalHeight],
  () => {
    syncTerminalHeightWithinViewport();
  },
);

onMounted(() => {
  syncTerminalHeightWithinViewport();

  if (typeof ResizeObserver === 'undefined' || !mainRef.value) {
    return;
  }

  resizeObserver = new ResizeObserver(() => {
    syncTerminalHeightWithinViewport();
  });
  resizeObserver.observe(mainRef.value);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  terminalResizeCleanup?.();
});
</script>
