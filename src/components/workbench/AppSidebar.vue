<template>
  <aside class="app-sidebar-shell flex h-full min-h-0 min-w-0 flex-col overflow-hidden" :class="{
    'source-control-sidebar-host': isSourceControlView,
    'explorer-sidebar-host': isExplorerView,
    'search-sidebar-host': isSearchView,
    'ssh-sidebar-host': isSshView,
  }">
    <SourceControlPanel v-if="isSourceControlView" class="h-full min-h-0 w-full flex-1"
      :is-desktop-runtime="isDesktopRuntime" :workspace-root-path="workspaceRootPath" :active-path="document.path"
      @open-file="handleOpenFile" @open-diff="handleOpenGitDiff" />

    <section v-else-if="isExplorerView" class="explorer-sidebar" aria-label="资源管理器">
      <div class="explorer-tree">
        <div v-if="!isDesktopRuntime" class="explorer-empty-state">
          浏览器预览模式下不显示本地目录树，请在 Tauri 桌面端查看资源文件。
        </div>

        <div v-else-if="loadError" class="explorer-empty-state">
          <InlineError title="无法读取工作区目录" :message="loadError" />
        </div>

        <div v-else-if="rootLoading && !root" class="explorer-empty-state">正在读取资源目录...</div>

        <Empty v-else-if="!workspaceRootPath" class="explorer-empty-state explorer-empty-state--raised">
          <EmptyHeader class="gap-1.5">
            <EmptyMedia class="h-auto w-auto rounded-none border-0 bg-transparent p-0 shadow-none">
              <span class="icon-[lucide--folder-open] h-14 w-14"  />
            </EmptyMedia>
            <EmptyTitle class="text-[12px] font-medium">尚未打开工作区</EmptyTitle>
            <EmptyDescription class="text-[11px] leading-5">
              点击
              <button type="button" class="explorer-empty-action" @click="emit('open-folder')">
                adding files
              </button>
              <span> 打开一个文件夹。</span>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>

        <div v-else-if="!root" class="explorer-empty-state">正在准备资源树...</div>

        <Empty v-else-if="isExplorerWorkspaceEmpty" class="explorer-empty-state explorer-empty-state--raised">
          <EmptyHeader class="gap-1.5">
            <EmptyMedia class="h-auto w-auto rounded-none border-0 bg-transparent p-0 shadow-none">
              <span class="icon-[lucide--folder-open] h-14 w-14"  />
            </EmptyMedia>
            <EmptyTitle class="text-[12px] font-medium">This folder is empty</EmptyTitle>
            <EmptyDescription class="text-[11px] leading-5">
              Start by
              <button type="button" class="explorer-empty-action" @click="emit('open-folder')">
                adding files
              </button>
              <span> or creating new folders.</span>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>

        <template v-else>
          <FileTree class="explorer-file-tree" :expanded="effectiveExplorerExpandedPaths"
            :selected-path="selectedExplorerPath" @expanded-change="void handleExplorerExpandedChange($event)"
            @update:selected-path="handleExplorerSelection">
            <WorkspaceTreeNode v-if="rootEntry" :entry="rootEntry" :level="0" :children-map="childrenMap"
              :expanded-paths="effectiveExplorerExpandedPaths" :loading-paths="loadingPaths"
              :active-path="document.path" :active-dirty="document.isDirty"
              :context-menu-path="explorerContextMenuHighlightPath" :search-query="explorerSearchQuery"
              :inline-create-draft="inlineCreateDraft" :root-path="root.rootPath"
              :inline-rename-draft="inlineRenameDraft" @toggle-directory="void toggleExplorerPath($event)"
              @open-file="handleOpenFile" @context-menu="handleEntryContextMenu"
              @inline-create-input="handleInlineCreateInputValue" @inline-create-blur="handleInlineCreateBlur"
              @inline-create-confirm="void confirmInlineCreateWorkspaceEntry()"
              @inline-create-cancel="cancelInlineCreateWorkspaceEntry"
              @inline-rename-input="inlineRenameDraft.value = $event"
              @inline-rename-confirm="void confirmInlineRename()" @inline-rename-cancel="cancelInlineRename" />
          </FileTree>
        </template>
      </div>

      <DeferredLinearContextMenu v-if="explorerContextMenu.open" :open="explorerContextMenu.open"
        :x="explorerContextMenu.x" :y="explorerContextMenu.y" :groups="explorerContextMenuGroups"
        :theme="appStore.theme" :submenu-direction="explorerContextMenu.x > 280 ? 'left' : 'right'"
        @select="handleExplorerContextMenuSelect" />
    </section>

    <DeferredSearchSidebarPanel v-else-if="isSearchView" :document-path="document.path"
      :is-desktop-runtime="isDesktopRuntime" :workspace-root-path="workspaceRootPath"
      :preloaded-workspace-root="preloadedWorkspaceRoot" @open-file="handleOpenFile" />

    <DeferredRunSidebarPanel v-else-if="isRunView" :document="document" :has-active-document="Boolean(document.id)"
      :is-desktop-runtime="isDesktopRuntime" :can-run="canRun" :is-running="isRunning"
      :has-run-artifacts="hasRunArtifacts" :active-run="activeRun" :run-history="runHistory"
      :command-templates="commandTemplates" :executor="executor" @run="emit('run')"
      @create-document="emit('create-document')" @open-terminal="emit('open-terminal')"
      @insert-template="emit('insert-template', $event)" @clear-run-history="emit('clear-run-history')" />

    <DeferredSshSidebarPanel v-else-if="isSshView" @open-terminal="emit('open-terminal')" />

    <template v-else>
      <div class="border-b border-(--shell-divider) px-3 py-3">
        <p class="sidebar-section-title"> panelMeta.title </p>
      </div>

      <div class="workbench-scroll-region min-h-0 flex-1 overflow-auto py-2">
        <div class="space-y-3 px-3 py-2">
          <section class="rounded-xl border border-(--border-subtle) bg-white/3 p-3">
            <p class="text-[10px] font-semibold uppercase tracking-[0.12em] text-(--text-quaternary)">
              侧边栏页面
            </p>
            <h3 class="mt-2 text-[13px] font-semibold text-(--text-primary)">
               panelMeta.headline 
            </h3>
            <p class="mt-2 text-[12px] leading-6 text-(--text-secondary)">
               panelMeta.description 
            </p>
            <div class="mt-3 flex items-center gap-2">
              <Button variant="outline" size="sm"> panelMeta.actionLabel </Button>
              <span class="text-[11px] text-(--text-quaternary)">交互面板预留位</span>
            </div>
          </section>

          <section class="rounded-xl border border-(--border-subtle) bg-(--panel-muted)/50 p-3">
            <p class="text-[10px] font-semibold uppercase tracking-[0.12em] text-(--text-quaternary)">
              将展示
            </p>
            <div class="mt-3 space-y-2">
              <article v-for="item in panelMeta.items" :key="item.title"
                class="rounded-lg border border-white/5 bg-white/3 px-3 py-2">
                <p class="text-[12px] font-medium text-(--text-primary)"> item.title </p>
                <p class="mt-1 text-[11px] leading-5 text-(--text-secondary)">
                   item.description 
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
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from 'vue';
import { events } from '@/bindings/tauri';
import { FileTree } from '@/components/ai-elements/file-tree';
import InlineError from '@/components/common/InlineError.vue';
import type {
  ILinearContextMenuGroup,
  ILinearContextMenuItem,
} from '@/components/common/linear-context-menu.types';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import WorkspaceTreeNode from '@/components/workbench/WorkspaceTreeNode.vue';
import { useDialog } from '@/composables/useDialog';
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
  TWorkbenchOpenFilePayload,
} from '@/types/editor';
import type { IGitDiffPreviewRequest } from '@/types/git';
import { writeFileSystemPathToClipboard } from '@/utils/clipboard';
import { toErrorMessage } from '@/utils/error';
import { formatFileSystemPathForDisplay, getPathBaseName } from '@/utils/path';
import {
  collectWorkspaceExpandedPathsByQuery,
  resolveWorkspaceKey,
  resolveWorkspaceRootPayload,
} from '@/utils/workspace';

