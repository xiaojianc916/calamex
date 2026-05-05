<template>
    <div class="app-surface h-screen">
        <div class="app-window-shell relative flex h-full flex-col overflow-hidden border border-(--shell-divider)">
            <template v-if="isDesktopRuntime">
                <div v-for="handle in resizeHandles" :key="handle.direction" class="window-resize-handle"
                    :class="handle.className" @mousedown.prevent.stop="startWindowResize(handle.direction, $event)" />
            </template>

            <slot name="titlebar" />

            <div class="relative flex min-h-0 flex-1 overflow-hidden bg-(--editor-bg)">
                <aside
                    class="app-shell-pane min-h-0 overflow-hidden border-r border-(--shell-divider) bg-(--sidebar-bg) transition-[width,opacity] duration-200"
                    :class="props.sidebarVisible ? 'opacity-100' : 'pointer-events-none opacity-0'"
                    :style="sidebarStyle">
                    <slot name="sidebar" />
                </aside>

                <div class="app-shell-pane flex min-h-0 flex-1 flex-col overflow-hidden bg-(--editor-bg)">
                    <slot name="header" />

                    <main ref="mainRef" class="flex min-h-0 flex-1 flex-col overflow-hidden">
                        <section class="editor-surface min-h-0 flex-1 overflow-hidden">
                            <slot />
                        </section>

                        <button v-if="props.terminalVisible" type="button" class="terminal-resize-handle"
                            aria-label="调整终端高度" @mousedown.prevent="startTerminalResize">
                            <span class="terminal-resize-handle-bar" />
                        </button>

                        <section v-show="props.terminalVisible"
                            class="app-shell-pane min-h-0 overflow-hidden bg-(--panel-bg)" :style="terminalPaneStyle">
                            <slot name="terminal" />
                        </section>
                    </main>
                </div>

                <div v-if="props.contentOverlayVisible" class="pointer-events-none absolute inset-y-0 right-0 z-35">
                    <div class="pointer-events-auto h-full min-h-0">
                        <slot name="overlay" />
                    </div>
                </div>
            </div>

            <slot name="statusbar" />
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    SHELL_WINDOW_RESIZE_END_EVENT,
    SHELL_WINDOW_RESIZE_START_EVENT,
} from '@/utils/window-resize-events';
import { computed, onBeforeUnmount, ref } from 'vue';

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
const SIDEBAR_MIN_WIDTH = 240;

const props = withDefaults(
    defineProps<{
        isDesktopRuntime?: boolean;
        activityVisible?: boolean;
        sidebarVisible?: boolean;
        terminalVisible?: boolean;
        terminalHeight?: number;
        sidebarWidth?: number;
        contentOverlayVisible?: boolean;
    }>(),
    {
        isDesktopRuntime: false,
        activityVisible: false,
        sidebarVisible: true,
        terminalVisible: true,
        terminalHeight: 236,
        sidebarWidth: 288,
        contentOverlayVisible: false,
    },
);

const emit = defineEmits<{
    'update:terminalHeight': [value: number];
}>();

const mainRef = ref<HTMLElement | null>(null);
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
    const maxHeight = Math.max(TERMINAL_MIN_HEIGHT, availableHeight - EDITOR_MIN_HEIGHT);

    return Math.min(maxHeight, Math.max(TERMINAL_MIN_HEIGHT, Math.round(rawHeight)));
};

const resolvedSidebarWidth = computed(() =>
    props.sidebarVisible ? Math.max(SIDEBAR_MIN_WIDTH, Math.round(props.sidebarWidth)) : 0,
);

const resolvedTerminalHeight = computed(() =>
    props.terminalVisible ? clampTerminalHeight(props.terminalHeight) : 0,
);

const sidebarStyle = computed(() => ({
    width: `${resolvedSidebarWidth.value}px`,
    minWidth: `${resolvedSidebarWidth.value}px`,
    maxWidth: `${resolvedSidebarWidth.value}px`,
}));

const terminalPaneStyle = computed(() => ({
    height: `${resolvedTerminalHeight.value}px`,
}));

const startTerminalResize = (event: MouseEvent): void => {
    if (!props.terminalVisible || !mainRef.value || event.button !== 0) {
        return;
    }

    terminalResizeCleanup?.();

    const startY = event.clientY;
    const startHeight = clampTerminalHeight(props.terminalHeight);
    window.dispatchEvent(new Event(SHELL_WINDOW_RESIZE_START_EVENT));

    const handleMouseMove = (moveEvent: MouseEvent): void => {
        const nextHeight = clampTerminalHeight(startHeight + (startY - moveEvent.clientY));
        emit('update:terminalHeight', nextHeight);
    };

    const stopResize = (): void => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', stopResize);
        window.removeEventListener('blur', stopResize);
        terminalResizeCleanup = null;
        window.dispatchEvent(new Event(SHELL_WINDOW_RESIZE_END_EVENT));
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

    window.dispatchEvent(new Event(SHELL_WINDOW_RESIZE_START_EVENT));

    try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().startResizeDragging(direction);
    } catch (error) {
        window.dispatchEvent(new Event(SHELL_WINDOW_RESIZE_END_EVENT));
        console.warn('窗口边缘拉伸失败', error);
    }
};

onBeforeUnmount(() => {
    terminalResizeCleanup?.();
});
</script>
