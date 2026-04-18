<template>
  <header
    class="window-titlebar border-b border-[var(--shell-divider)]"
    @mousedown="handleStartWindowDrag"
  >
    <div
      class="grid h-10 grid-cols-[minmax(0,1fr)_minmax(240px,420px)_minmax(0,1fr)] items-center gap-3 px-3"
    >
      <div class="flex min-w-0 items-center gap-3">
        <div
          class="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--accent-muted)] text-[var(--accent-strong)]"
        >
          <svg
            viewBox="0 0 24 24"
            class="h-4 w-4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
            <path d="M14 3v5h5" />
          </svg>
        </div>

        <nav class="flex min-w-0 items-center gap-1 text-[12px] text-[var(--text-tertiary)]">
          <AppDropdownMenu
            :items="fileMenuItems"
            align="left"
            :min-width="140"
            @select="handleFileAction"
          >
            <template #trigger="{ open, toggle }">
              <button
                type="button"
                class="titlebar-menu-button"
                :class="{ 'is-open': open }"
                @click="toggle"
              >
                文件
              </button>
            </template>
          </AppDropdownMenu>

          <AppDropdownMenu
            :items="editMenuItems"
            align="left"
            :min-width="152"
            @select="handleEditAction"
          >
            <template #trigger="{ open, toggle }">
              <button
                type="button"
                class="titlebar-menu-button"
                :class="{ 'is-open': open }"
                @click="toggle"
              >
                编辑
              </button>
            </template>
          </AppDropdownMenu>

          <AppDropdownMenu
            :items="viewMenuItems"
            align="left"
            :min-width="140"
            @select="handleViewAction"
          >
            <template #trigger="{ open, toggle }">
              <button
                type="button"
                class="titlebar-menu-button"
                :class="{ 'is-open': open }"
                @click="toggle"
              >
                查看
              </button>
            </template>
          </AppDropdownMenu>

          <button type="button" class="titlebar-menu-button">选择</button>
          <button type="button" class="titlebar-menu-button">转到</button>
          <AppDropdownMenu
            :items="terminalMenuItems"
            align="left"
            :min-width="140"
            @select="handleTerminalAction"
          >
            <template #trigger="{ open, toggle }">
              <button
                type="button"
                class="titlebar-menu-button"
                :class="{ 'is-open': open }"
                @click="toggle"
              >
                终端
              </button>
            </template>
          </AppDropdownMenu>
          <button type="button" class="titlebar-menu-button">帮助</button>
        </nav>
      </div>

      <div class="flex justify-center" data-tauri-drag-region @dblclick="handleToggleMaximize">
        <div class="window-command-bar w-full justify-center text-[12px]">
          <svg
            viewBox="0 0 24 24"
            class="h-4 w-4 text-[var(--text-quaternary)]"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="11" cy="11" r="6.5" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <span class="truncate">my_desktop_app</span>
        </div>
      </div>

      <div class="flex min-w-0 items-center justify-end gap-2">
        <span
          class="app-tooltip-target inline-flex"
          :data-tooltip="runButtonTooltip"
          data-tooltip-placement="bottom"
        >
          <button
            type="button"
            class="titlebar-run-button"
            :disabled="isRunning || !isDesktopRuntime || !canRun"
            aria-label="运行脚本"
            @click="$emit('run')"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="1em"
              height="1em"
              viewBox="0 0 16 16"
              class="titlebar-run-icon h-5 w-5"
              aria-hidden="true"
            >
              <path
                fill="currentColor"
                d="M4.506 3.503L12.501 8l-8 4.5zm-.004-1.505C3.718 1.998 3 2.626 3 3.5v9c0 .874.718 1.502 1.502 1.502c.245 0 .496-.061.733-.195l8-4.5c1.019-.573 1.019-2.041 0-2.615l-8-4.499a1.5 1.5 0 0 0-.733-.195"
              />
            </svg>
          </button>
        </span>

        <button
          v-if="!isTerminalVisible"
          type="button"
          class="icon-button app-tooltip-target"
          :disabled="!isDesktopRuntime"
          :data-tooltip="terminalToggleTooltip"
          data-tooltip-placement="bottom"
          :aria-label="terminalToggleTooltip"
          @click="toggleTerminalVisibility"
        >
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            class="h-4 w-4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              d="M2.5 3.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z"
            />
            <path d="m5.2 7 1.6 1.4-1.6 1.4" />
            <path d="M8.8 10h2" />
          </svg>
        </button>

        <span class="max-w-[220px] truncate text-[11px] text-[var(--text-quaternary)]">
          {{ currentDocumentLabel }}
        </span>

        <div v-if="isDesktopRuntime" class="ml-1 flex items-center gap-0.5">
          <button
            class="window-control-button app-tooltip-target"
            type="button"
            aria-label="最小化"
            data-tooltip="最小化"
            data-tooltip-placement="bottom"
            @click="handleMinimize"
          >
            <svg viewBox="0 0 10 10" aria-hidden="true" class="h-3.5 w-3.5">
              <path
                d="M1 5h8"
                fill="none"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-width="1.2"
              />
            </svg>
          </button>

          <button
            class="window-control-button app-tooltip-target"
            type="button"
            :aria-label="isMaximized ? '向下还原' : '最大化'"
            :data-tooltip="isMaximized ? '向下还原' : '最大化'"
            data-tooltip-placement="bottom"
            @click="handleToggleMaximize"
          >
            <svg v-if="!isMaximized" viewBox="0 0 10 10" aria-hidden="true" class="h-3.5 w-3.5">
              <rect
                x="1.5"
                y="1.5"
                width="7"
                height="7"
                fill="none"
                rx="0.5"
                stroke="currentColor"
                stroke-width="1.1"
              />
            </svg>
            <svg v-else viewBox="0 0 10 10" aria-hidden="true" class="h-3.5 w-3.5">
              <path
                d="M3 1.5h5.5V7M7 3H1.5v5.5H7z"
                fill="none"
                stroke="currentColor"
                stroke-linejoin="round"
                stroke-width="1.1"
              />
            </svg>
          </button>

          <button
            class="window-control-button app-tooltip-target"
            type="button"
            aria-label="关闭"
            data-tooltip="关闭"
            data-tooltip-placement="bottom"
            @click="$emit('close-request')"
          >
            <svg viewBox="0 0 10 10" aria-hidden="true" class="h-3.5 w-3.5">
              <path
                d="M2 2l6 6M8 2L2 8"
                fill="none"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-width="1.2"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import type { UnlistenFn } from '@tauri-apps/api/event';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AppDropdownMenu from '@/components/common/AppDropdownMenu.vue';
