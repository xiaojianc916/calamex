<template>
  <header class="window-titlebar" @mousedown="handleStartWindowDrag">
    <div class="grid h-10 grid-cols-[minmax(0,1fr)_minmax(240px,420px)_minmax(0,1fr)] items-center gap-3 px-3">
      <div class="flex min-w-0 items-center gap-3">
        <div class="flex h-6 w-6 items-center justify-center rounded-md bg-(--accent-muted) text-(--accent-strong)">
          <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
            <path d="M14 3v5h5" />
          </svg>
        </div>

        <nav class="flex min-w-0 items-center gap-1 text-[12px] text-(--text-tertiary)">
          <AppDropdownMenu v-for="menu in menubarMenus" :key="menu.key" :items="menu.items" align="left"
            variant="menubar" :min-width="menu.minWidth" :open="openMenuKey === menu.key"
            @update:open="handleMenuOpenChange(menu.key, $event)" @select="handleMenuSelect(menu.key, $event)">
            <template #trigger="{ open }">
              <button type="button" class="menubar-menu-item" :class="{ 'is-open': open }" data-no-window-drag
                @mouseenter="handleMenuTriggerMouseEnter(menu.key)">
                {{ menu.label }}
              </button>
            </template>
          </AppDropdownMenu>
        </nav>
      </div>

      <div ref="commandPaletteRef" class="relative flex justify-center" data-no-window-drag @dblclick.stop>
        <button v-if="!isCommandPaletteOpen" type="button" class="window-command-bar w-full justify-center text-[12px]"
          aria-label="打开命令面板" aria-haspopup="dialog" :aria-expanded="isCommandPaletteOpen" data-no-window-drag
          @click="openCommandPalette">
          <svg viewBox="0 0 24 24" class="h-4 w-4 text-(--text-quaternary)" fill="none" stroke="currentColor"
            stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="6.5" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <span class="window-command-bar-placeholder truncate"></span>
        </button>

        <div v-else class="titlebar-command-palette" role="dialog" aria-label="命令面板" data-no-window-drag>
          <label class="titlebar-command-palette-search">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"
              stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="6.5" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            <input ref="commandPaletteInputRef" v-model="commandPaletteQuery" type="text" placeholder="输入命令或搜索…"
              autocomplete="off" @keydown.down.prevent="moveCommandPaletteActive(1)"
              @keydown.up.prevent="moveCommandPaletteActive(-1)"
              @keydown.enter.prevent="executeActiveCommandPaletteAction" @keydown.esc.prevent="closeCommandPalette" />
          </label>

          <div class="titlebar-command-palette-body" role="listbox" aria-label="可用命令">
            <template v-if="filteredCommandPaletteActions.length > 0">
              <button v-for="(action, index) in filteredCommandPaletteActions" :key="action.id" type="button"
                class="titlebar-command-palette-item"
                :class="{ 'is-active': index === commandPaletteActiveIndex, 'is-disabled': action.disabled }"
                role="option" :aria-selected="index === commandPaletteActiveIndex" :disabled="action.disabled"
                @mouseenter="commandPaletteActiveIndex = index" @click="executeCommandPaletteAction(action)">
                <span class="titlebar-command-palette-icon" aria-hidden="true">
                  <LinearContextMenuIcon :icon="action.icon" />
                </span>
                <span class="titlebar-command-palette-main">
                  <span class="titlebar-command-palette-label">{{ action.label }}</span>
                </span>
                <span class="titlebar-command-palette-shortcut">{{ action.shortcutLabel }}</span>
              </button>
            </template>
            <div v-else class="titlebar-command-palette-empty">未找到匹配命令</div>
          </div>

          <div class="titlebar-command-palette-footer" aria-hidden="true">
            <span><kbd>↑</kbd><kbd>↓</kbd> 导航</span>
            <span><kbd>↵</kbd> 执行</span>
            <span class="ml-auto"><kbd>Esc</kbd> 关闭</span>
          </div>
        </div>
      </div>

      <div class="flex min-w-0 items-center justify-end gap-2">
        <button type="button" class="icon-button relative app-tooltip-target border border-transparent"
          :class="terminalToggleButtonClass" :disabled="!isDesktopRuntime"
          :data-tooltip="isTerminalToggleDisabled ? undefined : terminalToggleTooltip" data-tooltip-placement="bottom"
          :aria-label="terminalToggleTooltip" @click="toggleTerminalVisibility">
          <svg viewBox="0 0 16 16" aria-hidden="true" class="h-4 w-4" fill="none" stroke="currentColor"
            stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2.5 3.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z" />
            <path d="m5.2 7 1.6 1.4-1.6 1.4" />
            <path d="M8.8 10h2" />
          </svg>
        </button>

        <span class="app-tooltip-target inline-flex" :data-tooltip="isRunButtonDisabled ? undefined : runButtonTooltip"
          data-tooltip-placement="bottom">
          <button type="button" class="titlebar-run-button" :disabled="isRunButtonDisabled" aria-label="运行脚本"
            @click="$emit('run')">
            <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 16 16"
              class="titlebar-run-icon h-5 w-5" aria-hidden="true">
              <path fill="currentColor"
                d="M4.506 3.503L12.501 8l-8 4.5zm-.004-1.505C3.718 1.998 3 2.626 3 3.5v9c0 .874.718 1.502 1.502 1.502c.245 0 .496-.061.733-.195l8-4.5c1.019-.573 1.019-2.041 0-2.615l-8-4.499a1.5 1.5 0 0 0-.733-.195" />
            </svg>
          </button>
        </span>

        <button type="button" class="icon-button app-tooltip-target border border-transparent"
          data-tooltip="AI 助手" data-tooltip-placement="bottom" aria-label="AI 助手"
          @click="$emit('select-sidebar-view', 'ai')">
          <svg viewBox="0 0 24 24" aria-hidden="true" class="h-4 w-4" fill="none" stroke="currentColor"
            stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z" />
            <path d="M18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9L18 15z" />
          </svg>
        </button>

        <span class="max-w-55 truncate text-[11px] text-(--text-quaternary)">
          {{ currentDocumentLabel }}
        </span>

        <div v-if="isDesktopRuntime" class="ml-1 flex items-center gap-0.5">
          <button class="window-control-button" type="button" aria-label="最小化" @click="handleMinimize">
            <svg viewBox="0 0 10 10" aria-hidden="true" class="h-3.5 w-3.5">
              <path d="M1 5h8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.2" />
            </svg>
          </button>

          <button class="window-control-button" type="button"
            :aria-label="isMaximized ? '向下还原' : '最大化'" @click="handleToggleMaximize">
            <svg v-if="!isMaximized" viewBox="0 0 10 10" aria-hidden="true" class="h-3.5 w-3.5">
              <rect x="1.5" y="1.5" width="7" height="7" fill="none" rx="0.5" stroke="currentColor"
                stroke-width="1.1" />
            </svg>
            <svg v-else viewBox="0 0 10 10" aria-hidden="true" class="h-3.5 w-3.5">
              <path d="M3 1.5h5.5V7M7 3H1.5v5.5H7z" fill="none" stroke="currentColor" stroke-linejoin="round"
                stroke-width="1.1" />
            </svg>
          </button>

          <button class="window-control-button app-tooltip-target" type="button" aria-label="关闭" data-tooltip="关闭"
            data-tooltip-placement="bottom" @click="$emit('close-request')">
            <svg viewBox="0 0 10 10" aria-hidden="true" class="h-3.5 w-3.5">
              <path d="M2 2l6 6M8 2L2 8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.2" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import AppDropdownMenu from '@/components/common/AppDropdownMenu.vue';
