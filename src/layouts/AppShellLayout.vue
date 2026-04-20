<template>
  <div class="app-surface h-screen">
    <div
ref="shellRef"
      class="app-window-shell relative flex h-full flex-col overflow-hidden border border-(--shell-divider)"
      :data-layout-resizing="layoutTransitionsEnabled ? 'false' : 'true'">
      <template v-if="isDesktopRuntime">
        <div
v-for="handle in resizeHandles" :key="handle.direction" class="window-resize-handle"
          :class="handle.className" @mousedown.prevent.stop="startWindowResize(handle.direction, $event)" />
      </template>

      <slot name="titlebar" />

      <div
class="relative grid min-h-0 flex-1 overflow-hidden"
        :class="layoutTransitionsEnabled ? layoutGridTransitionClass : 'transition-none'" :style="shellGridStyle">
        <div class="border-r border-(--shell-divider) bg-(--activity-bg)">
          <slot name="activity" />
        </div>

        <div
class="app-shell-pane min-w-0 overflow-hidden bg-(--sidebar-bg)" :class="[
          layoutTransitionsEnabled ? surfaceTransitionClass : 'transition-none',
          props.sidebarVisible
            ? 'translate-x-0 border-r border-(--shell-divider) opacity-100'
            : '-translate-x-3 opacity-0 pointer-events-none',
        ]">
          <slot name="sidebar" />
        </div>

        <div class="app-shell-pane flex min-h-0 flex-col bg-(--editor-bg)">
          <slot name="header" />
          <main
ref="mainRef" class="grid min-h-0 flex-1"
            :class="layoutTransitionsEnabled ? layoutRowsTransitionClass : 'transition-none'" :style="mainGridStyle">
            <section class="app-shell-pane min-h-0 editor-surface">
              <slot />
            </section>

            <button
type="button" class="terminal-resize-handle" :class="[
              layoutTransitionsEnabled ? surfaceTransitionClass : 'transition-none',
              props.terminalVisible
                ? 'translate-y-0 opacity-100'
                : 'translate-y-3 opacity-0 pointer-events-none',
            ]" aria-label="调整终端高度" @mousedown.prevent="startTerminalResize">
              <span class="terminal-resize-handle-bar" />
            </button>

            <section
class="app-shell-pane min-h-0 overflow-hidden bg-(--panel-bg)" :class="[
              layoutTransitionsEnabled ? surfaceTransitionClass : 'transition-none',
              props.terminalVisible
                ? 'translate-y-0 opacity-100'
                : 'translate-y-3 opacity-0 pointer-events-none',
            ]">
              <slot name="terminal" />
            </section>
          </main>
          <slot name="statusbar" />
        </div>

        <div
v-if="props.contentOverlayVisible" class="pointer-events-none absolute inset-y-0 right-0 z-35"
          :style="contentOverlayStyle">
          <div class="pointer-events-auto h-full min-h-0">
            <slot name="overlay" />
          </div>
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
const ACTIVITY_RAIL_WIDTH = 52;
const STATUSBAR_HEIGHT = 28;

const props = withDefaults(
  defineProps<{
    isDesktopRuntime?: boolean;
    sidebarVisible?: boolean;
    terminalVisible?: boolean;
    terminalHeight?: number;
    sidebarWidth?: number;
    contentOverlayVisible?: boolean;
  }>(),
  {
    isDesktopRuntime: false,
    sidebarVisible: true,
    terminalVisible: true,
    terminalHeight: 236,
    sidebarWidth: 240,
    contentOverlayVisible: false,
  },
);

const emit = defineEmits<{
  'update:terminalHeight': [value: number];
}>();

const WINDOW_RESIZE_SETTLE_MS = 140;
const mainRef = ref<HTMLElement | null>(null);
const shellRef = ref<HTMLElement | null>(null);
const layoutTransitionsEnabled = ref(true);
let resizeObserver: ResizeObserver | null = null;
let shellResizeObserver: ResizeObserver | null = null;
let terminalResizeCleanup: (() => void) | null = null;
let resizeSettleTimerId: number | null = null;
let shellResizeFrameId: number | null = null;
let terminalViewportSyncFrameId: number | null = null;
let terminalResizeFrameId: number | null = null;
let previousShellSize = { width: 0, height: 0 };
let pendingShellSize: { width: number; height: number } | null = null;
let pendingTerminalResizeHeight: number | null = null;

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
  const terminalHeight = clampTerminalHeight(props.terminalHeight);

  if (!props.terminalVisible) {
    return {
      gridTemplateRows: `minmax(${EDITOR_MIN_HEIGHT}px, 1fr) 0px 0px`,
    };
  }

  return {
    gridTemplateRows: `minmax(${EDITOR_MIN_HEIGHT}px, 1fr) ${SPLITTER_HEIGHT}px ${terminalHeight}px`,
  };
});

const shellGridStyle = computed(() => ({
  gridTemplateColumns: `52px ${props.sidebarVisible ? props.sidebarWidth : 0}px minmax(0, 1fr)`,
}));

const contentOverlayStyle = computed(() => ({
  left: `${ACTIVITY_RAIL_WIDTH}px`,
  bottom: `${STATUSBAR_HEIGHT}px`,
}));

const layoutGridTransitionClass =
  'transition-[grid-template-columns] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]';
const layoutRowsTransitionClass =
  'transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]';
const surfaceTransitionClass =
  'transition-[opacity,transform,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]';

