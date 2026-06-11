<template>
<aside class="app-sidebar-shell flex h-full min-h-0 min-w-0 flex-col overflow-hidden" :class="{ 'source-control-sidebar-host': isSourceControlView, 'explorer-sidebar-host': isExplorerView, 'search-sidebar-host': isSearchView, 'ssh-sidebar-host': isSshView, }" >
  <!-- 性能优化：侧边栏切换时避免频繁 mount/unmount 大面板（文件树、搜索、Git 等）。 改为常驻挂载 + v-show 切换可见性，以减少切换时的同步渲染/布局开销。 相关数据加载仍由各面板内部的 watch 条件控制（例如仅在 explorer view 时加载树）。 -->
  <SourceControlPanel v-show="isSourceControlView" class="h-full min-h-0 w-full flex-1" :is-desktop-runtime="isDesktopRuntime" :workspace-root-path="workspaceRootPath" :active-path="document.path" @open-file="handleOpenFile" @open-diff="handleOpenGitDiff" />
  <section ref="explorerSectionRef" v-show="isExplorerView" class="explorer-sidebar" :class="{ 'is-scrollbar-active': isExplorerScrollbarActive }" aria-label="资源管理器" >
    <div class="explorer-tree" @scroll.passive="handleExplorerTreeScroll" @contextmenu.prevent="handleEmptyAreaContextMenu">
      <div v-if="!isDesktopRuntime" class="explorer-empty-state"> 浏览器预览模式下不显示本地目录树，请在 Tauri 桌面端查看资源文件。 </div>
      <div v-else-if="loadError" class="explorer-empty-state"> <InlineError title="无法读取工作区目录" :message="loadError" /> </div>
      <div v-else-if="rootLoading && !root" class="explorer-empty-state">正在读取资源目录...</div>
      <Empty v-else-if="!workspaceRootPath" class="explorer-empty-state explorer-empty-state--raised">
        <EmptyHeader class="gap-1.5">
          <EmptyMedia class="h-auto w-auto rounded-none border-0 bg-transparent p-0 shadow-none"> <FolderOpen class="h-14 w-14" /> </EmptyMedia>
          <EmptyTitle class="text-[12px] font-medium">尚未打开工作区</EmptyTitle>
          <EmptyDescription class="text-[11px] leading-5"> 点击 <button type="button" class="explorer-empty-action" @click="emit('open-folder')"> adding files </button> <span> 打开一个文件夹。</span> </EmptyDescription>
        </EmptyHeader>
      </Empty>
      <div v-else-if="!root" class="explorer-empty-state">正在准备资源树...</div>
      <Empty v-else-if="isExplorerWorkspaceEmpty" class="explorer-empty-state explorer-empty-state--raised">
        <EmptyHeader class="gap-1.5">
          <EmptyMedia class="h-auto w-auto rounded-none border-0 bg-transparent p-0 shadow-none"> <FolderOpen class="h-14 w-14" /> </EmptyMedia>
          <EmptyTitle class="text-[12px] font-medium">This folder is empty</EmptyTitle>
          <EmptyDescription class="text-[11px] leading-5"> Start by <button type="button" class="explorer-empty-action" @click="emit('open-folder')"> adding files </button> <span> or creating new folders.</span> </EmptyDescription>
        </EmptyHeader>
      </Empty>
      <template v-else>
        <div class="explorer-file-tree font-mono text-sm" role="tree" aria-label="文件资源树">
          <WorkspaceTreeNode v-if="rootEntry" :entry="rootEntry" :level="0" :children-map="childrenMap" :expanded-paths="manualExpandedPaths" :loading-paths="loadingPaths" :active-path="document.path" :active-dirty="document.isDirty" :context-menu-path="explorerContextMenuHighlightPath" :inline-create-draft="inlineCreateDraft" :root-path="root.rootPath" :inline-rename-draft="inlineRenameDraft" @toggle-directory="void toggleExplorerPath($event)" @open-file="handleOpenFile" @context-menu="handleEntryContextMenu" @inline-create-input="handleInlineCreateInputValue" @inline-create-blur="handleInlineCreateBlur" @inline-create-confirm="void confirmInlineCreateWorkspaceEntry()" @inline-create-cancel="cancelInlineCreateWorkspaceEntry" @inline-rename-input="inlineRenameDraft.value = $event" @inline-rename-confirm="void confirmInlineRename()" @inline-rename-cancel="cancelInlineRename" />
        </div>
      </template>
    </div>
    <DeferredLinearContextMenu v-if="explorerContextMenu.open" :open="explorerContextMenu.open" :x="explorerContextMenu.x" :y="explorerContextMenu.y" :groups="explorerContextMenuGroups" :theme="appStore.theme" :submenu-direction="explorerContextMenu.x > 280 ? 'left' : 'right'" @select="handleExplorerContextMenuSelect" />
  </section>
  <DeferredSearchSidebarPanel v-show="isSearchView" :document-path="document.path" :is-desktop-runtime="isDesktopRuntime" :workspace-root-path="workspaceRootPath" :preloaded-workspace-root="preloadedWorkspaceRoot" @open-file="handleOpenFile" />
  <DeferredRunSidebarPanel v-show="isRunView" :document="document" :has-active-document="Boolean(document.id)" :is-desktop-runtime="isDesktopRuntime" :can-run="canRun" :is-running="isRunning" :has-run-artifacts="hasRunArtifacts" :active-run="activeRun" :run-history="runHistory" :command-templates="commandTemplates" :executor="executor" @run="emit('run')" @create-document="emit('create-document')" @open-terminal="emit('open-terminal')" @insert-template="emit('insert-template', $event)" @clear-run-history="emit('clear-run-history')" />
  <div v-show="isSshView" class="ssh-sidebar-host-shell flex min-h-0 w-full flex-1 flex-col overflow-hidden" >
    <DeferredSshSidebarPanel @open-terminal="emit('open-terminal')" />
  </div>
  <!-- fallback placeholder (rare) -->
  <template v-if="!isExplorerView && !isSearchView && !isSourceControlView && !isRunView && !isSshView">
    <div class="border-b border-(--shell-divider) px-3 py-3"> <p class="sidebar-section-title" v-text="panelMeta.title"></p> </div>
    <div class="workbench-scroll-region min-h-0 flex-1 overflow-auto py-2">
      <div class="space-y-3 px-3 py-2">
        <section class="rounded-xl border border-(--border-subtle) bg-white/3 p-3">
          <p class="text-[10px] font-semibold uppercase tracking-[0.12em] text-(--text-quaternary)"> 侧边栏页面 </p>
          <h3 class="mt-2 text-[13px] font-semibold text-(--text-primary)" v-text="panelMeta.headline"></h3>
          <p class="mt-2 text-[12px] leading-6 text-(--text-secondary)" v-text="panelMeta.description"></p>
          <div class="mt-3 flex items-center gap-2"> <Button variant="outline" size="sm"><span v-text="panelMeta.actionLabel"></span></Button> <span class="text-[11px] text-(--text-quaternary)">交互面板预留位</span> </div>
        </section>
        <section class="rounded-xl border border-(--border-subtle) bg-(--panel-muted)/50 p-3">
          <p class="text-[10px] font-semibold uppercase tracking-[0.12em] text-(--text-quaternary)"> 将展示 </p>
          <div class="mt-3 space-y-2">
            <article v-for="item in panelMeta.items" :key="item.title" class="rounded-lg border border-white/5 bg-white/3 px-3 py-2" >
              <p class="text-[12px] font-medium text-(--text-primary)" v-text="item.title"></p>
              <p class="mt-1 text-[11px] leading-5 text-(--text-secondary)" v-text="item.description"></p>
            </article>
          </div>
        </section>
      </div>
    </div>
  </template>