import LinearContextMenuIcon from '@/components/common/LinearContextMenuIcon.vue';
import type { TLinearContextMenuIcon } from '@/components/common/linear-context-menu.types';
import { useMessage } from '@/composables/useMessage';
import type { TThemeMode, TWorkbenchSidebarView } from '@/types/app';
import type { ICommandTemplate } from '@/types/editor';
import { waitForDesktopRuntime } from '@/utils/desktop-runtime';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

type TTitlebarMenuKey = 'file' | 'edit' | 'view' | 'select' | 'goto' | 'terminal' | 'ai' | 'help';
const RESIZE_EDGE_PX = 4;

interface ITitlebarMenuItem {
  key: string;
  label: string;
  description?: string;
  shortcut?: string;
  disabled?: boolean;
  selected?: boolean;
  separatorBefore?: boolean;
  hasSubmenu?: boolean;
  children?: ITitlebarMenuItem[];
  tone?: 'default' | 'danger';
}

interface ITitlebarMenuDefinition {
  key: TTitlebarMenuKey;
  label: string;
  minWidth: number;
  items: ITitlebarMenuItem[];
}

interface ICommandPaletteAction {
  id: string;
  menuKey: TTitlebarMenuKey;
  itemKey: string;
  label: string;
  groupLabel: string;
  shortcut?: string;
  disabled: boolean;
  searchText: string;
  icon: TLinearContextMenuIcon;
  shortcutLabel: string;
}

