<template>
  <aside
    class="app-sidebar-shell flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    :class="{
      'source-control-sidebar-host': isSourceControlView,
      'explorer-sidebar-host': isExplorerView,
      'search-sidebar-host': isSearchView,
    }"
  >
    <SourceControlPanel
      v-if="isSourceControlView"
      class="h-full min-h-0 w-full flex-1"
      :is-desktop-runtime="isDesktopRuntime"
      :workspace-root-path="workspaceRootPath"
      :active-path="document.path"
      @open-file="handleOpenFile"
    />

    <section v-else-if="isExplorerView" class="explorer-sidebar" aria-label="资源管理器">
      <header class="explorer-title-bar">
        <span class="explorer-title">资源管理器</span>

        <div class="explorer-title-actions">
          <button
            type="button"
            class="explorer-icon-btn"
            aria-label="新建文件"
            title="新建文件"
            @click="handleCreatePlaceholder('file')"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="12" y1="12" x2="12" y2="18" />
              <line x1="9" y1="15" x2="15" y2="15" />
            </svg>
          </button>

          <button
            type="button"
            class="explorer-icon-btn"
            aria-label="新建文件夹"
            title="新建文件夹"
            @click="handleCreatePlaceholder('directory')"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path
                d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
              />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
          </button>

          <button
            type="button"
            class="explorer-icon-btn"
            aria-label="刷新"
            title="刷新"
            @click="handleRefreshExplorer"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
              <path d="M20.49 15A9 9 0 0 1 5.64 18.36L1 14" />
            </svg>
          </button>

          <button
            type="button"
            class="explorer-icon-btn"
            aria-label="折叠全部"
            title="折叠全部"
            @click="handleCollapseAll"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="4 14 10 14 10 20" />
              <polyline points="20 10 14 10 14 4" />
              <line x1="14" y1="10" x2="21" y2="3" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
        </div>
      </header>

      <div class="explorer-search">
        <label class="explorer-search-box">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input v-model="explorerSearchQuery" type="text" placeholder="搜索文件……" />
        </label>
      </div>

      <div class="explorer-tree">
        <div v-if="!isDesktopRuntime" class="explorer-empty-state">
          浏览器预览模式下不显示本地目录树，请在 Tauri 桌面端查看资源文件。
        </div>

        <div v-else-if="loadError" class="explorer-empty-state">{{ loadError }}</div>

        <div v-else-if="rootLoading && !root" class="explorer-empty-state">正在读取资源目录...</div>

        <div v-else-if="!workspaceRootPath" class="explorer-empty-state">尚未打开工作区</div>

        <div v-else-if="!root" class="explorer-empty-state">正在准备资源树...</div>

        <template v-else>
          <button
            type="button"
            class="explorer-root-row w-full text-left"
            :class="{ 'is-open': isRootOpen }"
            @click="toggleRoot"
            @contextmenu.prevent.stop="handleRootContextMenu"
          >
            <span class="explorer-chevron">
              <svg
                viewBox="0 0 12 12"
                class="h-3 w-3 transition-transform"
                :class="isRootOpen ? 'rotate-90' : ''"
                fill="none"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M4 2.5 8 6 4 9.5" />
              </svg>
            </span>

            <ExplorerEntryIcon
              kind="directory"
              :path="root.rootPath"
              :expanded="isRootOpen"
              class="h-4 w-4 shrink-0"
            />

            <span class="explorer-tree-name">{{ rootLabel }}</span>
          </button>

          <div v-if="isRootOpen" class="explorer-tree-children">
            <div v-if="rootLoading" class="explorer-helper-text explorer-helper-text-padded">
              正在读取资源目录...
            </div>

            <div
              v-else-if="hasExplorerSearch && !hasVisibleRootEntries"
              class="explorer-empty-state is-inline"
            >
              未找到匹配的文件
            </div>

            <div
              v-else-if="!hasExplorerSearch && filteredRootEntries.length === 0"
              class="explorer-empty-state is-inline"
            >
              当前目录暂无文件。
            </div>

            <WorkspaceTreeNode
              v-for="entry in filteredRootEntries"
              :key="entry.path"
              :entry="entry"
              :level="0"
              :children-map="childrenMap"
              :expanded-paths="expandedPaths"
              :loading-paths="loadingPaths"
              :active-path="document.path"
              :active-dirty="document.isDirty"
              :search-query="explorerSearchQuery"
              @toggle-directory="toggleDirectory"
              @open-file="handleOpenFile"
              @context-menu="handleEntryContextMenu"
            />
          </div>
        </template>
      </div>

      <LinearContextMenu
        :open="explorerContextMenu.open"
        :x="explorerContextMenu.x"
        :y="explorerContextMenu.y"
        :groups="explorerContextMenuGroups"
        :theme="appStore.theme"
        :submenu-direction="explorerContextMenu.x > 280 ? 'left' : 'right'"
        @select="handleExplorerContextMenuSelect"
      />
    </section>

    <SearchSidebarPanel
      v-else-if="isSearchView"
      :document-path="document.path"
      :is-desktop-runtime="isDesktopRuntime"
      :workspace-root-path="workspaceRootPath"
      :preloaded-workspace-root="preloadedWorkspaceRoot"
      @open-file="handleOpenFile"
    />

    <RunSidebarPanel
      v-else-if="isRunView"
      :document="document"
      :has-active-document="Boolean(document.id)"
      :is-desktop-runtime="isDesktopRuntime"
      :can-run="canRun"
      :is-running="isRunning"
      :has-run-artifacts="hasRunArtifacts"
      :active-run="activeRun"
      :run-history="runHistory"
      :command-templates="commandTemplates"
      :executor="executor"
      @run="emit('run')"
      @create-document="emit('create-document')"
      @open-terminal="emit('open-terminal')"
      @insert-template="emit('insert-template', $event)"
      @clear-run-history="emit('clear-run-history')"
    />

    <SshSidebarPanel v-else-if="isSshView" @open-terminal="emit('open-terminal')" />

    <template v-else>
      <div class="border-b border-(--shell-divider) px-3 py-3">
        <p class="sidebar-section-title">{{ panelMeta.title }}</p>
      </div>

      <div class="workbench-scroll-region min-h-0 flex-1 overflow-auto py-2">
        <div class="space-y-3 px-3 py-2">
          <section class="rounded-xl border border-(--border-subtle) bg-white/3 p-3">
            <p
              class="text-[10px] font-semibold uppercase tracking-[0.12em] text-(--text-quaternary)"
            >
              侧边栏页面
            </p>
            <h3 class="mt-2 text-[13px] font-semibold text-(--text-primary)">
              {{ panelMeta.headline }}
            </h3>
            <p class="mt-2 text-[12px] leading-6 text-(--text-secondary)">
              {{ panelMeta.description }}
            </p>
            <div class="mt-3 flex items-center gap-2">
              <Button variant="outline" size="sm">{{ panelMeta.actionLabel }}</Button>
              <span class="text-[11px] text-(--text-quaternary)">交互面板预留位</span>
            </div>
          </section>

          <section class="rounded-xl border border-(--border-subtle) bg-(--panel-muted)/50 p-3">
            <p
              class="text-[10px] font-semibold uppercase tracking-[0.12em] text-(--text-quaternary)"
            >
              将展示
            </p>
            <div class="mt-3 space-y-2">
              <article
                v-for="item in panelMeta.items"
                :key="item.title"
                class="rounded-lg border border-white/5 bg-white/3 px-3 py-2"
              >
                <p class="text-[12px] font-medium text-(--text-primary)">{{ item.title }}</p>
                <p class="mt-1 text-[11px] leading-5 text-(--text-secondary)">
                  {{ item.description }}
                </p>
              </article>
            </div>
          </section>
        </div>
      </div>
    </template>
  </aside>
