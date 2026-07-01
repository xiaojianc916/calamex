<template>
    <div class="app-surface h-screen" :style="shellThemeStyle">
        <div class="app-window-shell relative flex h-full flex-col overflow-hidden border border-(--shell-divider)">
            <template v-if="isDesktopRuntime">
                <div class="app-window-drag-region" data-tauri-drag-region />
            </template>

            <div v-if="isDesktopRuntime" class="app-titlebar-github-auth" data-no-window-drag>
                <GitHubAuthPill :repository-root-path="gitHubAuthRepositoryRootPath" />
            </div>

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
import GitHubAuthPill from '@/components/workbench/GitHubAuthPill.vue';
import { useGitStore } from '@/domains/git/state/git';
import { windowChromeService } from '@/services/tauri/window';

const SIDEBAR_MIN_WIDTH = 240;
// 原生 onResized 会在拖拽缩放期间对每一个 WM_SIZE 帧持续触发；把最大化态回读
// 去抖到「停止收到 resize 事件之后」再跑一次，避免拖拽全程对 WebView2<->Rust
// IPC 桥发起 isMaximized() 洪泛（正是我们想要保持顺滑的那段时间）。最大化按钮
// 图标只需在缩放结束后正确即可，无需逐帧同步。
const WINDOW_STATE_RESYNC_DEBOUNCE_MS = 200;

const props = withDefaults(
  defineProps<{
    isDesktopRuntime?: boolean;
    sidebarVisible?: boolean;
    sidebarWidth?: number;
  }>(),
  {
    isDesktopRuntime: false,
    sidebarVisible: true,
    sidebarWidth: 288,
  },
);

const emit = defineEmits<{
  'close-request': [];
}>();

const gitStore = useGitStore();
const gitHubAuthRepositoryRootPath = computed(() => gitStore.status.repositoryRootPath);
const isMaximized = ref(false);
let isLayoutUnmounted = false;
let unlistenWindowResized: (() => void) | null = null;
let windowStateSyncTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
let windowStateResyncTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

const resolvedSidebarWidth = computed(() =>
  props.sidebarVisible ? Math.max(SIDEBAR_MIN_WIDTH, Math.round(props.sidebarWidth)) : 0,
);

const sidebarStyle = computed(() => ({
  width: `${resolvedSidebarWidth.value}px`,
  minWidth: `${resolvedSidebarWidth.value}px`,
  maxWidth: `${resolvedSidebarWidth.value}px`,
}));

const shellThemeStyle = {
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
} as const;

const syncWindowState = async (): Promise<void> => {
  const maximized = await windowChromeService.isMaximized();
  if (isLayoutUnmounted) {
    return;
  }
  isMaximized.value = maximized;
};

// onResized 在缩放期间逐帧触发；这里只登记一个去抖计时器，等 resize 真正停下来
// 之后才回读一次最大化态，从而把拖拽全程的 isMaximized() IPC 往返压成 0 次。
const scheduleWindowStateResync = (): void => {
  if (windowStateResyncTimer !== null) {
    globalThis.clearTimeout(windowStateResyncTimer);
  }
  windowStateResyncTimer = globalThis.setTimeout(() => {
    windowStateResyncTimer = null;
    void syncWindowState();
  }, WINDOW_STATE_RESYNC_DEBOUNCE_MS);
};

const handleMinimize = (): Promise<void> => windowChromeService.minimize();

const handleToggleMaximize = async (): Promise<void> => {
  await windowChromeService.toggleMaximize();
  await syncWindowState();
};

const bindNativeWindowStateListeners = async (): Promise<void> => {
  if (isLayoutUnmounted) {
    return;
  }

  await syncWindowState();
  const unlisten = await windowChromeService.onResized(() => {
    scheduleWindowStateResync();
  });

  if (!unlisten) {
    return;
  }

  if (isLayoutUnmounted) {
    unlisten();
    return;
  }

  unlistenWindowResized = unlisten;
};

onMounted(() => {
  isLayoutUnmounted = false;
  // 原生窗口状态同步不是首帧必需：延后 import('@tauri-apps/api/window') 与 IPC，
  // 避免 AppShellLayout mount 时和工作台首屏争抢主线程/桥接资源。
  windowStateSyncTimer = globalThis.setTimeout(() => {
    windowStateSyncTimer = null;
    void bindNativeWindowStateListeners();
  }, 1600);
});

onBeforeUnmount(() => {
  isLayoutUnmounted = true;
  if (windowStateSyncTimer !== null) {
    globalThis.clearTimeout(windowStateSyncTimer);
    windowStateSyncTimer = null;
  }
  if (windowStateResyncTimer !== null) {
    globalThis.clearTimeout(windowStateResyncTimer);
    windowStateResyncTimer = null;
  }
  unlistenWindowResized?.();
  unlistenWindowResized = null;
});
</script>