</aside>
</template>

<script setup lang="ts">
import { FolderOpen } from '@lucide/vue';
import { useEventListener } from '@vueuse/core';
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from 'vue';
import InlineError from '@/components/common/InlineError.vue';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import WorkspaceTreeNode from '@/components/workbench/WorkspaceTreeNode.vue';
import { useWorkspaceExplorerContextMenu } from '@/components/workbench/sidebar/explorer/useWorkspaceExplorerContextMenu';
import { useWorkspaceExplorerMutations } from '@/components/workbench/sidebar/explorer/useWorkspaceExplorerMutations';
import { useWorkspaceFileWatcher } from '@/components/workbench/sidebar/explorer/useWorkspaceFileWatcher';
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
import {
  formatFileSystemPathForDisplay,
  getPathBaseName,
  getRelativeFileSystemPath,
} from '@/utils/path';
import { resolveWorkspaceKey, resolveWorkspaceRootPayload } from '@/utils/workspace';

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

const EXPLORER_SCROLLBAR_IDLE_HIDE_DELAY_MS = 900;

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
const appStore = useAppStore();

const root = ref<IWorkspaceDirectoryPayload | null>(null);
const rootLoading = ref(false);
const loadError = ref('');
const explorerSectionRef = ref<HTMLElement | null>(null);
const isExplorerScrollbarActive = ref(false);
const childrenMap = reactive<Record<string, IWorkspaceEntry[]>>({});
const manualExpandedPaths = ref<Set<string>>(new Set());
const loadingPaths = reactive<Record<string, boolean>>({});
const loadedWorkspaceKey = ref<string | null>(null);