</template>

<script setup lang="ts">
import type { ILinearContextMenuGroup, ILinearContextMenuItem } from '@/components/common/linear-context-menu.types';
import LinearContextMenu from '@/components/common/LinearContextMenu.vue';
import { Button } from '@/components/ui/button';
import ExplorerEntryIcon from '@/components/workbench/ExplorerEntryIcon.vue';
import RunSidebarPanel from '@/components/workbench/RunSidebarPanel.vue';
import SearchSidebarPanel from '@/components/workbench/SearchSidebarPanel.vue';
import SourceControlPanel from '@/components/workbench/SourceControlPanel.vue';
import SshSidebarPanel from '@/components/workbench/SshSidebarPanel.vue';
import WorkspaceTreeNode from '@/components/workbench/WorkspaceTreeNode.vue';
import { useMessage } from '@/composables/useMessage';
import { tauriService } from '@/services/tauri';
import { useAppStore } from '@/store/app';
import type { TWorkbenchSidebarView } from '@/types/app';
import type {
  IActiveRunSummary,
  ICommandTemplate,
  IEditorDocument,
  IRunHistoryEntry,
  IWorkspaceDirectoryPayload,
  IWorkspaceEntry,
  TExecutorKind,
} from '@/types/editor';
import { toErrorMessage } from '@/utils/error';
import { writeClipboardText } from '@/utils/clipboard';
import { getPathDirectory } from '@/utils/path';
import {
  filterWorkspaceEntriesByQuery,
  resolveWorkspaceKey,
  resolveWorkspaceRootPayload,
} from '@/utils/workspace';
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';