import { waitForDesktopRuntime } from '@/utils/desktop-runtime';
import type { TThemeMode } from '@/types/app';
import type { ICommandTemplate } from '@/types/editor';

const props = defineProps<{
  documentName: string;
  isDirty: boolean;
  documentKind: 'text' | 'image';
  theme: TThemeMode;
  isRunning: boolean;
  canRun: boolean;
  canSave: boolean;
  isDesktopRuntime: boolean;
  isTerminalVisible: boolean;
  commandTemplates: ICommandTemplate[];
  commentTemplates: ICommandTemplate[];
}>();

const emit = defineEmits<{
  new: [];
  open: [];
  'open-folder': [];
  save: [];
  'save-as': [];
  'close-request': [];
  run: [];
  'open-terminal': [];
  'hide-terminal': [];
  'toggle-theme': [];
  'insert-template': [value: ICommandTemplate];
}>();

const isMaximized = ref(false);

const currentDocumentLabel = computed(() =>
  props.isDirty ? `${props.documentName} ●` : props.documentName,
);

const fileMenuItems = computed(() => [
  { key: 'new', label: '新建脚本' },
  {
    key: 'open',
    label: '打开文件',
    disabled: !props.isDesktopRuntime,
  },
  {
    key: 'open-folder',
    label: '打开文件夹',
    disabled: !props.isDesktopRuntime,
  },
  {
    key: 'save',
    label: '保存',
    disabled: !props.isDesktopRuntime || !props.canSave,
  },
  {
    key: 'save-as',
    label: '另存为...',
    disabled: !props.isDesktopRuntime || !props.canSave,
  },
]);