const props = defineProps<{
  documentName: string;
  hasActiveDocument: boolean;
  isDirty: boolean;
  documentKind: 'text' | 'image';
  theme: TThemeMode;
  isRunning: boolean;
  canRun: boolean;
  canSave: boolean;
  isDesktopRuntime: boolean;
  isTerminalVisible: boolean;
  isDiagnosticsVisible: boolean;
  canToggleDiagnostics: boolean;
  diagnosticIssueCount: number;
  commandTemplates: ICommandTemplate[];
  commentTemplates: ICommandTemplate[];
}>();

const emit = defineEmits<{
  new: [];
  open: [];
  'open-folder': [];
  'close-workspace': [];
  'format-document': [];
  save: [];
  'save-as': [];
  'close-request': [];
  run: [];
  'open-terminal': [];
  'hide-terminal': [];
  'toggle-diagnostics': [];
  'toggle-theme': [];
  'select-sidebar-view': [view: TWorkbenchSidebarView];
  'insert-template': [value: ICommandTemplate];
  'ai-code-action': [kind: 'explain_selection' | 'fix_diagnostic' | 'generate_tests'];
}>();

const message = useMessage();
const isMaximized = ref(false);
const openMenuKey = ref<TTitlebarMenuKey | null>(null);
const isCommandPaletteOpen = ref(false);
const commandPaletteQuery = ref('');
const commandPaletteActiveIndex = ref(0);
const commandPaletteRef = ref<HTMLElement | null>(null);
const commandPaletteInputRef = ref<HTMLInputElement | null>(null);

const currentDocumentLabel = computed(() => {
  if (!props.hasActiveDocument) {
    return '未打开文件';
  }

  return props.documentName;
});

const isTerminalToggleDisabled = computed(() => !props.isDesktopRuntime);
const isRunButtonDisabled = computed(
  () => props.isRunning || !props.isDesktopRuntime || !props.canRun,
);

const terminalToggleButtonClass = computed(() => {
  if (isTerminalToggleDisabled.value) {
    return 'is-inert-control opacity-45';
  }

  if (props.isTerminalVisible) {
    return 'border-white/10 bg-white/[0.06] text-[var(--text-primary)]';
  }

  return '';
});

const fileMenuItems = computed(() => [
  { key: 'new', label: '新建脚本', shortcut: 'N' },
  {
    key: 'open',
    label: '打开文件',
    shortcut: 'O',
    disabled: !props.isDesktopRuntime,
  },
  {
    key: 'open-folder',
    label: '打开文件夹',
    shortcut: '⇧O',
    disabled: !props.isDesktopRuntime,
  },
  {
    key: 'close-workspace',
    label: '关闭工作区',
    shortcut: 'W',
    separatorBefore: true,
  },
  {
    key: 'save',
    label: '保存',
    shortcut: 'S',
    separatorBefore: true,
    disabled: !props.isDesktopRuntime || !props.canSave,
  },
  {
    key: 'save-as',
    label: '另存为…',
    shortcut: '⇧S',
    disabled: !props.isDesktopRuntime || !props.canSave,
  },
]);