const props = defineProps<{
  document: IEditorDocument;
  view: TWorkbenchSidebarView;
  isDesktopRuntime: boolean;
  workspaceRootPath: string | null;
  preloadedWorkspaceRoot: IWorkspaceDirectoryPayload | null;
  canRun: boolean;
  isRunning: boolean;
  hasRunArtifacts: boolean;
  activeRun: IActiveRunSummary | null;
  runHistory: IRunHistoryEntry[];
  commandTemplates: ICommandTemplate[];
  executor: TExecutorKind;
}>();

const emit = defineEmits<{
  'open-file': [path: string];
  run: [];
  'create-document': [];
  'open-terminal': [];
  'insert-template': [template: ICommandTemplate];
  'clear-run-history': [];
}>();

const message = useMessage();
const appStore = useAppStore();
const root = ref<IWorkspaceDirectoryPayload | null>(null);
const rootExpanded = ref(true);
const rootLoading = ref(false);
const loadError = ref('');
const explorerSearchQuery = ref('');
const childrenMap = reactive<Record<string, IWorkspaceEntry[]>>({});
const expandedPaths = reactive<Record<string, boolean>>({});
const loadingPaths = reactive<Record<string, boolean>>({});
const loadedWorkspaceKey = ref<string | null>(null);
let rootRequestId = 0;

type TExplorerContextMenuAction =
  | 'open'
  | 'new-file'
  | 'new-directory'
  | 'rename'
  | 'delete'
  | 'copy-path'
  | 'refresh';

interface IExplorerContextMenuItem extends ILinearContextMenuItem {
  action: TExplorerContextMenuAction;
}

interface IExplorerContextTarget {
  path: string;
  name: string;
  kind: 'directory' | 'file';
  isRoot: boolean;
}

const explorerContextMenu = reactive({
  open: false,
  x: 0,
  y: 0,
});
const explorerContextTarget = ref<IExplorerContextTarget | null>(null);

