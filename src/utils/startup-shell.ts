import type { TSessionSnapshot, TSessionTabKind } from '@/types/session';
import { StartupShellStateSchema, type TStartupShellState } from '@/types/startup-shell';
import { isImageAssetPath } from '@/utils/file-assets';
import { getPathBaseName, normalizeFileSystemPath } from '@/utils/path';

const resolveTabKind = (path: string, kind?: TSessionTabKind): TSessionTabKind =>
  kind ?? (isImageAssetPath(path) ? 'image' : 'text');

const resolveActiveTabPath = (snapshot: TSessionSnapshot): string | null => {
  const orderedTabs = [...snapshot.openTabs].sort((left, right) => left.order - right.order);
  if (snapshot.activeTabPath) {
    const normalizedActivePath = normalizeFileSystemPath(snapshot.activeTabPath);
    const activeTab = orderedTabs.find(
      (tab) => normalizeFileSystemPath(tab.path) === normalizedActivePath,
    );
    if (activeTab) {
      return activeTab.path;
    }
  }

  return orderedTabs[0]?.path ?? null;
};

export const createStartupShellState = (snapshot: TSessionSnapshot): TStartupShellState => {
  const activeTabPath = resolveActiveTabPath(snapshot);
  const normalizedActivePath = activeTabPath ? normalizeFileSystemPath(activeTabPath) : null;
  const workspaceName = snapshot.workspaceRoot ? getPathBaseName(snapshot.workspaceRoot) : null;
  const explorerSelectedPath = snapshot.workbench.explorerSelectedPath ?? activeTabPath;

  const openTabs = [...snapshot.openTabs]
    .sort((left, right) => left.order - right.order)
    .map((tab, index) => {
      const normalizedPath = normalizeFileSystemPath(tab.path);
      return {
        id: `${index}-${normalizedPath}`,
        path: tab.path,
        title: getPathBaseName(tab.path),
        kind: resolveTabKind(tab.path, tab.kind),
        order: tab.order,
        isActive: normalizedActivePath !== null && normalizedPath === normalizedActivePath,
      };
    });

  const parsed = StartupShellStateSchema.safeParse({
    schemaVersion: 1,
    workspaceRoot: snapshot.workspaceRoot,
    workspaceName,
    activeSidebarView: snapshot.workbench.activeSidebarView,
    explorerExpandedPaths: snapshot.workbench.explorerExpandedPaths,
    explorerSelectedPath,
    isTerminalVisible: snapshot.workbench.isTerminalVisible,
    openTabs,
    activeTabPath,
  });

  if (parsed.success) {
    return parsed.data;
  }

  return {
    schemaVersion: 1,
    workspaceRoot: null,
    workspaceName: null,
    activeSidebarView: 'explorer',
    explorerExpandedPaths: [],
    explorerSelectedPath: null,
    isTerminalVisible: true,
    openTabs: [],
    activeTabPath: null,
  };
};