const editMenuItems = computed(() => [
  {
    key: 'undo',
    label: '撤销',
    shortcut: '⌘Z',
    disabled: !props.hasActiveDocument,
  },
  {
    key: 'redo',
    label: '恢复撤销',
    shortcut: 'Z',
    disabled: !props.hasActiveDocument,
  },
  {
    key: 'cut',
    label: '剪切',
    shortcut: 'X',
    separatorBefore: true,
    disabled: !props.hasActiveDocument,
  },
  {
    key: 'copy',
    label: '复制',
    shortcut: 'C',
    disabled: !props.hasActiveDocument,
  },
  {
    key: 'paste',
    label: '粘贴',
    shortcut: 'V',
    disabled: !props.hasActiveDocument,
  },
  {
    key: 'find',
    label: '查找',
    shortcut: 'F',
    separatorBefore: true,
    disabled: !props.hasActiveDocument || props.documentKind !== 'text',
  },
  {
    key: 'replace',
    label: '替换',
    shortcut: '⌥F',
    disabled: !props.hasActiveDocument || props.documentKind !== 'text',
  },
  {
    key: 'format-document',
    label: 'shfmt 格式化',
    separatorBefore: true,
    disabled: !props.canSave || props.documentKind !== 'text',
  },
  {
    key: 'template-group:command',
    label: '通用代码',
    hasSubmenu: true,
    separatorBefore: true,
    disabled: props.commandTemplates.length === 0,
    children: props.commandTemplates.map((item) => ({
      key: `template:${item.id}`,
      label: item.title,
    })),
  },
  {
    key: 'template-group:comment',
    label: '通用注释',
    hasSubmenu: true,
    disabled: props.commentTemplates.length === 0,
    children: props.commentTemplates.map((item) => ({
      key: `template:${item.id}`,
      label: item.title,
    })),
  },
]);

const viewMenuItems = computed(() => [
  {
    key: 'command-palette',
    label: '命令面板',
    shortcut: 'P',
  },
  {
    key: 'sidebar:explorer',
    label: '资源管理器',
    shortcut: 'B',
    separatorBefore: true,
  },
  {
    key: 'sidebar:search',
    label: '搜索',
    shortcut: 'F',
  },
  {
    key: 'sidebar:source-control',
    label: '源代码管理',
    shortcut: 'G',
  },
  {
    key: 'toggle-terminal',
    label: '终端',
    shortcut: '',
    selected: props.isTerminalVisible,
  },
  {
    key: 'toggle-diagnostics',
    label: '代码检查',
    separatorBefore: true,
    disabled: !props.canToggleDiagnostics,
    selected: props.isDiagnosticsVisible,
  },
  {
    key: 'toggle-fullscreen',
    label: '切换全屏',
    shortcut: 'F',
    separatorBefore: true,
    disabled: !props.isDesktopRuntime,
  },
  {
    key: 'toggle-theme',
    label: '外观',
    hasSubmenu: true,
  },
]);

const selectMenuItems = computed(() => [
  { key: 'select-all', label: '全选', shortcut: '⌘A', disabled: !props.hasActiveDocument },
  {
    key: 'expand-selection',
    label: '展开选区',
    shortcut: '⌃→',
    disabled: !props.hasActiveDocument || props.documentKind !== 'text',
  },
  {
    key: 'shrink-selection',
    label: '收缩选区',
    shortcut: '⌃←',
    disabled: !props.hasActiveDocument || props.documentKind !== 'text',
  },
  {
    key: 'cursor-above',
    label: '在上方添加光标',
    shortcut: '⌥↑',
    separatorBefore: true,
    disabled: !props.hasActiveDocument || props.documentKind !== 'text',
  },
  {
    key: 'cursor-below',
    label: '在下方添加光标',
    shortcut: '⌥↓',
    disabled: !props.hasActiveDocument || props.documentKind !== 'text',
  },
  {
    key: 'select-all-matches',
    label: '选中所有匹配项',
    shortcut: 'L',
    disabled: !props.hasActiveDocument || props.documentKind !== 'text',
  },
]);

const gotoMenuItems = computed(() => [
  { key: 'navigate-back', label: '返回', shortcut: '⌃-' },
  { key: 'navigate-forward', label: '前进', shortcut: '⌃⇧-' },
  { key: 'goto-file', label: '转到文件…', shortcut: '⌘P', separatorBefore: true },
  { key: 'goto-symbol', label: '转到符号…', shortcut: '⇧⌘O', disabled: !props.hasActiveDocument },
  { key: 'goto-definition', label: '转到定义', shortcut: 'F12', disabled: !props.hasActiveDocument },
  { key: 'goto-references', label: '转到引用', shortcut: '⇧F12', disabled: !props.hasActiveDocument },
  { key: 'goto-line', label: '转到行/列…', shortcut: '⌃G', separatorBefore: true, disabled: !props.hasActiveDocument },
  { key: 'next-problem', label: '下一个问题', shortcut: 'F8', disabled: props.diagnosticIssueCount === 0 },
  { key: 'prev-problem', label: '上一个问题', shortcut: '⇧F8', disabled: props.diagnosticIssueCount === 0 },
]);