const DeferredLinearContextMenu = defineAsyncComponent({
  loader: () => import('@/components/common/LinearContextMenu.vue'),
  suspensible: false,
});

const SourceControlPanel = defineAsyncComponent({
  loader: () => import('@/components/workbench/SourceControlPanel.vue'),
  suspensible: false,
});

const DeferredSearchSidebarPanel = defineAsyncComponent({
  loader: () => import('@/components/workbench/SearchSidebarPanel.vue'),
  suspensible: false,
});

const DeferredRunSidebarPanel = defineAsyncComponent({
  loader: () => import('@/components/workbench/RunSidebarPanel.vue'),
  suspensible: false,
});

const DeferredSshSidebarPanel = defineAsyncComponent({
  loader: () => import('@/components/workbench/SshSidebarPanel.vue'),
  suspensible: false,
});

const props = defineProps<{
  document: IEditorDocument;
  view: TWorkbenchSidebarView;
  isDesktopRuntime: boolean;
  workspaceRootPath: string | null;
  preloadedWorkspaceRoot: IWorkspaceDirectoryPayload | null;
  startupExplorerExpandedPaths: string[];
  startupExplorerSelectedPath: string | null;
  canRun: boolean;
  isRunning: boolean;
  hasRunArtifacts: boolean;
  activeRun: IActiveRunSummary | null;
  runHistory: IRunHistoryEntry[];
  commandTemplates: ICommandTemplate[];
  executor: TExecutorKind;
}>();