const explorerContextMenuGroups = computed<ILinearContextMenuGroup<IExplorerContextMenuItem>[]>(() => {
  const target = explorerContextTarget.value;
  const canCreate = target?.kind === 'directory';
  const canMutate = Boolean(target && !target.isRoot);

  return [
    {
      key: 'primary',
      title: 'EXPLORER',
      items: [
        {
          key: 'open',
          label: '打开',
          icon: 'goto',
          shortcut: ['Enter'],
          action: 'open',
          disabled: !target,
        },
        {
          key: 'new-file',
          label: '新建文件',
          icon: 'plus',
          shortcut: ['Ctrl', 'N'],
          action: 'new-file',
          disabled: !canCreate,
        },
        {
          key: 'new-directory',
          label: '新建文件夹',
          icon: 'plus',
          shortcut: ['Ctrl', 'Shift', 'N'],
          action: 'new-directory',
          disabled: !canCreate,
        },
        {
          key: 'rename',
          label: '重命名',
          icon: 'comment',
          shortcut: ['F2'],
          action: 'rename',
          disabled: !canMutate,
        },
      ],
    },
    {
      key: 'secondary',
      title: 'ACTIONS',
      items: [
        {
          key: 'delete',
          label: '删除',
          icon: 'trash',
          shortcut: ['Del'],
          action: 'delete',
          disabled: !canMutate,
        },
        {
          key: 'copy-path',
          label: '复制路径',
          icon: 'copy',
          shortcut: ['Ctrl', 'Shift', 'C'],
          action: 'copy-path',
          disabled: !target,
        },
        {
          key: 'refresh',
          label: '刷新',
          icon: 'refresh',
          shortcut: ['F5'],
          action: 'refresh',
        },
      ],
    },
  ];
});

const SIDEBAR_META: Record<
  TWorkbenchSidebarView,
  {
    title: string;
    headline: string;
    description: string;
    actionLabel: string;
    items: Array<{ title: string; description: string }>;
  }
> = {
  explorer: {
    title: '资源管理器',
    headline: '浏览工作区目录',
    description: '在这里查看脚本、图片资源和文件树。',
    actionLabel: '浏览文件',
    items: [],
  },
  search: {
    title: '搜索',
    headline: '全局搜索与快速定位',
    description: '后续可以在这里放置关键字、范围过滤和搜索结果列表。',
    actionLabel: '搜索面板',
    items: [
      { title: '全文匹配', description: '跨脚本搜索命令、变量、路径和注释。' },
      { title: '范围过滤', description: '限定目录、文件类型和忽略规则。' },
      { title: '结果联动', description: '搜索结果可直接定位到编辑器标签。' },
    ],
  },
  'source-control': {
    title: '源代码管理',
    headline: '变更、暂存与提交',
    description: '后续可以在这里聚合当前工作区的 Git 状态与常用操作。',
    actionLabel: '版本控制',
    items: [
      { title: '变更列表', description: '按文件展示未提交、已暂存和冲突状态。' },
      { title: '提交入口', description: '输入提交说明并触发常用 Git 动作。' },
      { title: '分支提示', description: '显示当前分支和同步状态。' },
    ],
  },
  run: {
    title: '运行',
    headline: '执行配置与流程入口',
    description: '后续可以把运行配置、快速命令和运行历史收拢到这一栏。',
    actionLabel: '运行配置',
    items: [
      { title: '启动脚本', description: '预置常用执行模板和参数组合。' },
      { title: '调试入口', description: '为脚本运行和终端回放留出调试位。' },
      { title: '历史记录', description: '回看最近一次运行的命令和结果。' },
    ],
  },
  ai: {
    title: 'AI 助手',
    headline: '对话、解释与修复建议',
    description: '这里承载 AI 对话、上下文整理和模型配置入口。',
    actionLabel: '打开 AI 面板',
    items: [
      { title: '对话框', description: '用于向模型提问、整理上下文和保留临时对话。' },
      { title: '快捷任务', description: '解释脚本、修复报错、代码审查等高频入口。' },
      { title: '服务配置', description: '配置模型服务地址、模型名和系统提示词。' },
    ],
  },
  extensions: {
    title: 'SSH 连接',
    headline: '远端连接与文件传输',
    description: '这里承载 SSH 会话、远端文件浏览和传输任务。',
    actionLabel: '连接远端',
    items: [
      { title: '连接表单', description: '填写主机、端口、用户和认证方式。' },
      { title: '远端文件', description: '查看当前路径、文件列表和选中状态。' },
      { title: '传输任务', description: '追踪上传下载进度并保留后续操作位。' },
    ],
  },
};

