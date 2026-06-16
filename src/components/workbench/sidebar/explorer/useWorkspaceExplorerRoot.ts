import { computed, ref } from 'vue';
import { tauriService } from '@/services/tauri';
import type { IWorkspaceDirectoryPayload, IWorkspaceEntry } from '@/types/editor';
import { toErrorMessage } from '@/utils/error/error';
import { formatFileSystemPathForDisplay, getPathBaseName } from '@/utils/file/path';
import { resolveWorkspaceKey, resolveWorkspaceRootPayload } from '@/utils/file/workspace';

export interface IUseWorkspaceExplorerRootOptions {
  isDesktopRuntime: () => boolean;
  getWorkspaceRootPath: () => string | null;
  getPreloadedWorkspaceRoot: () => IWorkspaceDirectoryPayload | null;
  getStartupExpandedPaths: () => string[];
  childrenMap: Record<string, IWorkspaceEntry[]>;
  clearTreeState: () => void;
  resetTreeForRoot: (payload: IWorkspaceDirectoryPayload, startupExpandedPaths: string[]) => void;
  loadStartupExpandedDirectories: () => Promise<void>;
  startWorkspaceFileWatcher: () => void;
}

/**
 * 资源树根加载编排：管理工作区根负载、加载状态、错误与刷新。
 * 树状态本身由 useWorkspaceExplorerTree 拥有，本组合函数通过注入的回调与其协作。
 */
export function useWorkspaceExplorerRoot(options: IUseWorkspaceExplorerRootOptions) {
  const root = ref<IWorkspaceDirectoryPayload | null>(null);
  const rootLoading = ref(false);
  const loadError = ref('');
  const loadedWorkspaceKey = ref<string | null>(null);

  let rootRequestId = 0;

  const getActiveRequestId = (): number => rootRequestId;

  const isExplorerWorkspaceEmpty = computed(() => {
    if (!root.value) {
      return false;
    }
    const rootEntries = options.childrenMap[root.value.rootPath] ?? root.value.entries;
    return rootEntries.length === 0;
  });

  const rootEntry = computed<IWorkspaceEntry | null>(() => {
    if (!root.value) {
      return null;
    }
    const rootEntries = options.childrenMap[root.value.rootPath] ?? root.value.entries;
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

  const applyWorkspaceRootPayload = (
    payload: IWorkspaceDirectoryPayload,
    workspaceKey: string,
  ): void => {
    rootLoading.value = false;
    loadError.value = '';
    root.value = payload;
    loadedWorkspaceKey.value = workspaceKey;
    options.resetTreeForRoot(payload, options.getStartupExpandedPaths());
  };

  const loadWorkspaceRoot = async (workspaceKey: string): Promise<void> => {
    if (!options.isDesktopRuntime()) {
      return;
    }
    const workspaceRootPath = options.getWorkspaceRootPath();
    if (!workspaceRootPath) {
      rootLoading.value = false;
      loadError.value = '';
      root.value = null;
      loadedWorkspaceKey.value = null;
      options.clearTreeState();
      return;
    }
    const requestId = rootRequestId + 1;
    rootRequestId = requestId;
    rootLoading.value = true;
    loadError.value = '';
    root.value = null;
    loadedWorkspaceKey.value = null;
    options.clearTreeState();
    try {
      const payload = await resolveWorkspaceRootPayload(
        workspaceRootPath,
        options.getPreloadedWorkspaceRoot(),
        tauriService.listWorkspaceEntries,
      );
      if (requestId !== rootRequestId) {
        return;
      }
      applyWorkspaceRootPayload(payload, workspaceKey);
      void options.loadStartupExpandedDirectories();
      options.startWorkspaceFileWatcher();
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

  const handleRefreshExplorer = async (): Promise<void> => {
    const workspaceKey = resolveWorkspaceKey(options.getWorkspaceRootPath());
    await loadWorkspaceRoot(workspaceKey);
  };

  return {
    root,
    rootLoading,
    loadError,
    loadedWorkspaceKey,
    getActiveRequestId,
    isExplorerWorkspaceEmpty,
    rootEntry,
    applyWorkspaceRootPayload,
    loadWorkspaceRoot,
    handleRefreshExplorer,
  };
}