const terminalMenuItems = computed(() => [
  {
    key: 'new-terminal',
    label: '新建终端',
    shortcut: '⌃⇧`',
    disabled: !props.isDesktopRuntime,
  },
  {
    key: 'split-terminal',
    label: '拆分终端',
    shortcut: '\\',
    disabled: !props.isDesktopRuntime,
  },
  {
    key: 'run-task',
    label: '运行任务…',
    shortcut: 'B',
    separatorBefore: true,
  },
  {
    key: 'build-task',
    label: '运行生成任务',
    shortcut: 'B',
  },
  {
    key: 'run-active-file',
    label: '运行活动文件',
    separatorBefore: true,
    disabled: isRunButtonDisabled.value,
  },
  {
    key: 'run-selection',
    label: '运行选定文本',
    disabled: !props.hasActiveDocument || props.documentKind !== 'text',
  },
  {
    key: 'terminate-task',
    label: '终止任务',
    separatorBefore: true,
    disabled: true,
  },
  {
    key: 'configure-task',
    label: '配置任务…',
  },
]);

const aiMenuItems = computed(() => [
  {
    key: 'ai-explain-selection',
    label: 'AI 解释选区',
    disabled: !props.hasActiveDocument || props.documentKind !== 'text',
  },
  {
    key: 'ai-fix-diagnostic',
    label: 'AI 修复诊断',
    disabled: !props.hasActiveDocument || props.documentKind !== 'text',
  },
  {
    key: 'ai-generate-tests',
    label: 'AI 生成测试',
    disabled: !props.hasActiveDocument || props.documentKind !== 'text',
  },
]);

const helpMenuItems = computed(() => [
  { key: 'welcome', label: '欢迎' },
  { key: 'walkthrough', label: '交互式演练' },
  { key: 'documentation', label: '文档' },
  { key: 'shortcuts', label: '快捷键参考', shortcut: 'K S' },
  { key: 'report-issue', label: '报告问题', separatorBefore: true },
  { key: 'license', label: '查看许可证' },
  { key: 'check-updates', label: '检查更新…' },
  { key: 'about', label: '关于', separatorBefore: true },
]);

const menubarMenus = computed<ITitlebarMenuDefinition[]>(() => [
  { key: 'file', label: '文件', minWidth: 220, items: fileMenuItems.value },
  { key: 'edit', label: '编辑', minWidth: 240, items: editMenuItems.value },
  { key: 'view', label: '查看', minWidth: 220, items: viewMenuItems.value },
  { key: 'select', label: '选择', minWidth: 240, items: selectMenuItems.value },
  { key: 'goto', label: '转到', minWidth: 220, items: gotoMenuItems.value },
  { key: 'terminal', label: '终端', minWidth: 240, items: terminalMenuItems.value },
  { key: 'ai', label: 'AI', minWidth: 220, items: aiMenuItems.value },
  { key: 'help', label: '帮助', minWidth: 220, items: helpMenuItems.value },
]);


const DEFAULT_COMMAND_PALETTE_SHORTCUT = 'Enter';

const resolveCommandPaletteIcon = (menuKey: TTitlebarMenuKey, itemKey: string): TLinearContextMenuIcon => {
  if (itemKey.includes('undo')) return 'undo';
  if (itemKey.includes('redo')) return 'redo';
  if (itemKey.includes('format')) return 'format';
  if (itemKey.includes('find') || itemKey.includes('search')) return 'search';
  if (itemKey.includes('goto') || itemKey.includes('navigate') || itemKey.includes('problem')) return 'goto';
  if (itemKey.includes('terminal')) return 'command';
  if (itemKey.includes('run') || itemKey.includes('task')) return 'command';
  if (itemKey.includes('theme')) return 'check';
  if (itemKey.includes('save')) return 'check';
  if (itemKey.includes('open')) return 'open-external';
  if (itemKey.includes('new')) return 'plus';
  if (itemKey.includes('close')) return 'minus';
  if (itemKey.includes('cut')) return 'cut';
  if (itemKey.includes('copy')) return 'copy';
  if (itemKey.includes('paste')) return 'paste';
  if (itemKey.includes('select')) return 'select-all';
  if (itemKey.includes('template') || itemKey.includes('comment')) return 'comment';
  if (menuKey === 'help') return 'link';
  return 'command';
};