const isExplorerView = computed(() => props.view === 'explorer');
const isSearchView = computed(() => props.view === 'search');
const isSourceControlView = computed(() => props.view === 'source-control');
const isRunView = computed(() => props.view === 'run');
const isSshView = computed(() => props.view === 'extensions');
const panelMeta = computed(() => SIDEBAR_META[props.view]);
const normalizedExplorerSearchQuery = computed(() =>
  explorerSearchQuery.value.trim().toLowerCase(),
);
const hasExplorerSearch = computed(() => normalizedExplorerSearchQuery.value.length > 0);
const isRootOpen = computed(() => rootExpanded.value || hasExplorerSearch.value);

const rootEntries = computed(() => {
  if (!root.value) {
    return [];
  }

  return childrenMap[root.value.rootPath] ?? [];
});

const rootLabel = computed(() => root.value?.rootName ?? 'workspace');

const filteredRootEntries = computed(() => {
  return filterWorkspaceEntriesByQuery(
    rootEntries.value,
    normalizedExplorerSearchQuery.value,
    childrenMap,
  );
});

const hasVisibleRootEntries = computed(() => filteredRootEntries.value.length > 0);

const clearTreeState = (): void => {
  Object.keys(childrenMap).forEach((path) => {
    delete childrenMap[path];
  });
  Object.keys(expandedPaths).forEach((path) => {
    delete expandedPaths[path];
  });
  Object.keys(loadingPaths).forEach((path) => {
    delete loadingPaths[path];
  });
};

const applyWorkspaceRootPayload = (
  payload: IWorkspaceDirectoryPayload,
  workspaceKey: string,
): void => {
  rootRequestId += 1;
  rootLoading.value = false;
  loadError.value = '';
  root.value = payload;
  loadedWorkspaceKey.value = workspaceKey;
  clearTreeState();
  childrenMap[payload.rootPath] = payload.entries;
  rootExpanded.value = true;
};

const loadWorkspaceRoot = async (workspaceKey: string): Promise<void> => {
  if (!props.isDesktopRuntime) {
    return;
  }

  if (!props.workspaceRootPath) {
    rootLoading.value = false;
    loadError.value = '';
    root.value = null;
    loadedWorkspaceKey.value = null;
    clearTreeState();
    return;
  }

  const requestId = rootRequestId + 1;
  rootRequestId = requestId;
  rootLoading.value = true;
  loadError.value = '';
  root.value = null;
  loadedWorkspaceKey.value = null;
  clearTreeState();

  try {
    const payload = await resolveWorkspaceRootPayload(
      props.workspaceRootPath,
      props.preloadedWorkspaceRoot,
      tauriService.listWorkspaceEntries,
    );
    if (requestId !== rootRequestId) {
      return;
    }

    applyWorkspaceRootPayload(payload, workspaceKey);
  } catch (error) {
    if (requestId !== rootRequestId) {
      return;
    }

    root.value = null;
    loadedWorkspaceKey.value = null;
    loadError.value = toErrorMessage(error, '读取工作区目录失败');
  } finally {
    if (requestId === rootRequestId) {
      rootLoading.value = false;
    }
  }
};

const loadDirectoryEntries = async (path: string): Promise<void> => {
  if (loadingPaths[path]) {
    return;
  }

  loadingPaths[path] = true;

  try {
    const payload = await tauriService.listWorkspaceEntries(path, root.value?.rootPath);
    childrenMap[path] = payload.entries;
  } catch (error) {
    const errorMessage = toErrorMessage(error, '读取目录失败');
    message.error(errorMessage);
    childrenMap[path] = [];
  } finally {
    loadingPaths[path] = false;
  }
};