const pendingReloadAgainPaths = new Set<string>();
let rootRequestId = 0;
let explorerScrollbarIdleTimer: ReturnType<typeof setTimeout> | null = null;

const clearExplorerScrollbarIdleTimer = (): void => {
  if (explorerScrollbarIdleTimer !== null) {
    clearTimeout(explorerScrollbarIdleTimer);
    explorerScrollbarIdleTimer = null;
  }
};

const handleExplorerTreeScroll = (): void => {
  clearExplorerScrollbarIdleTimer();
  isExplorerScrollbarActive.value = true;
  explorerScrollbarIdleTimer = setTimeout(() => {
    explorerScrollbarIdleTimer = null;
    isExplorerScrollbarActive.value = false;
  }, EXPLORER_SCROLLBAR_IDLE_HIDE_DELAY_MS);
};

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

const clearTreeState = (): void => {
  Object.keys(childrenMap).forEach((path) => {
    delete childrenMap[path];
  });
  Object.keys(loadingPaths).forEach((path) => {
    delete loadingPaths[path];
  });
  pendingReloadAgainPaths.clear();
  manualExpandedPaths.value = new Set();
};

const applyWorkspaceRootPayload = (
  payload: IWorkspaceDirectoryPayload,
  workspaceKey: string,
): void => {
  rootLoading.value = false;
  loadError.value = '';
  root.value = payload;
  loadedWorkspaceKey.value = workspaceKey;
  clearTreeState();
  childrenMap[payload.rootPath] = payload.entries;
  const scopedExpandedPaths = props.startupExplorerExpandedPaths.filter(
    (path) => getRelativeFileSystemPath(path, payload.rootPath) !== null,
  );
  manualExpandedPaths.value = new Set([payload.rootPath, ...scopedExpandedPaths]);
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

const loadDirectoryEntries = async (
  path: string,
  options: { silent?: boolean } = {},
): Promise<void> => {
  if (loadingPaths[path]) {
    pendingReloadAgainPaths.add(path);
    return;
  }
  const requestId = rootRequestId;
  loadingPaths[path] = true;
  try {
    const payload = await tauriService.listWorkspaceEntries(path, root.value?.rootPath);
    if (requestId !== rootRequestId) {
      return;
    }
    childrenMap[path] = payload.entries;
  } catch (error) {
    if (requestId !== rootRequestId) {
      return;
    }
    if (!options.silent) {
      message.error(toErrorMessage(error, '读取目录失败'));
    }
    childrenMap[path] = [];
  } finally {
    if (requestId === rootRequestId) {
      loadingPaths[path] = false;
    }
  }
  if (pendingReloadAgainPaths.delete(path) && requestId === rootRequestId) {
    await loadDirectoryEntries(path, options);
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
    await loadDirectoryEntries(path, { silent: true });
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
  if (manualExpandedPaths.value.has(path)) {
    const nextExpandedPaths = new Set(manualExpandedPaths.value);
    nextExpandedPaths.delete(path);
    manualExpandedPaths.value = nextExpandedPaths;
    emitExplorerStateChange();
    return;
  }
  await expandExplorerPath(path);
};

const handleOpenFile = (payload: TWorkbenchOpenFilePayload): void => {
  emit('open-file', payload);
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

const pruneWorkspaceSubtreeState = (path: string): void => {
  const isUnder = (candidate: string): boolean =>
    getRelativeFileSystemPath(candidate, path) !== null;
  Object.keys(childrenMap).forEach((key) => {
    if (isUnder(key)) {
      delete childrenMap[key];
    }
  });
  Object.keys(loadingPaths).forEach((key) => {
    if (isUnder(key)) {
      delete loadingPaths[key];
    }
  });
  let mutated = false;
  const nextExpandedPaths = new Set<string>();
  manualExpandedPaths.value.forEach((expanded) => {
    if (isUnder(expanded)) {
      mutated = true;
    } else {
      nextExpandedPaths.add(expanded);
    }
  });
  if (mutated) {
    manualExpandedPaths.value = nextExpandedPaths;
    emitExplorerStateChange();
  }
};

const {
  inlineCreateDraft,
  inlineRenameDraft,
  closeInlineCreateDraft,
  handleInlineCreateInputValue,
  handleInlineCreateBlur,
  confirmInlineCreateWorkspaceEntry,
  cancelInlineCreateWorkspaceEntry,
  confirmInlineRename,
  cancelInlineRename,
  handleCreateWorkspaceEntry,
  handleRenameWorkspaceEntry,
  handleDeleteWorkspaceEntry,
} = useWorkspaceExplorerMutations({
  getRoot: () => root.value,
  getWorkspaceRootPath: () => props.workspaceRootPath,
  getSectionElement: () => explorerSectionRef.value,
  expandExplorerPath,
  loadDirectoryEntries,
  refreshExplorer: handleRefreshExplorer,
  pruneWorkspaceSubtreeState,
  resolveParentPathForMutation,
  onOpenFile: handleOpenFile,
});

const {
  explorerContextMenu,
  explorerContextMenuGroups,
  explorerContextMenuHighlightPath,
  closeExplorerContextMenu,
  handleEntryContextMenu,
  handleEmptyAreaContextMenu,
  handleExplorerContextMenuSelect,
} = useWorkspaceExplorerContextMenu({
  resolveRootPath: () => root.value?.rootPath ?? null,
  resolveEmptyAreaTarget: () =>
    root.value
      ? {
          path: root.value.rootPath,
          name: rootEntry.value?.name ?? root.value.rootName ?? root.value.rootPath,
          kind: 'directory',
          isRoot: true,
        }
      : null,
  onCreate: handleCreateWorkspaceEntry,
  onRename: handleRenameWorkspaceEntry,
  onDelete: handleDeleteWorkspaceEntry,
  onCopyPath: async (target) => {
    await writeFileSystemPathToClipboard(target.path);
    message.success('已复制路径');
  },
  onOpenFolder: () => emit('open-folder'),
});

const handleWindowKeydown = (event: KeyboardEvent): void => {
  if (explorerContextMenu.open && event.key === 'Escape') {
    closeExplorerContextMenu();
    return;
  }
  if (inlineCreateDraft.open && event.key === 'Escape') {
    cancelInlineCreateWorkspaceEntry();
  }
};

useEventListener(window, 'keydown', handleWindowKeydown);

const { startWorkspaceFileWatcher, stopWorkspaceFileWatcher } = useWorkspaceFileWatcher({
  root,
  getWorkspaceRootPath: () => props.workspaceRootPath,
  childrenMap,
  loadDirectoryEntries,
  pruneWorkspaceSubtreeState,
  resolveParentPathForMutation,
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
    closeInlineCreateDraft();
    stopWorkspaceFileWatcher();
  },
);

onMounted(() => {
  if (root.value?.rootPath) {
    void startWorkspaceFileWatcher();
  }
});
onBeforeUnmount(() => {
  closeInlineCreateDraft();
  cancelInlineRename();
  clearExplorerScrollbarIdleTimer();
  stopWorkspaceFileWatcher();
});
</script>

<style scoped>
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
