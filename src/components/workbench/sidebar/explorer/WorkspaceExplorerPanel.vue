<template>
  <section
    ref="explorerSectionRef"
    class="explorer-sidebar"
    :class="{ 'is-scrollbar-active': isExplorerScrollbarActive }"
    aria-label="资源管理器"
  >
    <div
      class="explorer-tree"
      @scroll.passive="handleExplorerTreeScroll"
      @contextmenu.prevent="handleEmptyAreaContextMenu"
    >
      <WorkspaceExplorerEmptyState
        v-if="!isExplorerContentReady"
        :is-desktop-runtime="isDesktopRuntime"
        :load-error="loadError"
        :root-loading="rootLoading"
        :has-root="Boolean(root)"
        :workspace-root-path="workspaceRootPath"
        :is-workspace-empty="isExplorerWorkspaceEmpty"
        @open-folder="emit('open-folder')"
      />
      <WorkspaceExplorerTree
        v-else-if="rootEntry && root"
        :entry="rootEntry"
        :children-map="childrenMap"
        :expanded-paths="manualExpandedPaths"
        :loading-paths="loadingPaths"
        :active-path="document.path"
        :active-dirty="document.isDirty"
        :context-menu-path="explorerContextMenuHighlightPath"
        :inline-create-draft="inlineCreateDraft"
        :root-path="root.rootPath"
        :inline-rename-draft="inlineRenameDraft"
        @toggle-directory="void toggleExplorerPath($event)"
        @open-file="handleOpenFile"
        @context-menu="handleEntryContextMenu"
        @inline-create-input="handleInlineCreateInputValue"
        @inline-create-blur="handleInlineCreateBlur"
        @inline-create-confirm="void confirmInlineCreateWorkspaceEntry()"
        @inline-create-cancel="cancelInlineCreateWorkspaceEntry"
        @inline-rename-input="inlineRenameDraft.value = $event"
        @inline-rename-confirm="void confirmInlineRename()"
        @inline-rename-cancel="cancelInlineRename"
      />
    </div>
    <WorkspaceExplorerContextMenu
      :open="explorerContextMenu.open"
      :x="explorerContextMenu.x"
      :y="explorerContextMenu.y"
      :groups="explorerContextMenuGroups"
      :theme="appStore.theme"
      @select="handleExplorerContextMenuSelect"
    />
  </section>
</template>

<script setup lang="ts">
import { useEventListener, useTimeoutFn } from '@vueuse/core';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useWorkspaceExplorerContextMenu } from '@/components/workbench/sidebar/explorer/useWorkspaceExplorerContextMenu';
import { useWorkspaceExplorerMutations } from '@/components/workbench/sidebar/explorer/useWorkspaceExplorerMutations';
import { useWorkspaceExplorerRoot } from '@/components/workbench/sidebar/explorer/useWorkspaceExplorerRoot';
import { useWorkspaceExplorerTree } from '@/components/workbench/sidebar/explorer/useWorkspaceExplorerTree';
import { useWorkspaceFileWatcher } from '@/components/workbench/sidebar/explorer/useWorkspaceFileWatcher';
import WorkspaceExplorerContextMenu from '@/components/workbench/sidebar/explorer/WorkspaceExplorerContextMenu.vue';
import WorkspaceExplorerEmptyState from '@/components/workbench/sidebar/explorer/WorkspaceExplorerEmptyState.vue';
import WorkspaceExplorerTree from '@/components/workbench/sidebar/explorer/WorkspaceExplorerTree.vue';
import { useMessage } from '@/composables/useMessage';
import { useAppStore } from '@/store/app';
import type {
  IEditorDocument,
  IWorkspaceDirectoryPayload,
  TWorkbenchOpenFilePayload,
} from '@/types/editor';
import { normalizeFileSystemPath } from '@/utils/file/path';
import { resolveWorkspaceKey } from '@/utils/file/workspace';
import { writeClipboardText, writeFileSystemPathToClipboard } from '@/utils/platform/clipboard';

const EXPLORER_SCROLLBAR_IDLE_HIDE_DELAY_MS = 900;

const props = defineProps<{
  document: IEditorDocument;
  isActive: boolean;
  isDesktopRuntime: boolean;
  workspaceRootPath: string | null;
  preloadedWorkspaceRoot: IWorkspaceDirectoryPayload | null;
  startupExplorerExpandedPaths: string[];
  startupExplorerSelectedPath: string | null;
}>();

const emit = defineEmits<{
  'open-file': [payload: TWorkbenchOpenFilePayload];
  'open-folder': [];
  'explorer-state-change': [payload: { expandedPaths: string[]; selectedPath: string | null }];
}>();

const message = useMessage();
const appStore = useAppStore();

const explorerSectionRef = ref<HTMLElement | null>(null);
const isExplorerScrollbarActive = ref(false);