const toggleRoot = (): void => {
  rootExpanded.value = !rootExpanded.value;
};

const closeExplorerContextMenu = (): void => {
  explorerContextMenu.open = false;
  explorerContextTarget.value = null;
};

const openExplorerContextMenu = (
  event: MouseEvent,
  target: IExplorerContextTarget,
): void => {
  explorerContextMenu.x = Math.min(event.clientX, Math.max(12, window.innerWidth - 236));
  explorerContextMenu.y = Math.min(event.clientY, Math.max(12, window.innerHeight - 300));
  explorerContextTarget.value = target;
  explorerContextMenu.open = true;
};

const handleRootContextMenu = (event: MouseEvent): void => {
  if (!root.value) {
    return;
  }

  openExplorerContextMenu(event, {
    path: root.value.rootPath,
    name: root.value.rootName,
    kind: 'directory',
    isRoot: true,
  });
};

const handleEntryContextMenu = (payload: { event: MouseEvent; entry: IWorkspaceEntry }): void => {
  openExplorerContextMenu(payload.event, {
    path: payload.entry.path,
    name: payload.entry.name,
    kind: payload.entry.kind,
    isRoot: false,
  });
};

const toggleDirectory = async (path: string): Promise<void> => {
  const nextExpanded = !expandedPaths[path];
  expandedPaths[path] = nextExpanded;

  if (!nextExpanded || childrenMap[path] !== undefined) {
    return;
  }

  await loadDirectoryEntries(path);
};

const handleOpenFile = (path: string): void => {
  emit('open-file', path);
};

const resolveCreationParentPath = (target: IExplorerContextTarget | null): string | null => {
  if (target?.kind === 'directory') {
    return target.path;
  }

  return root.value?.rootPath ?? props.workspaceRootPath;
};

const promptWorkspaceEntryName = (
  title: string,
  defaultName: string,
): string | null => {
  const name = window.prompt(title, defaultName)?.trim();
  return name && name.length > 0 ? name : null;
};

const refreshDirectoryAfterMutation = async (path: string | null): Promise<void> => {
  if (!root.value || !path) {
    await handleRefreshExplorer();
    return;
  }

  if (path === root.value.rootPath) {
    await handleRefreshExplorer();
    return;
  }

  await loadDirectoryEntries(path);
};

const handleCreateWorkspaceEntry = async (
  kind: 'file' | 'directory',
  target: IExplorerContextTarget | null,
): Promise<void> => {
  if (!root.value) {
    message.error('请先打开工作区。');
    return;
  }

  const parentPath = resolveCreationParentPath(target);
  if (!parentPath) {
    message.error('无法解析新建位置。');
    return;
  }

  const name = promptWorkspaceEntryName(
    kind === 'file' ? '请输入文件名' : '请输入文件夹名',
    kind === 'file' ? 'untitled.sh' : '新建文件夹',
  );
  if (!name) {
    return;
  }

  try {
    const payload = await tauriService.createWorkspacePath({
      parentPath,
      rootPath: root.value.rootPath,
      name,
      kind,
    });
    await refreshDirectoryAfterMutation(parentPath);
    message.success(kind === 'file' ? '已创建文件' : '已创建文件夹');
    if (payload.kind === 'file') {
      handleOpenFile(payload.path);
    }
  } catch (error) {
    message.error(toErrorMessage(error, kind === 'file' ? '创建文件失败' : '创建文件夹失败'));
  }
};

const handleCreatePlaceholder = (kind: 'file' | 'directory'): void => {
  void handleCreateWorkspaceEntry(kind, {
    path: root.value?.rootPath ?? props.workspaceRootPath ?? '',
    name: root.value?.rootName ?? 'workspace',
    kind: 'directory',
    isRoot: true,
  });
};

const handleRefreshExplorer = async (): Promise<void> => {
  const workspaceKey = resolveWorkspaceKey(props.workspaceRootPath);
  await loadWorkspaceRoot(workspaceKey);
};

