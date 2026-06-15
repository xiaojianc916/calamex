import { reactive, ref } from 'vue';
import { useMessage } from '@/composables/useMessage';
import { tauriService } from '@/services/tauri';
import type { IWorkspaceDirectoryPayload, IWorkspaceEntry } from '@/types/editor';
import { toErrorMessage } from '@/utils/error';
import { getRelativeFileSystemPath, normalizeFileSystemPath } from '@/utils/path';

export interface IUseWorkspaceExplorerTreeOptions {
  /** Resolves the currently loaded workspace root payload, or null. */
  getRoot: () => IWorkspaceDirectoryPayload | null;
  /** Resolves the active async request id used to cancel stale loads. */
  getActiveRequestId: () => number;
  /** Resolves the explorer-selected path used as the default state-change selection. */
  getSelectedPath: () => string | null | undefined;
  /** Notifies the host that the expanded-paths / selected-path state changed. */
  onExplorerStateChange: (payload: {
    expandedPaths: string[];
    selectedPath: string | null;
  }) => void;
}

// 刚被主动刷新过的目录在该时间窗内被视为“新鲜”，文件系统事件可跳过其重复重载。
const RECENTLY_REFRESHED_TTL_MS = 250;

/**
 * Owns the workspace explorer tree state beneath the root: cached directory
 * children, the manually expanded paths, and per-directory loading flags, plus
 * the load / expand / toggle / prune operations over that state. Extracted from
 * AppSidebar so the explorer domain owns its own tree behaviour. Root payload
 * and request-cancellation tokens are delegated back to the host via options.
 */
export function useWorkspaceExplorerTree(options: IUseWorkspaceExplorerTreeOptions) {
  const { getRoot, getActiveRequestId, getSelectedPath, onExplorerStateChange } = options;

  const message = useMessage();

  const childrenMap = reactive<Record<string, IWorkspaceEntry[]>>({});
  const manualExpandedPaths = ref<Set<string>>(new Set());
  const loadingPaths = reactive<Record<string, boolean>>({});
  const pendingReloadAgainPaths = new Set<string>();
  const recentlyRefreshedAt = new Map<string, number>();

  const normalizeRefreshedKey = (path: string): string =>
    normalizeFileSystemPath(path, {
      collapseDuplicateSeparators: true,
      trimTrailingSeparator: true,
    });

  const markDirectoryRecentlyRefreshed = (path: string): void => {
    recentlyRefreshedAt.set(normalizeRefreshedKey(path), Date.now());
  };

  const wasDirectoryRecentlyRefreshed = (path: string): boolean => {
    const key = normalizeRefreshedKey(path);
    const at = recentlyRefreshedAt.get(key);
    if (at === undefined) {
      return false;
    }
    if (Date.now() - at > RECENTLY_REFRESHED_TTL_MS) {
      recentlyRefreshedAt.delete(key);
      return false;
    }
    return true;
  };

  const emitExplorerStateChange = (
    selectedPath: string | null | undefined = getSelectedPath(),
  ): void => {
    onExplorerStateChange({
      expandedPaths: [...manualExpandedPaths.value],
      selectedPath: selectedPath ?? null,
    });
  };

  const clearTreeState = (): void => {
    Object.keys(childrenMap).forEach((path) => {
      delete childrenMap[path];
    });
    Object.keys(loadingPaths).forEach((path) => {
      delete loadingPaths[path];
    });
    pendingReloadAgainPaths.clear();
    recentlyRefreshedAt.clear();
    manualExpandedPaths.value = new Set();
  };

  const resetTreeForRoot = (
    payload: IWorkspaceDirectoryPayload,
    initialExpandedPaths: string[],
  ): void => {
    clearTreeState();
    childrenMap[payload.rootPath] = payload.entries;
    const scopedExpandedPaths = initialExpandedPaths.filter(
      (path) => getRelativeFileSystemPath(path, payload.rootPath) !== null,
    );
    manualExpandedPaths.value = new Set([payload.rootPath, ...scopedExpandedPaths]);
    emitExplorerStateChange();
  };

  const loadDirectoryEntries = async (
    path: string,
    loadOptions: { silent?: boolean } = {},
  ): Promise<void> => {
    if (loadingPaths[path]) {
      pendingReloadAgainPaths.add(path);
      return;
    }
    const requestId = getActiveRequestId();
    loadingPaths[path] = true;
    try {
      const payload = await tauriService.listWorkspaceEntries(path, getRoot()?.rootPath);
      if (requestId !== getActiveRequestId()) {
        return;
      }
      childrenMap[path] = payload.entries;
    } catch (error) {
      if (requestId !== getActiveRequestId()) {
        return;
      }
      if (!loadOptions.silent) {
        message.error(toErrorMessage(error, '读取目录失败'));
      }
      childrenMap[path] = [];
    } finally {
      if (requestId === getActiveRequestId()) {
        loadingPaths[path] = false;
      }
    }
    if (pendingReloadAgainPaths.delete(path) && requestId === getActiveRequestId()) {
      await loadDirectoryEntries(path, loadOptions);
    }
  };

  const loadInitialExpandedDirectories = async (): Promise<void> => {
    const root = getRoot();
    if (!root) {
      return;
    }
    const rootPath = root.rootPath;
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
    const root = getRoot();
    if (!root) {
      return;
    }
    if (!manualExpandedPaths.value.has(path)) {
      const nextExpandedPaths = new Set(manualExpandedPaths.value);
      nextExpandedPaths.add(path);
      manualExpandedPaths.value = nextExpandedPaths;
      emitExplorerStateChange();
    }
    if (path !== root.rootPath && childrenMap[path] === undefined) {
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

  return {
    childrenMap,
    manualExpandedPaths,
    loadingPaths,
    clearTreeState,
    resetTreeForRoot,
    loadDirectoryEntries,
    loadInitialExpandedDirectories,
    expandExplorerPath,
    toggleExplorerPath,
    resolveParentPathForMutation,
    pruneWorkspaceSubtreeState,
    markDirectoryRecentlyRefreshed,
    wasDirectoryRecentlyRefreshed,
  };
}