const emit = defineEmits<{
  'open-file': [payload: TWorkbenchOpenFilePayload];
  'open-folder': [];
  'open-git-diff': [payload: IGitDiffPreviewRequest];
  run: [];
  'create-document': [];
  'open-terminal': [];
  'insert-template': [template: ICommandTemplate];
  'clear-run-history': [];
  'explorer-state-change': [payload: { expandedPaths: string[]; selectedPath: string | null }];
}>();

const message = useMessage();
const dialog = useDialog();
const appStore = useAppStore();
const root = ref<IWorkspaceDirectoryPayload | null>(null);
const rootLoading = ref(false);
const loadError = ref('');
const explorerSearchQuery = ref('');
const childrenMap = reactive<Record<string, IWorkspaceEntry[]>>({});
const manualExpandedPaths = ref<Set<string>>(new Set());
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
  | 'refresh'
  | 'open-folder';

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
const inlineCreateDraft = reactive({
  open: false,
  parentPath: null as string | null,
  kind: 'file' as 'file' | 'directory',
  value: '',
  placeholder: '',
});
const inlineRenameDraft = reactive({
  path: null as string | null,
  value: '',
});
const isInlineCreateSubmitting = ref(false);
const isInlineRenamePriming = ref(false);

const explorerContextMenuGroups = computed<ILinearContextMenuGroup<IExplorerContextMenuItem>[]>(
  () => {
    const target = explorerContextTarget.value;
    const canCreate = target?.kind === 'directory';
    const canMutate = Boolean(target && !target.isRoot);

    return [
      {
        key: 'primary',
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
        items: [
          {
            key: 'delete',
            label: '移动到回收站',
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
          {
            key: 'open-folder',
            label: '打开文件夹',
            icon: 'open-external',
            action: 'open-folder',
          },
        ],
      },
    ];
  },
);

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
const panelMeta = computed(() => SIDEBAR_META[props.view] ?? SIDEBAR_META.ai);
const normalizedExplorerSearchQuery = computed(() =>
  explorerSearchQuery.value.trim().toLowerCase(),
);
const hasExplorerSearch = computed(() => normalizedExplorerSearchQuery.value.length > 0);
const isExplorerWorkspaceEmpty = computed(() => {
  if (!root.value) {
    return false;
  }

  const rootEntries = childrenMap[root.value.rootPath] ?? root.value.entries;
  return rootEntries.length === 0;
});

const rootEntry = computed<IWorkspaceEntry | null>(() => {
  if (!root.value) {
    return null;
  }

  const rootEntries = childrenMap[root.value.rootPath] ?? root.value.entries;
  const displayRootPath = formatFileSystemPathForDisplay(
    root.value.rootName || root.value.rootPath,
  );
  const displayRootName = getPathBaseName(displayRootPath) || displayRootPath;

  return {
    path: root.value.rootPath,
    name: displayRootName,
    kind: 'directory',
    hasChildren: rootEntries.length > 0,
  };
});

const selectedExplorerPath = computed(
  () => props.document.path ?? props.startupExplorerSelectedPath ?? undefined,
);
const explorerContextMenuHighlightPath = computed(() =>
  explorerContextMenu.open ? (explorerContextTarget.value?.path ?? null) : null,
);

const searchExpandedPaths = computed(() => {
  if (!root.value || !hasExplorerSearch.value) {
    return new Set<string>();
  }

  const nextExpandedPaths = collectWorkspaceExpandedPathsByQuery(
    childrenMap[root.value.rootPath] ?? root.value.entries,
    normalizedExplorerSearchQuery.value,
    childrenMap,
  );
  nextExpandedPaths.add(root.value.rootPath);
  return nextExpandedPaths;
});

const effectiveExplorerExpandedPaths = computed(() => {
  const nextExpandedPaths = new Set(manualExpandedPaths.value);

  searchExpandedPaths.value.forEach((path) => {
    nextExpandedPaths.add(path);
  });

  return nextExpandedPaths;
});

const loadedExplorerEntries = computed(() => {
  const entryMap = new Map<string, IWorkspaceEntry>();

  if (rootEntry.value) {
    entryMap.set(rootEntry.value.path, rootEntry.value);
  }

  Object.values(childrenMap).forEach((entries) => {
    entries.forEach((entry) => {
      entryMap.set(entry.path, entry);
    });
  });

  return entryMap;
});

const clearTreeState = (): void => {
  Object.keys(childrenMap).forEach((path) => {
    delete childrenMap[path];
  });
  Object.keys(loadingPaths).forEach((path) => {
    delete loadingPaths[path];
  });
  manualExpandedPaths.value = new Set();
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
  manualExpandedPaths.value = new Set([payload.rootPath, ...props.startupExplorerExpandedPaths]);
  emitExplorerStateChange();
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
    void loadStartupExpandedDirectories();
    void startWorkspaceFileWatcher();
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

const loadStartupExpandedDirectories = async (): Promise<void> => {
  if (!root.value) {
    return;
  }

  const rootPath = root.value.rootPath;
  const pendingPaths = [...manualExpandedPaths.value].filter(
    (path) => path !== rootPath && childrenMap[path] === undefined,
  );

  for (const path of pendingPaths) {
    if (!manualExpandedPaths.value.has(path)) {
      continue;
    }

    await loadDirectoryEntries(path);
  }
};

const expandExplorerPath = async (path: string): Promise<void> => {
  if (!root.value) {
    return;
  }

  if (!manualExpandedPaths.value.has(path)) {
    const nextExpandedPaths = new Set(manualExpandedPaths.value);
    nextExpandedPaths.add(path);
    manualExpandedPaths.value = nextExpandedPaths;
    emitExplorerStateChange();
  }

  if (path !== root.value.rootPath && childrenMap[path] === undefined) {
    await loadDirectoryEntries(path);
  }
};

const toggleExplorerPath = async (path: string): Promise<void> => {
  if (hasExplorerSearch.value && searchExpandedPaths.value.has(path)) {
    return;
  }

  if (effectiveExplorerExpandedPaths.value.has(path)) {
    const nextExpandedPaths = new Set(manualExpandedPaths.value);
    nextExpandedPaths.delete(path);
    manualExpandedPaths.value = nextExpandedPaths;
    emitExplorerStateChange();
    return;
  }

  await expandExplorerPath(path);
};

const handleExplorerExpandedChange = async (nextExpanded: Set<string>): Promise<void> => {
  const previousExpanded = new Set(effectiveExplorerExpandedPaths.value);
  const nextManualExpanded = new Set(nextExpanded);

  if (hasExplorerSearch.value) {
    searchExpandedPaths.value.forEach((path) => {
      nextManualExpanded.delete(path);
    });
  }

  manualExpandedPaths.value = nextManualExpanded;
  emitExplorerStateChange();

  if (!root.value) {
    return;
  }

  const pendingLoads = [...nextExpanded].filter((path) => {
    if (previousExpanded.has(path) || path === root.value?.rootPath) {
      return false;
    }

    return childrenMap[path] === undefined;
  });

  for (const path of pendingLoads) {
    await loadDirectoryEntries(path);
  }
};

const closeExplorerContextMenu = (): void => {
  explorerContextMenu.open = false;
  explorerContextTarget.value = null;
};

const openExplorerContextMenu = (event: MouseEvent, target: IExplorerContextTarget): void => {
  explorerContextMenu.x = Math.min(event.clientX, Math.max(12, window.innerWidth - 236));
  explorerContextMenu.y = Math.min(event.clientY, Math.max(12, window.innerHeight - 300));
  explorerContextTarget.value = target;
  explorerContextMenu.open = true;
};

const handleEntryContextMenu = (payload: { event: MouseEvent; entry: IWorkspaceEntry }): void => {
  openExplorerContextMenu(payload.event, {
    path: payload.entry.path,
    name: payload.entry.name,
    kind: payload.entry.kind,
    isRoot: payload.entry.path === root.value?.rootPath,
  });
};

const handleOpenFile = (payload: TWorkbenchOpenFilePayload): void => {
  emit('open-file', payload);
};

const handleExplorerSelection = (path: string): void => {
  emitExplorerStateChange(path);
  const entry = loadedExplorerEntries.value.get(path);

  if (entry?.kind === 'file') {
    handleOpenFile(entry.path);
  }
};

const emitExplorerStateChange = (
  selectedPath: string | null | undefined = selectedExplorerPath.value ?? null,
): void => {
  emit('explorer-state-change', {
    expandedPaths: [...manualExpandedPaths.value],
    selectedPath: selectedPath ?? null,
  });
};

const handleOpenGitDiff = (payload: IGitDiffPreviewRequest): void => {
  emit('open-git-diff', payload);
};

const resolveCreationParentPath = (target: IExplorerContextTarget | null): string | null => {
  if (target?.kind === 'directory') {
    return target.path;
  }

  return root.value?.rootPath ?? props.workspaceRootPath;
};

const closeInlineCreateDraft = (): void => {
  inlineCreateDraft.open = false;
  inlineCreateDraft.parentPath = null;
  inlineCreateDraft.value = '';
  inlineCreateDraft.placeholder = '';
  isInlineCreateSubmitting.value = false;
};

const focusInlineCreateInput = async (): Promise<void> => {
  await nextTick();

  const input = document.querySelector('.explorer-inline-create-input') as HTMLInputElement | null;
  input?.focus();
  input?.select();
};

const openInlineCreateDraft = async (
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

  await expandExplorerPath(parentPath);

  inlineCreateDraft.open = true;
  inlineCreateDraft.parentPath = parentPath;
  inlineCreateDraft.kind = kind;
  inlineCreateDraft.value = '';
  inlineCreateDraft.placeholder = '';

  await focusInlineCreateInput();
};

const handleInlineCreateInputValue = (value: string): void => {
  inlineCreateDraft.value = value;
};

const cancelInlineCreateWorkspaceEntry = (): void => {
  closeInlineCreateDraft();
};

const confirmInlineCreateWorkspaceEntry = async (): Promise<void> => {
  if (
    !root.value ||
    !inlineCreateDraft.open ||
    !inlineCreateDraft.parentPath ||
    isInlineCreateSubmitting.value
  ) {
    return;
  }

  const name = inlineCreateDraft.value.trim();
  if (!name) {
    closeInlineCreateDraft();
    return;
  }

  isInlineCreateSubmitting.value = true;

  try {
    const payload = await tauriService.createWorkspacePath({
      parentPath: inlineCreateDraft.parentPath,
      rootPath: root.value.rootPath,
      name,
      kind: inlineCreateDraft.kind,
    });

    await refreshDirectoryAfterMutation(inlineCreateDraft.parentPath);
    message.success(inlineCreateDraft.kind === 'file' ? '已创建文件' : '已创建文件夹');
    closeInlineCreateDraft();
    if (payload.kind === 'file') {
      handleOpenFile(payload.path);
    }
  } catch (error) {
    isInlineCreateSubmitting.value = false;
    message.error(
      toErrorMessage(error, inlineCreateDraft.kind === 'file' ? '创建文件失败' : '创建文件夹失败'),
    );
  }
};

const handleInlineCreateBlur = (): void => {
  if (!inlineCreateDraft.open || isInlineCreateSubmitting.value) {
    return;
  }

  void confirmInlineCreateWorkspaceEntry();
};

let resolveInlineRename: ((value: string | null) => void) | null = null;

const cancelInlineRename = (): void => {
  isInlineRenamePriming.value = false;
  inlineRenameDraft.path = null;
  inlineRenameDraft.value = '';
  const resolver = resolveInlineRename;
  resolveInlineRename = null;
  resolver?.(null);
};

const confirmInlineRename = (): void => {
  if (isInlineRenamePriming.value) {
    return;
  }

  const value = inlineRenameDraft.value.trim();
  inlineRenameDraft.path = null;
  inlineRenameDraft.value = '';
  const resolver = resolveInlineRename;
  resolveInlineRename = null;
  resolver?.(value || null);
};

const waitNextFrame = (): Promise<void> => {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
};

const focusInlineRenameInput = async (): Promise<boolean> => {
  await nextTick();
  await waitNextFrame();

  const input = document.querySelector('.explorer-inline-rename-input') as HTMLInputElement | null;
  if (!input) {
    return false;
  }

  input.focus();
  // 智能选区：仅选中最后一个点之前的文件名（后缀前），方便直接改名。
  // lastDotIndex > 0 可避免把 .gitignore 这类 dotfile 的整个名字视作后缀，
  // 这种情况下回退为全选。
  const currentValue = input.value;
  const lastDotIndex = currentValue.lastIndexOf('.');
  if (lastDotIndex > 0) {
    input.setSelectionRange(0, lastDotIndex);
  } else {
    input.select();
  }
  return true;
};

const requestInlineRename = async (path: string, defaultName: string): Promise<string | null> => {
  if (resolveInlineRename) {
    cancelInlineRename();
  }

  isInlineRenamePriming.value = true;
  inlineRenameDraft.path = path;
  inlineRenameDraft.value = defaultName;
  const renamePromise = new Promise<string | null>((resolve) => {
    resolveInlineRename = resolve;
  });

  const didFocus = await focusInlineRenameInput();
  isInlineRenamePriming.value = false;
  if (!didFocus) {
    cancelInlineRename();
  }

  return renamePromise;
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
  await openInlineCreateDraft(kind, target);
};

const handleRefreshExplorer = async (): Promise<void> => {
  const workspaceKey = resolveWorkspaceKey(props.workspaceRootPath);
  await loadWorkspaceRoot(workspaceKey);
};

const resolveParentPathForMutation = (path: string): string | null => {
  const lastSlashIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (lastSlashIndex <= 0) {
    return null;
  }

  return path.slice(0, lastSlashIndex);
};

const handleRenameWorkspaceEntry = async (target: IExplorerContextTarget): Promise<void> => {
  if (!root.value || target.isRoot) {
    return;
  }

  const newName = await requestInlineRename(target.path, target.name);
  if (!newName || newName === target.name) {
    return;
  }

  try {
    await tauriService.renameWorkspacePath({
      path: target.path,
      rootPath: root.value.rootPath,
      newName,
    });
    await refreshDirectoryAfterMutation(resolveParentPathForMutation(target.path));
    message.success('已重命名');
  } catch (error) {
    message.error(toErrorMessage(error, '重命名失败'));
  }
};

const handleDeleteWorkspaceEntry = async (target: IExplorerContextTarget): Promise<void> => {
  if (!root.value || target.isRoot) {
    return;
  }

  const action = await dialog.confirm({
    title: '确认删除',
    description: `确认删除“${target.name}”？此操作不可撤销。`,
    confirmText: '删除',
    cancelText: '取消',
    dismissText: '返回',
    variant: 'danger',
  });

  if (action !== 'confirm') {
    return;
  }

  try {
    await tauriService.deleteWorkspacePath({
      path: target.path,
      rootPath: root.value.rootPath,
    });
    message.success('已移动到回收站');
  } catch (error) {
    message.error(toErrorMessage(error, '删除失败'));
  }
};

const handleExplorerContextMenuSelect = async (item: ILinearContextMenuItem): Promise<void> => {
  const actionItem = item as IExplorerContextMenuItem;
  const target = explorerContextTarget.value;
  closeExplorerContextMenu();

  if (actionItem.disabled) {
    return;
  }

  switch (actionItem.action) {
    case 'open':
      if (!target) return;
      if (target.kind === 'directory') {
        await toggleExplorerPath(target.path);
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
        await writeFileSystemPathToClipboard(target.path);
        message.success('已复制路径');
      }
      return;
    case 'refresh':
      await handleRefreshExplorer();
      return;
    case 'open-folder':
      emit('open-folder');
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
    return;
  }

  if (inlineCreateDraft.open && event.key === 'Escape') {
    cancelInlineCreateWorkspaceEntry();
  }
};

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', handleWindowPointerDown, true);
  window.addEventListener('keydown', handleWindowKeydown);
}

onBeforeUnmount(() => {
  closeInlineCreateDraft();
  cancelInlineRename();

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
    closeInlineCreateDraft();
  },
);

// 工作区文件系统事件类型（对应 Rust WorkspaceFsEvent / FsChange）
interface FsChange {
  path: string;
  kind: 'created' | 'modified' | 'removed' | 'renamed';
}

interface WorkspaceFsEvent {
  changes: FsChange[];
  rootPath: string;
}

// === 文件监听 ===
let fsEventUnlisten: (() => void) | null = null;

async function startWorkspaceFileWatcher(): Promise<void> {
  if (!root.value?.rootPath) return;
  try {
    await tauriService.startWorkspaceWatching(root.value.rootPath);
  } catch {
    // 监听启动失败不阻塞
  }
  if (fsEventUnlisten) return;
  fsEventUnlisten = await events.workspaceFsEvent.listen((e) => {
    void handleFileSystemEvent(e.payload);
  });
}

async function handleFileSystemEvent(payload: WorkspaceFsEvent): Promise<void> {
  if (!root.value || payload.rootPath !== root.value.rootPath) return;
  const affectedDirs = new Set<string>();
  for (const change of payload.changes) {
    const parent = resolveParentPathForMutation(change.path);
    if (parent) affectedDirs.add(parent);
  }
  for (const dir of affectedDirs) {
    await loadDirectoryEntries(dir);
  }
}

onMounted(() => {
  if (root.value?.rootPath) {
    void startWorkspaceFileWatcher();
  }
});

onBeforeUnmount(() => {
  fsEventUnlisten?.();
  fsEventUnlisten = null;
  void tauriService.stopWorkspaceWatching();
});
</script>

<style scoped>
:deep(.explorer-file-tree[data-slot='file-tree']) {
  border: 0;
  background: transparent;
  box-shadow: none;
}

:deep(.explorer-file-tree[data-slot='file-tree'] > div) {
  padding: 0;
}

.explorer-tree-inline-create {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  padding-right: 8px;
}

.explorer-inline-create-input {
  width: 100%;
  min-width: 0;
  height: 28px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 82%, transparent);
  border-radius: 6px;
  background: #fafafa;
  color: var(--text-primary);
  font-size: 12.5px;
  padding: 0 10px;
  outline: none;
  transition:
    border-color 120ms ease,
    box-shadow 120ms ease,
    background-color 120ms ease;
}

.explorer-inline-create-input:hover {
  border-color: color-mix(in srgb, var(--accent-strong) 38%, var(--shell-divider));
}

.explorer-inline-create-input:focus {
  border-color: color-mix(in srgb, var(--accent-strong) 70%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-strong) 28%, transparent);
}

.explorer-empty-action {
  color: var(--accent-strong);
  font-weight: 500;
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}

.explorer-empty-action:hover {
  color: color-mix(in srgb, var(--accent-strong) 84%, white);
}

.explorer-empty-action:focus-visible {
  outline: none;
  border-radius: 4px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ring) 32%, transparent);
}

.explorer-empty-state--raised {
  transform: translateY(-52px);
}
</style>