const resolveCommandPaletteShortcut = (shortcut: string | undefined): string =>
  shortcut && shortcut.trim().length > 0 ? shortcut : DEFAULT_COMMAND_PALETTE_SHORTCUT;

const commandPaletteActions = computed<ICommandPaletteAction[]>(() =>
  menubarMenus.value.flatMap((menu) =>
    menu.items.flatMap((item) => {
      if (item.children?.length) {
        return item.children.map((child) => ({
          id: `${menu.key}:${child.key}`,
          menuKey: menu.key,
          itemKey: child.key,
          label: child.label,
          groupLabel: `${menu.label} / ${item.label}`,
          shortcut: child.shortcut,
          disabled: Boolean(item.disabled || child.disabled),
          icon: resolveCommandPaletteIcon(menu.key, child.key),
          shortcutLabel: resolveCommandPaletteShortcut(child.shortcut),
          searchText: `${child.label} ${item.label} ${menu.label} ${child.shortcut ?? ''}`.toLowerCase(),
        }));
      }

      return [{
        id: `${menu.key}:${item.key}`,
        menuKey: menu.key,
        itemKey: item.key,
        label: item.label,
        groupLabel: menu.label,
        shortcut: item.shortcut,
        disabled: Boolean(item.disabled),
        icon: resolveCommandPaletteIcon(menu.key, item.key),
        shortcutLabel: resolveCommandPaletteShortcut(item.shortcut),
        searchText: `${item.label} ${menu.label} ${item.shortcut ?? ''}`.toLowerCase(),
      }];
    }),
  ),
);

const normalizedCommandPaletteQuery = computed(() => commandPaletteQuery.value.trim().toLowerCase());

const filteredCommandPaletteActions = computed(() => {
  const query = normalizedCommandPaletteQuery.value;
  if (!query) {
    return commandPaletteActions.value;
  }

  return commandPaletteActions.value.filter((action) => action.searchText.includes(query));
});
const openCommandPalette = (): void => {
  closeMenubarMenus();
  isCommandPaletteOpen.value = true;
};

const closeCommandPalette = (): void => {
  isCommandPaletteOpen.value = false;
  commandPaletteQuery.value = '';
  commandPaletteActiveIndex.value = 0;
};

const moveCommandPaletteActive = (delta: number): void => {
  const enabledActions = filteredCommandPaletteActions.value.filter((action) => !action.disabled);
  if (enabledActions.length === 0) {
    commandPaletteActiveIndex.value = 0;
    return;
  }

  const currentAction = filteredCommandPaletteActions.value[commandPaletteActiveIndex.value];
  const currentEnabledIndex = currentAction
    ? enabledActions.findIndex((action) => action.id === currentAction.id)
    : -1;
  const nextEnabledIndex = (currentEnabledIndex + delta + enabledActions.length) % enabledActions.length;
  const nextAction = enabledActions[nextEnabledIndex];
  const nextIndex = nextAction
    ? filteredCommandPaletteActions.value.findIndex((action) => action.id === nextAction.id)
    : 0;
  commandPaletteActiveIndex.value = Math.max(nextIndex, 0);
};

const executeCommandPaletteAction = (action: ICommandPaletteAction): void => {
  if (action.disabled) {
    return;
  }

  closeCommandPalette();
  handleMenuSelect(action.menuKey, action.itemKey);
};

const executeActiveCommandPaletteAction = (): void => {
  const action = filteredCommandPaletteActions.value[commandPaletteActiveIndex.value];
  if (!action) {
    return;
  }

  executeCommandPaletteAction(action);
};

const handleDocumentPointerDown = (event: PointerEvent): void => {
  if (!isCommandPaletteOpen.value) {
    return;
  }

  const target = event.target;
  if (target instanceof Node && commandPaletteRef.value?.contains(target)) {
    return;
  }

  closeCommandPalette();
};