const editMenuItems = computed(() => [
  ...props.commandTemplates.map((item) => ({
    key: `template:${item.id}`,
    label: item.title,
  })),
  ...props.commentTemplates.map((item, index) => ({
    key: `template:${item.id}`,
    label: item.title,
    separatorBefore: index === 0,
  })),
]);

const viewMenuItems = computed(() => [
  {
    key: 'toggle-theme',
    label: props.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题',
  },
]);

const terminalMenuItems = computed(() => [
  {
    key: 'toggle-terminal',
    label: props.isTerminalVisible ? '隐藏终端' : '打开终端',
  },
]);

const runButtonTooltip = computed(() => {
  if (props.isRunning) {
    return '脚本执行中';
  }

  if (!props.isDesktopRuntime) {
    return '当前仅浏览器预览，无法直接执行';
  }

  if (!props.canRun) {
    return props.documentKind === 'image' ? '图片预览不支持执行' : '当前脚本内容不可执行';
  }

  return '运行脚本';
});

const terminalToggleTooltip = computed(() => {
  if (!props.isDesktopRuntime) {
    return '仅桌面端可用';
  }

  return '打开终端';
});

let unlistenResize: UnlistenFn | null = null;

const getAppWindow = async () => {
  const runtimeReady = await waitForDesktopRuntime();
  if (!runtimeReady) {
    return null;
  }

  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
};

const syncWindowState = async (): Promise<void> => {
  const appWindow = await getAppWindow();
  if (!appWindow) {
    return;
  }

  try {
    isMaximized.value = await appWindow.isMaximized();
  } catch (error) {
    console.warn('读取窗口最大化状态失败', error);
  }
};

const handleFileAction = (key: string): void => {
  switch (key) {
    case 'new':
      emit('new');
      break;
    case 'open':
      emit('open');
      break;
    case 'open-folder':
      emit('open-folder');
      break;
    case 'save':
      emit('save');
      break;
    case 'save-as':
      emit('save-as');
      break;
    default:
      break;
  }
};

const handleEditAction = (key: string): void => {
  const templateId = key.replace('template:', '');
  const targetTemplate = [...props.commandTemplates, ...props.commentTemplates].find(
    (item) => item.id === templateId,
  );
  if (targetTemplate) {
    emit('insert-template', targetTemplate);
  }
};

const handleViewAction = (key: string): void => {
  if (key === 'toggle-theme') {
    emit('toggle-theme');
  }
};

const handleTerminalAction = (key: string): void => {
  if (key === 'toggle-terminal') {
    if (props.isTerminalVisible) {
      emit('hide-terminal');
      return;
    }

    emit('open-terminal');
  }
};

const toggleTerminalVisibility = (): void => {
  if (!props.isDesktopRuntime) {
    return;
  }

  if (props.isTerminalVisible) {
    emit('hide-terminal');
    return;
  }

  emit('open-terminal');
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

const handleStartWindowDrag = async (event: MouseEvent): Promise<void> => {
  if (!props.isDesktopRuntime || event.button !== 0) {
    return;
  }

  const target = event.target;
  if (
    target instanceof Element &&
    target.closest(
      'button, a, input, textarea, select, [role="button"], [role="menu"], [data-no-window-drag]',
    )
  ) {
    return;
  }

  const appWindow = await getAppWindow();
  if (!appWindow) {
    return;
  }

  try {
    await appWindow.startDragging();
  } catch (error) {
    console.warn('窗口拖动失败', error);
  }
};

onMounted(async () => {
  if (!props.isDesktopRuntime) {
    return;
  }

  const appWindow = await getAppWindow();
  if (!appWindow) {
    return;
  }

  await syncWindowState();
  unlistenResize = await appWindow.onResized(() => {
    void syncWindowState();
  });
});

onBeforeUnmount(() => {
  if (unlistenResize) {
    unlistenResize();
    unlistenResize = null;
  }
});
</script>
