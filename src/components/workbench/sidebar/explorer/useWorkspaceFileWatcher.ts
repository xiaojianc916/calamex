import { useDebounceFn } from '@vueuse/core';
import type { Ref } from 'vue';
import { events } from '@/bindings/tauri';
import { tauriService } from '@/services/tauri';
import { useGitStore } from '@/store/git';
import type { IWorkspaceDirectoryPayload, IWorkspaceEntry } from '@/types/editor';
import { areFileSystemPathsEqual } from '@/utils/path';

interface FsChange {
  path: string;
  kind: 'created' | 'modified' | 'removed' | 'renamed';
}

interface WorkspaceFsEvent {
  changes: FsChange[];
  rootPath: string;
}

export interface IUseWorkspaceFileWatcherOptions {
  /** Reactive reference to the currently loaded workspace root payload. */
  root: Ref<IWorkspaceDirectoryPayload | null>;
  /** Resolver for the workspace root path fallback (e.g. props.workspaceRootPath). */
  getWorkspaceRootPath: () => string | null;
  /** Reactive map of already-loaded directory entries keyed by absolute path. */
  childrenMap: Record<string, IWorkspaceEntry[]>;
  /** Reloads the entries for a single directory. */
  loadDirectoryEntries: (path: string, options?: { silent?: boolean }) => Promise<void>;
  /** Drops cached state for a path and everything beneath it. */
  pruneWorkspaceSubtreeState: (path: string) => void;
  /** Resolves the parent directory path for a mutated entry. */
  resolveParentPathForMutation: (path: string) => string | null;
  /** Reports whether a directory was just reloaded by an explicit mutation. */
  wasDirectoryRecentlyRefreshed: (path: string) => boolean;
}

export interface IUseWorkspaceFileWatcherReturn {
  startWorkspaceFileWatcher: () => Promise<void>;
  stopWorkspaceFileWatcher: () => void;
}

/**
 * Watches the active workspace root for filesystem changes and keeps the
 * explorer tree (and Git status) in sync. Extracted from AppSidebar so the
 * explorer domain owns its own filesystem-watching lifecycle.
 */
export function useWorkspaceFileWatcher(
  options: IUseWorkspaceFileWatcherOptions,
): IUseWorkspaceFileWatcherReturn {
  const {
    root,
    getWorkspaceRootPath,
    childrenMap,
    loadDirectoryEntries,
    pruneWorkspaceSubtreeState,
    resolveParentPathForMutation,
    wasDirectoryRecentlyRefreshed,
  } = options;
  const gitStore = useGitStore();

  let fsEventUnlisten: (() => void) | null = null;
  let isFsWatcherStarting = false;
  const pendingFsReloadDirs = new Set<string>();

  const flushPendingFsReloads = useDebounceFn(async (): Promise<void> => {
    const dirs = [...pendingFsReloadDirs];
    pendingFsReloadDirs.clear();
    for (const dir of dirs) {
      if (childrenMap[dir] === undefined) continue;
      // 若该目录刚因显式增删改主动刷新过，跳过这次由文件系统事件触发的重复重载，避免闪烁。
      if (wasDirectoryRecentlyRefreshed(dir)) continue;
      await loadDirectoryEntries(dir);
    }
  }, 80);

  const refreshGitStatusAfterFsEvent = useDebounceFn(async (): Promise<void> => {
    const rootPath = root.value?.rootPath ?? getWorkspaceRootPath();
    if (!rootPath) return;
    try {
      await gitStore.refreshRepositoryStatus(rootPath);
    } catch (error) {
      console.warn('[AppSidebar] Failed to refresh Git status after workspace file change.', error);
    }
  }, 120);

  function handleFileSystemEvent(payload: WorkspaceFsEvent): void {
    if (!root.value || !areFileSystemPathsEqual(payload.rootPath, root.value.rootPath)) return;
    for (const change of payload.changes) {
      if (change.kind === 'removed' || change.kind === 'renamed') {
        pruneWorkspaceSubtreeState(change.path);
      }
      const parent = resolveParentPathForMutation(change.path);
      if (parent) pendingFsReloadDirs.add(parent);
    }
    void flushPendingFsReloads();
    void refreshGitStatusAfterFsEvent();
  }

  function stopWorkspaceFileWatcher(): void {
    const wasWatching = fsEventUnlisten !== null || isFsWatcherStarting;
    fsEventUnlisten?.();
    fsEventUnlisten = null;
    isFsWatcherStarting = false;
    pendingFsReloadDirs.clear();
    if (wasWatching) {
      void tauriService.stopWorkspaceWatching();
    }
  }

  async function startWorkspaceFileWatcher(): Promise<void> {
    const rootPath = root.value?.rootPath;
    if (!rootPath) return;
    if (fsEventUnlisten || isFsWatcherStarting) return;
    isFsWatcherStarting = true;
    try {
      if (!fsEventUnlisten) {
        fsEventUnlisten = await events.workspaceFsEvent.listen((e) => {
          handleFileSystemEvent(e.payload);
        });
      }
      if (!areFileSystemPathsEqual(root.value?.rootPath ?? null, rootPath)) {
        fsEventUnlisten?.();
        fsEventUnlisten = null;
        return;
      }
      try {
        await tauriService.startWorkspaceWatching(rootPath);
      } catch (error) {
        console.warn('[AppSidebar] Failed to start workspace file watcher.', error);
        fsEventUnlisten?.();
        fsEventUnlisten = null;
      }
    } finally {
      isFsWatcherStarting = false;
    }
  }

  return { startWorkspaceFileWatcher, stopWorkspaceFileWatcher };
}