// 滚动后 EXPLORER_SCROLLBAR_IDLE_HIDE_DELAY_MS 自动隐藏滚动条高亮；
// immediate: false 仅在 handleExplorerTreeScroll 时 start。
const { start: scheduleExplorerScrollbarIdleHide } = useTimeoutFn(
  () => {
    isExplorerScrollbarActive.value = false;
  },
  EXPLORER_SCROLLBAR_IDLE_HIDE_DELAY_MS,
  { immediate: false },
);

const handleExplorerTreeScroll = (): void => {
  isExplorerScrollbarActive.value = true;
  scheduleExplorerScrollbarIdleHide();
};

const selectedExplorerPath = computed(
  () => props.document.path ?? props.startupExplorerSelectedPath ?? undefined,
);

const {
  childrenMap,
  manualExpandedPaths,
  loadingPaths,
  clearTreeState,
  resetTreeForRoot,
  loadDirectoryEntries,
  loadStartupExpandedDirectories,
  expandExplorerPath,
  toggleExplorerPath,
  resolveParentPathForMutation,
  pruneWorkspaceSubtreeState,
  markDirectoryRecentlyRefreshed,
  wasDirectoryRecentlyRefreshed,
} = useWorkspaceExplorerTree({
  getRoot: () => root.value,
  getActiveRequestId: () => getActiveRequestId(),
  getSelectedPath: () => selectedExplorerPath.value,
  onExplorerStateChange: (payload) => emit('explorer-state-change', payload),
});

const {
  root,
  rootLoading,
  loadError,
  loadedWorkspaceKey,
  getActiveRequestId,
  isExplorerWorkspaceEmpty,
  rootEntry,
  loadWorkspaceRoot,
  handleRefreshExplorer,
} = useWorkspaceExplorerRoot({
  isDesktopRuntime: () => props.isDesktopRuntime,
  getWorkspaceRootPath: () => props.workspaceRootPath,
  getPreloadedWorkspaceRoot: () => props.preloadedWorkspaceRoot,
  getStartupExpandedPaths: () => props.startupExplorerExpandedPaths,
  childrenMap,
  clearTreeState,
  resetTreeForRoot,
  loadStartupExpandedDirectories,
  startWorkspaceFileWatcher: () => startWorkspaceFileWatcher(),
});

const handleOpenFile = (payload: TWorkbenchOpenFilePayload): void => {
  emit('open-file', payload);
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
  getDirectoryEntries: (path) => childrenMap[path],
  expandExplorerPath,
  loadDirectoryEntries,
  refreshExplorer: handleRefreshExplorer,
  pruneWorkspaceSubtreeState,
  markDirectoryRecentlyRefreshed,
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
  onCopyRelativePath: async (target) => {
    // 复制相对于工作区根的路径。getRelativeFileSystemPath 会在 Windows 上整体转小写
    // （仅适合相等/包含判断），这里需要保留文件名原始大小写，因此用 foldWindowsCase: false
    // 归一化后自行做（Windows 上大小写不敏感的）前缀匹配，并还原平台原生分隔符。
    const rootPath = root.value?.rootPath ?? props.workspaceRootPath;
    const normalizeOptions = {
      collapseDuplicateSeparators: true,
      trimTrailingSeparator: true,
      foldWindowsCase: false,
    } as const;
    const normalizedFull = normalizeFileSystemPath(target.path, normalizeOptions);
    const normalizedRoot = normalizeFileSystemPath(rootPath, normalizeOptions);
    const windowsStyle = /^[a-zA-Z]:\//.test(normalizedFull) || normalizedFull.startsWith('//');
    const rootWithSep =
      !normalizedRoot || normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
    const hasRelative =
      Boolean(normalizedFull) &&
      Boolean(rootWithSep) &&
      (windowsStyle
        ? normalizedFull.toLowerCase().startsWith(rootWithSep.toLowerCase())
        : normalizedFull.startsWith(rootWithSep));
    if (!hasRelative) {
      // 不在工作区根之下（或解析失败 / 即根目录本身）时回退到绝对路径。
      await writeFileSystemPathToClipboard(target.path);
      message.success('已复制路径');
      return;
    }
    const relativePath = normalizedFull.slice(rootWithSep.length);
    await writeClipboardText(windowsStyle ? relativePath.replace(/\//g, '\\') : relativePath);
    message.success('已复制相对路径');
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
  wasDirectoryRecentlyRefreshed,
});

const isExplorerContentReady = computed(
  () =>
    props.isDesktopRuntime &&
    !loadError.value &&
    !(rootLoading.value && !root.value) &&
    Boolean(props.workspaceRootPath) &&
    Boolean(root.value),
);

watch(
  [
    () => props.isDesktopRuntime,
    () => props.workspaceRootPath,
    () => props.isActive,
    () => props.preloadedWorkspaceRoot,
  ],
  ([ready, workspaceRootPath, active]) => {
    if (!ready || !active) {
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
  stopWorkspaceFileWatcher();
});
</script>
