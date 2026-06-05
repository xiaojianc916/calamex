<template>
    <div class="app-surface h-screen" :style="shellThemeStyle">
        <div class="app-window-shell relative flex h-full flex-col overflow-hidden border border-(--shell-divider)">
            <template v-if="isDesktopRuntime">
                <div
v-for="handle in resizeHandles" :key="handle.direction" class="window-resize-handle"
                    :class="handle.className" @mousedown.prevent.stop="startWindowResize(handle.direction, $event)" />
            </template>

            <div v-if="isDesktopRuntime" class="app-window-controls" data-no-window-drag>
                <button class="app-window-control-button" type="button" aria-label="最小化" @click="handleMinimize">
                    <svg viewBox="0 0 12 12" aria-hidden="true">
                        <path d="M2.25 6h7.5" fill="none" stroke="currentColor" stroke-linecap="round" />
                    </svg>
                </button>
                <button
                    class="app-window-control-button" type="button" :aria-label="isMaximized ? '向下还原' : '最大化'"
                    @click="handleToggleMaximize">
                    <svg v-if="!isMaximized" viewBox="0 0 12 12" aria-hidden="true">
                        <rect x="3" y="2" width="7" height="7" rx="1.2" fill="none" stroke="currentColor" />
                    </svg>
                    <svg v-else viewBox="0 0 12 12" aria-hidden="true">
                        <path d="M4.5 2h5v5M7.5 5h-5v5h5z" fill="none" stroke="currentColor" stroke-linejoin="round" />
                    </svg>
                </button>
                <button class="app-window-control-button is-close" type="button" aria-label="关闭" @click="emit('close-request')">
                    <svg viewBox="0 0 12 12" aria-hidden="true">
                        <path d="M3 3l6 6M9 3L3 9" fill="none" stroke="currentColor" stroke-linecap="round" />
                    </svg>
                </button>
            </div>

            <slot name="titlebar" />

            <div class="relative flex min-h-0 flex-1 overflow-hidden bg-(--app-bg)">
                <aside
                    class="app-shell-pane min-h-0 overflow-hidden bg-(--sidebar-bg) transition-[width,opacity] duration-200"
                    :class="props.sidebarVisible ? 'opacity-100' : 'pointer-events-none opacity-0'"
                    :style="sidebarStyle">
                    <slot name="sidebar" />
                </aside>

                <div class="app-shell-pane flex min-h-0 flex-1 flex-col overflow-hidden bg-(--app-bg)">
                    <slot name="header" />

                    <main class="flex min-h-0 flex-1 flex-col overflow-hidden">
                        <section class="editor-surface min-h-0 flex-1 overflow-hidden">
                            <slot />
                        </section>
                    </main>
                </div>
            </div>

            <slot name="statusbar" />
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  SHELL_WINDOW_RESIZE_END_EVENT,
  SHELL_WINDOW_RESIZE_START_EVENT,
} from '@/utils/window-resize-events';

type TResizeDirection =
  | 'North'
  | 'South'
  | 'East'
  | 'West'
  | 'NorthEast'
  | 'NorthWest'
  | 'SouthEast'
  | 'SouthWest';

const SIDEBAR_MIN_WIDTH = 240;

const props = withDefaults(
  defineProps<{
    isDesktopRuntime?: boolean;
    activityVisible?: boolean;
    sidebarVisible?: boolean;
    sidebarWidth?: number;
  }>(),
  {
    isDesktopRuntime: false,
    activityVisible: false,
    sidebarVisible: true,
    sidebarWidth: 288,
  },
);

const emit = defineEmits<{
  'close-request': [];
}>();

const isMaximized = ref(false);
let isLayoutUnmounted = false;
let unlistenWindowResized: (() => void) | null = null;

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

const resolvedSidebarWidth = computed(() =>
  props.sidebarVisible ? Math.max(SIDEBAR_MIN_WIDTH, Math.round(props.sidebarWidth)) : 0,
);

const sidebarStyle = computed(() => ({
  width: `${resolvedSidebarWidth.value}px`,
  minWidth: `${resolvedSidebarWidth.value}px`,
  maxWidth: `${resolvedSidebarWidth.value}px`,
}));

const shellThemeStyle = computed(() => ({
  '--app-bg': '#fafafa',
  '--titlebar-bg': '#fafafa',
  '--sidebar-bg': '#fafafa',
  '--panel-bg': '#ffffff',
  '--tabbar-bg': '#ffffff',
  '--tab-active-bg': '#ffffff',
  '--statusbar-bg': '#fafafa',
  '--editor-bg': '#ffffff',
  '--editor-gutter-bg': '#ffffff',
  '--editor-surface': '#ffffff',
  '--shell-divider': '#d1d9e0b3',
  '--border-strong': '#d1d9e0',
  '--border-subtle': '#d1d9e0b3',
  '--text-primary': '#1f2328',
  '--text-secondary': '#59636e',
  '--text-tertiary': '#818b98',
  '--text-quaternary': '#818b98',
  '--surface-hover': '#818b981f',
  '--surface-soft': '#818b981f',
  '--surface-soft-strong': '#d1d9e0b3',
}));

const getAppWindow = async () => {
  if (!props.isDesktopRuntime) {
    return null;
  }

  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
};

const syncWindowState = async (): Promise<void> => {
  const appWindow = await getAppWindow();
  if (!appWindow || isLayoutUnmounted) {
    return;
  }

  try {
    isMaximized.value = await appWindow.isMaximized();
  } catch (error) {
    console.warn('读取窗口最大化状态失败', error);
  }
};

const handleMinimize = async (): Promise<void> => {
  const appWindow = await getAppWindow();
  if (!appWindow) {
    return;
  }

  await appWindow.minimize();
};

const handleToggleMaximize = async (): Promise<void> => {
  const appWindow = await getAppWindow();
  if (!appWindow) {
    return;
  }

  await appWindow.toggleMaximize();
  await syncWindowState();
};

const startWindowResize = async (direction: TResizeDirection, event: MouseEvent): Promise<void> => {
  if (!props.isDesktopRuntime || event.button !== 0) {
    return;
  }

  window.dispatchEvent(new Event(SHELL_WINDOW_RESIZE_START_EVENT));

  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().startResizeDragging(direction);
  } catch (error) {
    console.warn('窗口边缘拉伸失败', error);
  } finally {
    // 与起始的 START 事件配对：无论拖拽正常结束还是失败，都必须派发 END。
    // 否则 useShellWorkbenchViewportState 的 isShellWindowResizing 会永久卡在 true，
    // 导致编辑器视口的 ResizeObserver 更新被持续屏蔽（内部组件拖拽后不跟手）。
    window.dispatchEvent(new Event(SHELL_WINDOW_RESIZE_END_EVENT));
  }
};

onMounted(async () => {
  isLayoutUnmounted = false;
  const appWindow = await getAppWindow();
  if (!appWindow || isLayoutUnmounted) {
    return;
  }

  await syncWindowState();
  const unlisten = await appWindow.onResized(() => {
    void syncWindowState();
  });

  if (isLayoutUnmounted) {
    unlisten();
    return;
  }

  unlistenWindowResized = unlisten;
});

onBeforeUnmount(() => {
  isLayoutUnmounted = true;
  unlistenWindowResized?.();
  unlistenWindowResized = null;
});
</script>
