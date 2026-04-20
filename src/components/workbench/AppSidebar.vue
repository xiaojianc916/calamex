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
      :active-content="document.kind === 'text' ? document.content : null"
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
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
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
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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
            <div
              v-if="rootLoading"
              class="explorer-helper-text explorer-helper-text-padded"
            >
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
            />
          </div>
        </template>
      </div>

      <footer class="explorer-statusbar">
        <span class="explorer-status-dot"></span>
        <span>{{ explorerStatusText }}</span>
      </footer>
    </section>

    <SearchSidebarPanel
      v-else-if="isSearchView"
      :document-path="document.path"
      :is-desktop-runtime="isDesktopRuntime"
      :workspace-root-path="workspaceRootPath"
      :preloaded-workspace-root="preloadedWorkspaceRoot"
      @open-file="handleOpenFile"
    />

    <template v-else>
      <div class="border-b border-(--shell-divider) px-3 py-3">
        <p class="sidebar-section-title">{{ panelMeta.title }}</p>
      </div>

      <div class="workbench-scroll-region min-h-0 flex-1 overflow-auto py-2">
        <div class="space-y-3 px-3 py-2">
          <section class="rounded-xl border border-(--border-subtle) bg-white/3 p-3">
            <p class="text-[10px] font-semibold uppercase tracking-[0.12em] text-(--text-quaternary)">
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
            <p class="text-[10px] font-semibold uppercase tracking-[0.12em] text-(--text-quaternary)">
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
import { Button } from '@/components/ui/button';
import ExplorerEntryIcon from '@/components/workbench/ExplorerEntryIcon.vue';
import SearchSidebarPanel from '@/components/workbench/SearchSidebarPanel.vue';
import SourceControlPanel from '@/components/workbench/SourceControlPanel.vue';
import WorkspaceTreeNode from '@/components/workbench/WorkspaceTreeNode.vue';
import { useMessage } from '@/composables/useMessage';
import { tauriService } from '@/services/tauri';
import type { TWorkbenchSidebarView } from '@/types/app';
import type { IEditorDocument, IWorkspaceDirectoryPayload, IWorkspaceEntry } from '@/types/editor';
import { computed, reactive, ref, watch } from 'vue';

const props = defineProps<{
  document: IEditorDocument;
  view: TWorkbenchSidebarView;
  isDesktopRuntime: boolean;
  workspaceRootPath: string | null;
  preloadedWorkspaceRoot: IWorkspaceDirectoryPayload | null;
}>();

const emit = defineEmits<{
  'open-file': [path: string];
}>();

const message = useMessage();
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

const normalizePath = (value: string): string => value.replace(/\\/g, '/').toLowerCase();

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
  extensions: {
    title: '扩展',
    headline: '能力扩展与工作流插件',
    description: '后续可以把扩展推荐、已启用能力和集成入口都集中到这里。',
    actionLabel: '扩展中心',
    items: [
      { title: '扩展建议', description: '根据当前工作流推荐合适的工具能力。' },
      { title: '已启用项', description: '管理可选增强特性和集成面板。' },
      { title: '能力说明', description: '展示每个扩展页能做什么以及如何使用。' },
    ],
  },
};

const isExplorerView = computed(() => props.view === 'explorer');
const isSearchView = computed(() => props.view === 'search');
const isSourceControlView = computed(() => props.view === 'source-control');
const panelMeta = computed(() => SIDEBAR_META[props.view]);
const normalizedExplorerSearchQuery = computed(() => explorerSearchQuery.value.trim().toLowerCase());
const hasExplorerSearch = computed(() => normalizedExplorerSearchQuery.value.length > 0);
const isRootOpen = computed(() => rootExpanded.value || hasExplorerSearch.value);

const rootEntries = computed(() => {
  if (!root.value) {
    return [];
  }

  return childrenMap[root.value.rootPath] ?? [];
});

const rootLabel = computed(() => root.value?.rootName ?? 'workspace');

const countLoadedEntries = (entries: IWorkspaceEntry[]): number =>
  entries.reduce((total, entry) => {
    const descendantCount =
      entry.kind === 'directory' ? countLoadedEntries(childrenMap[entry.path] ?? []) : 0;
    return total + 1 + descendantCount;
  }, 0);

const entryMatchesSearch = (entry: IWorkspaceEntry, query: string): boolean => {
  if (!query) {
    return true;
  }

  return (
    entry.name.toLowerCase().includes(query) ||
    normalizePath(entry.path).includes(query)
  );
};

const entryMatchesTree = (entry: IWorkspaceEntry, query: string): boolean => {
  if (!query || entryMatchesSearch(entry, query)) {
    return true;
  }

  if (entry.kind !== 'directory') {
    return false;
  }

  const descendants = childrenMap[entry.path] ?? [];
  return descendants.some((child) => entryMatchesTree(child, query));
};

const filteredRootEntries = computed(() => {
  if (!hasExplorerSearch.value) {
    return rootEntries.value;
  }

  return rootEntries.value.filter((entry) => entryMatchesTree(entry, normalizedExplorerSearchQuery.value));
});

const hasVisibleRootEntries = computed(() => filteredRootEntries.value.length > 0);
const indexedEntryCount = computed(() => countLoadedEntries(rootEntries.value));
const explorerStatusText = computed(() => {
  if (!props.isDesktopRuntime) {
    return '桌面端可用';
  }

  if (loadError.value) {
    return loadError.value;
  }

  if (rootLoading.value) {
    return '正在索引工作区…';
  }

  if (!props.workspaceRootPath) {
    return '未打开工作区';
  }

  return `${indexedEntryCount.value} 个项目 · 已索引`;
});

const getErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

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

const resolvePreloadedWorkspaceRoot = (): IWorkspaceDirectoryPayload | null => {
  if (!props.workspaceRootPath || !props.preloadedWorkspaceRoot) {
    return null;
  }

  return props.preloadedWorkspaceRoot.rootPath === props.workspaceRootPath
    ? props.preloadedWorkspaceRoot
    : null;
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

  const preloadedWorkspaceRoot = resolvePreloadedWorkspaceRoot();
  if (preloadedWorkspaceRoot) {
    applyWorkspaceRootPayload(preloadedWorkspaceRoot, workspaceKey);
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
    const payload = await tauriService.listWorkspaceEntries(undefined, props.workspaceRootPath);
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
    loadError.value = getErrorMessage(error, '读取工作区目录失败');
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
    const errorMessage = getErrorMessage(error, '读取目录失败');
    message.error(errorMessage);
    childrenMap[path] = [];
  } finally {
    loadingPaths[path] = false;
  }
};

const toggleRoot = (): void => {
  rootExpanded.value = !rootExpanded.value;
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

const handleCreatePlaceholder = (kind: 'file' | 'directory'): void => {
  message.info(kind === 'file' ? '新建文件待接入' : '新建文件夹待接入');
};

const handleRefreshExplorer = async (): Promise<void> => {
  const workspaceKey = props.workspaceRootPath ?? '__empty_workspace__';
  await loadWorkspaceRoot(workspaceKey);
};

const handleCollapseAll = (): void => {
  Object.keys(expandedPaths).forEach((path) => {
    delete expandedPaths[path];
  });
  rootExpanded.value = true;
};

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

    const workspaceKey = workspaceRootPath ?? '__empty_workspace__';
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