const handleDocumentKeyDown = (event: KeyboardEvent): void => {
  const isCommandPaletteShortcut = (event.metaKey || event.ctrlKey) && (event.key === 'k' || event.key === 'p');
  if (!isCommandPaletteShortcut) {
    return;
  }

  event.preventDefault();
  openCommandPalette();
};

const resolveMenuItemLabel = (menuKey: TTitlebarMenuKey, itemKey: string): string =>
  menubarMenus.value.find((menu) => menu.key === menuKey)?.items.find((item) => item.key === itemKey)?.label ?? itemKey;

const runButtonTooltip = computed(() => {
  if (props.isRunning) {
    return '脚本正在执行';
  }

  if (!props.isDesktopRuntime) {
    return '当前为浏览器预览，无法直接执行';
  }

  if (!props.hasActiveDocument) {
    return '请先打开脚本';
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

  return props.isTerminalVisible ? '隐藏终端' : '打开终端';
});

let unlistenResize: UnlistenFn | null = null;
let isTitlebarUnmounted = false;

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
  if (!appWindow || isTitlebarUnmounted) {
    return;
  }

  try {
    const nextIsMaximized = await appWindow.isMaximized();
    if (!isTitlebarUnmounted) {
      isMaximized.value = nextIsMaximized;
    }
  } catch (error) {
    console.warn('读取窗口最大化状态失败', error);
  }
};

const handleMenuOpenChange = (menuKey: TTitlebarMenuKey, open: boolean): void => {
  if (open) {
    openMenuKey.value = menuKey;
    return;
  }

  if (openMenuKey.value === menuKey) {
    openMenuKey.value = null;
  }
};

const handleMenuTriggerMouseEnter = (menuKey: TTitlebarMenuKey): void => {
  if (openMenuKey.value && openMenuKey.value !== menuKey) {
    openMenuKey.value = menuKey;
  }
};

const closeMenubarMenus = (): void => {
  openMenuKey.value = null;
};

const showPendingMessage = (label: string): void => {
  message.info(`${label} 待接入`);
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
    case 'close-workspace':
      emit('close-workspace');
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
  switch (key) {
    case 'format-document':
      emit('format-document');
      return;
    case 'undo':
    case 'redo':
    case 'cut':
    case 'copy':
    case 'paste':
    case 'find':
    case 'replace':
      showPendingMessage(resolveMenuItemLabel('edit', key));
      return;
    default:
      break;
  }

  const templateId = key.replace('template:', '');
  const targetTemplate = [...props.commandTemplates, ...props.commentTemplates].find((item) => item.id === templateId);
  if (targetTemplate) {
    emit('insert-template', targetTemplate);
  }
};

const handleViewAction = (key: string): void => {
  if (key.startsWith('sidebar:')) {
    emit('select-sidebar-view', key.replace('sidebar:', '') as TWorkbenchSidebarView);
    return;
  }

  switch (key) {
    case 'command-palette':
      openCommandPalette();
      return;
    case 'toggle-terminal':
      toggleTerminalVisibility();
      return;
    case 'toggle-diagnostics':
      emit('toggle-diagnostics');
      return;
    case 'toggle-theme':
      emit('toggle-theme');
      return;
    case 'toggle-fullscreen':
      void handleToggleFullscreen();
      return;
    default:
      showPendingMessage(resolveMenuItemLabel('view', key));
  }
};

const handleTerminalAction = (key: string): void => {
  switch (key) {
    case 'new-terminal':
      emit('open-terminal');
      return;
    case 'run-active-file':
      emit('run');
      return;
    default:
      showPendingMessage(resolveMenuItemLabel('terminal', key));
  }
};

const handleHelpAction = (key: string): void => {
  showPendingMessage(resolveMenuItemLabel('help', key));
};

const handleAiAction = (key: string): void => {
  switch (key) {
    case 'ai-explain-selection':
      emit('ai-code-action', 'explain_selection');
      return;
    case 'ai-fix-diagnostic':
      emit('ai-code-action', 'fix_diagnostic');
      return;
    case 'ai-generate-tests':
      emit('ai-code-action', 'generate_tests');
      return;
    default:
      showPendingMessage(resolveMenuItemLabel('ai', key));
  }
};

const handleSelectAction = (key: string): void => {
  showPendingMessage(resolveMenuItemLabel('select', key));
};

const handleGotoAction = (key: string): void => {
  showPendingMessage(resolveMenuItemLabel('goto', key));
};