const handleCollapseAll = (): void => {
  Object.keys(expandedPaths).forEach((path) => {
    delete expandedPaths[path];
  });
  rootExpanded.value = true;
};

const handleRenameWorkspaceEntry = async (target: IExplorerContextTarget): Promise<void> => {
  if (!root.value || target.isRoot) {
    return;
  }

  const newName = promptWorkspaceEntryName('请输入新名称', target.name);
  if (!newName || newName === target.name) {
    return;
  }

  try {
    await tauriService.renameWorkspacePath({
      path: target.path,
      rootPath: root.value.rootPath,
      newName,
    });
    await refreshDirectoryAfterMutation(getPathDirectory(target.path));
    message.success('已重命名');
  } catch (error) {
    message.error(toErrorMessage(error, '重命名失败'));
  }
};

const handleDeleteWorkspaceEntry = async (target: IExplorerContextTarget): Promise<void> => {
  if (!root.value || target.isRoot) {
    return;
  }

  const confirmed = window.confirm(`确认删除“${target.name}”？此操作不可撤销。`);
  if (!confirmed) {
    return;
  }

  try {
    await tauriService.deleteWorkspacePath({
      path: target.path,
      rootPath: root.value.rootPath,
    });
    await refreshDirectoryAfterMutation(getPathDirectory(target.path));
    message.success('已删除');
  } catch (error) {
    message.error(toErrorMessage(error, '删除失败'));
  }
};

const handleExplorerContextMenuSelect = async (
  item: ILinearContextMenuItem,
): Promise<void> => {
  const actionItem = item as IExplorerContextMenuItem;
  const target = explorerContextTarget.value;
  closeExplorerContextMenu();

  if (actionItem.disabled) {
    return;
  }

  switch (actionItem.action) {
    case 'open':
      if (!target) return;
      if (target.isRoot) {
        toggleRoot();
        return;
      }
      if (target.kind === 'directory') {
        await toggleDirectory(target.path);
        return;
      }
      handleOpenFile(target.path);
      return;
    case 'new-file':
      await handleCreateWorkspaceEntry('file', target);
      return;
    case 'new-directory':
      await handleCreateWorkspaceEntry('directory', target);
      return;
    case 'rename':
      if (target) await handleRenameWorkspaceEntry(target);
      return;
    case 'delete':
      if (target) await handleDeleteWorkspaceEntry(target);
      return;
    case 'copy-path':
      if (target) {
        await writeClipboardText(target.path);
        message.success('已复制路径');
      }
      return;
    case 'refresh':
      await handleRefreshExplorer();
      return;
    default:
      return;
  }
};

const handleWindowPointerDown = (event: PointerEvent): void => {
  if (
    explorerContextMenu.open &&
    event.target instanceof Element &&
    event.target.closest('.linear-context-menu-root') === null
  ) {
    closeExplorerContextMenu();
  }
};

const handleWindowKeydown = (event: KeyboardEvent): void => {
  if (explorerContextMenu.open && event.key === 'Escape') {
    closeExplorerContextMenu();
  }
};

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', handleWindowPointerDown, true);
  window.addEventListener('keydown', handleWindowKeydown);
}

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('pointerdown', handleWindowPointerDown, true);
    window.removeEventListener('keydown', handleWindowKeydown);
  }
});

watch(
  [
    () => props.isDesktopRuntime,
    () => props.workspaceRootPath,
    isExplorerView,
    () => props.preloadedWorkspaceRoot,
  ],
  ([ready, workspaceRootPath, explorer]) => {
    if (!ready || !explorer) {
      return;
    }

    const workspaceKey = resolveWorkspaceKey(workspaceRootPath);
    if (loadedWorkspaceKey.value === workspaceKey && root.value) {
      return;
    }

    void loadWorkspaceRoot(workspaceKey);
  },
  { immediate: true },
);

watch(
  () => props.workspaceRootPath,
  () => {
    explorerSearchQuery.value = '';
  },
);
</script>