const scheduleLayoutTransitionRestore = (): void => {
  if (resizeSettleTimerId !== null) {
    window.clearTimeout(resizeSettleTimerId);
  }

  resizeSettleTimerId = window.setTimeout(() => {
    layoutTransitionsEnabled.value = true;
    resizeSettleTimerId = null;
  }, WINDOW_RESIZE_SETTLE_MS);
};

const handleShellResize = (width: number, height: number): void => {
  const normalizedWidth = Math.round(width);
  const normalizedHeight = Math.round(height);

  if (normalizedWidth <= 0 || normalizedHeight <= 0) {
    return;
  }

  if (
    previousShellSize.width === normalizedWidth &&
    previousShellSize.height === normalizedHeight
  ) {
    return;
  }

  previousShellSize = { width: normalizedWidth, height: normalizedHeight };
  layoutTransitionsEnabled.value = false;
  scheduleLayoutTransitionRestore();
};

const flushShellResize = (): void => {
  shellResizeFrameId = null;
  if (!pendingShellSize) {
    return;
  }

  const { width, height } = pendingShellSize;
  pendingShellSize = null;
  handleShellResize(width, height);
};

const queueShellResize = (width: number, height: number): void => {
  pendingShellSize = {
    width: Math.round(width),
    height: Math.round(height),
  };

  if (shellResizeFrameId !== null) {
    return;
  }

  shellResizeFrameId = window.requestAnimationFrame(flushShellResize);
};

const scheduleTerminalViewportSync = (): void => {
  if (terminalViewportSyncFrameId !== null) {
    return;
  }

  terminalViewportSyncFrameId = window.requestAnimationFrame(() => {
    terminalViewportSyncFrameId = null;
    syncTerminalHeightWithinViewport();
  });
};

const syncTerminalHeightWithinViewport = (): void => {
  if (!props.terminalVisible) {
    return;
  }

  const normalizedHeight = clampTerminalHeight(props.terminalHeight);
  if (normalizedHeight !== props.terminalHeight) {
    emit('update:terminalHeight', normalizedHeight);
  }
};

const flushPendingTerminalResizeHeight = (): void => {
  terminalResizeFrameId = null;
  if (pendingTerminalResizeHeight === null) {
    return;
  }

  const nextHeight = pendingTerminalResizeHeight;
  pendingTerminalResizeHeight = null;

  if (nextHeight !== props.terminalHeight) {
    emit('update:terminalHeight', nextHeight);
  }
};

const queueTerminalResizeHeight = (nextHeight: number): void => {
  pendingTerminalResizeHeight = nextHeight;

  if (terminalResizeFrameId !== null) {
    return;
  }

  terminalResizeFrameId = window.requestAnimationFrame(flushPendingTerminalResizeHeight);
};

const startTerminalResize = (event: MouseEvent): void => {
  if (!props.terminalVisible || !mainRef.value || event.button !== 0) {
    return;
  }

  terminalResizeCleanup?.();

  const startY = event.clientY;
  const startHeight = clampTerminalHeight(props.terminalHeight);
  layoutTransitionsEnabled.value = false;

  const handleMouseMove = (moveEvent: MouseEvent): void => {
    const nextHeight = clampTerminalHeight(startHeight + (startY - moveEvent.clientY));
    queueTerminalResizeHeight(nextHeight);
  };

  const stopResize = (): void => {
    window.removeEventListener('mousemove', handleMouseMove);
    window.removeEventListener('mouseup', stopResize);
    window.removeEventListener('blur', stopResize);
    if (terminalResizeFrameId !== null) {
      window.cancelAnimationFrame(terminalResizeFrameId);
      flushPendingTerminalResizeHeight();
    }
    scheduleLayoutTransitionRestore();
    terminalResizeCleanup = null;
  };

  terminalResizeCleanup = stopResize;
  window.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('mouseup', stopResize, { once: true });
  window.addEventListener('blur', stopResize, { once: true });
};

const startWindowResize = async (direction: TResizeDirection, event: MouseEvent): Promise<void> => {
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
    scheduleTerminalViewportSync();
  },
);

onMounted(() => {
  syncTerminalHeightWithinViewport();

  if (shellRef.value) {
    previousShellSize = {
      width: shellRef.value.clientWidth,
      height: shellRef.value.clientHeight,
    };
  }

  if (typeof ResizeObserver === 'undefined' || !mainRef.value) {
    return;
  }

  resizeObserver = new ResizeObserver(() => {
    scheduleTerminalViewportSync();
  });
  resizeObserver.observe(mainRef.value);

  if (shellRef.value) {
    shellResizeObserver = new ResizeObserver((entries) => {
      const targetEntry = entries[0];
      if (!targetEntry) {
        return;
      }

      queueShellResize(targetEntry.contentRect.width, targetEntry.contentRect.height);
    });
    shellResizeObserver.observe(shellRef.value);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  shellResizeObserver?.disconnect();
  terminalResizeCleanup?.();

  if (shellResizeFrameId !== null) {
    window.cancelAnimationFrame(shellResizeFrameId);
    shellResizeFrameId = null;
  }

  if (terminalViewportSyncFrameId !== null) {
    window.cancelAnimationFrame(terminalViewportSyncFrameId);
    terminalViewportSyncFrameId = null;
  }

  if (terminalResizeFrameId !== null) {
    window.cancelAnimationFrame(terminalResizeFrameId);
    terminalResizeFrameId = null;
  }

  pendingTerminalResizeHeight = null;

  if (resizeSettleTimerId !== null) {
    window.clearTimeout(resizeSettleTimerId);
    resizeSettleTimerId = null;
  }
});
</script>