const handleMenuSelect = (menuKey: TTitlebarMenuKey, itemKey: string): void => {
  closeMenubarMenus();

  switch (menuKey) {
    case 'file':
      handleFileAction(itemKey);
      break;
    case 'edit':
      handleEditAction(itemKey);
      break;
    case 'view':
      handleViewAction(itemKey);
      break;
    case 'select':
      handleSelectAction(itemKey);
      break;
    case 'goto':
      handleGotoAction(itemKey);
      break;
    case 'terminal':
      handleTerminalAction(itemKey);
      break;
    case 'ai':
      handleAiAction(itemKey);
      break;
    case 'help':
      handleHelpAction(itemKey);
      break;
    default:
      break;
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

const handleToggleFullscreen = async (): Promise<void> => {
  const appWindow = await getAppWindow();
  if (!appWindow) {
    return;
  }

  try {
    const isFullscreen = await appWindow.isFullscreen();
    await appWindow.setFullscreen(!isFullscreen);
  } catch (error) {
    console.warn('窗口全屏切换失败', error);
  }
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

  // ⚠ 关键:event.currentTarget 在 await 之后会被置 null,
  // 必须在任何 await 之前把 rect 和坐标抓出来保存。
  const headerEl = event.currentTarget as HTMLElement | null;
  const rect = headerEl?.getBoundingClientRect() ?? null;
  const clientX = event.clientX;
  const clientY = event.clientY;

  const appWindow = await getAppWindow();
  if (!appWindow) {
    return;
  }

  // Bug A 修复:titlebar 外圈 8dip 分流到 resize
  if (rect) {
    let maximized = false;
    try {
      maximized = await appWindow.isMaximized();
    } catch {
      /* ignore */
    }

    if (!maximized) {
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const w = rect.width;
      const e = RESIZE_EDGE_PX;

      const direction:
        | 'North' | 'NorthEast' | 'East' | 'SouthEast'
        | 'South' | 'SouthWest' | 'West' | 'NorthWest'
        | null =
        y < e && x < e ? 'NorthWest'
          : y < e && x > w - e ? 'NorthEast'
            : y < e ? 'North'
              : x < e ? 'West'
                : x > w - e ? 'East'
                  : null;

      if (direction) {
        try {
          await appWindow.startResizeDragging(direction);
        } catch (error) {
          console.warn('窗口 resize 拖动失败', error);
        }
        return;
      }
    }
  }

  try {
    await appWindow.startDragging();
  } catch (error) {
    console.warn('窗口拖动失败', error);
  }
};

watch(isCommandPaletteOpen, (open) => {
  if (!open) {
    return;
  }

  void nextTick(() => {
    commandPaletteInputRef.value?.focus();
  });
});

watch(filteredCommandPaletteActions, (actions) => {
  if (actions.length === 0) {
    commandPaletteActiveIndex.value = 0;
    return;
  }

  if (commandPaletteActiveIndex.value >= actions.length) {
    commandPaletteActiveIndex.value = actions.findIndex((action) => !action.disabled);
  }

  if (commandPaletteActiveIndex.value < 0) {
    commandPaletteActiveIndex.value = 0;
  }
});

onMounted(async () => {
  isTitlebarUnmounted = false;
  document.addEventListener('pointerdown', handleDocumentPointerDown);
  document.addEventListener('keydown', handleDocumentKeyDown);

  if (!props.isDesktopRuntime) {
    return;
  }

  const appWindow = await getAppWindow();
  if (!appWindow || isTitlebarUnmounted) {
    return;
  }

  await syncWindowState();
  if (isTitlebarUnmounted) {
    return;
  }

  const nextUnlistenResize = await appWindow.onResized(() => {
    void syncWindowState();
  });

  if (isTitlebarUnmounted) {
    nextUnlistenResize();
    return;
  }

  unlistenResize = nextUnlistenResize;
});

defineExpose<{
  openCommandPalette: () => void;
}>({
  openCommandPalette,
});

onBeforeUnmount(() => {
  isTitlebarUnmounted = true;
  document.removeEventListener('pointerdown', handleDocumentPointerDown);
  document.removeEventListener('keydown', handleDocumentKeyDown);

  if (unlistenResize) {
    unlistenResize();
    unlistenResize = null;
  }
});
</script>
