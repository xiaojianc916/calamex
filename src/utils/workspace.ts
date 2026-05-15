import type { IWorkspaceDirectoryPayload, IWorkspaceEntry } from '@/types/editor';
import { normalizeFileSystemPath } from '@/utils/path';

export type TWorkspaceChildrenMap = Record<string, IWorkspaceEntry[]>;
export type TListWorkspaceEntries = (
  path?: string,
  rootPath?: string,
) => Promise<IWorkspaceDirectoryPayload>;

const EMPTY_WORKSPACE_KEY = '__empty_workspace__';

const normalizeWorkspaceQuery = (query: string): string => query.trim().toLowerCase();

export const resolveWorkspaceKey = (workspaceRootPath: string | null): string =>
  workspaceRootPath ?? EMPTY_WORKSPACE_KEY;

const resolvePreloadedWorkspaceRoot = (
  workspaceRootPath: string | null,
  preloadedWorkspaceRoot: IWorkspaceDirectoryPayload | null,
): IWorkspaceDirectoryPayload | null => {
  if (!workspaceRootPath || !preloadedWorkspaceRoot) {
    return null;
  }

  return preloadedWorkspaceRoot.rootPath === workspaceRootPath ? preloadedWorkspaceRoot : null;
};

export const resolveWorkspaceRootPayload = async (
  workspaceRootPath: string,
  preloadedWorkspaceRoot: IWorkspaceDirectoryPayload | null,
  listWorkspaceEntries: TListWorkspaceEntries,
): Promise<IWorkspaceDirectoryPayload> => {
  const matchedPreloadedRoot = resolvePreloadedWorkspaceRoot(
    workspaceRootPath,
    preloadedWorkspaceRoot,
  );
  if (matchedPreloadedRoot) {
    return matchedPreloadedRoot;
  }

  return listWorkspaceEntries(undefined, workspaceRootPath);
};

const createWorkspaceDirectoryPayload = (
  rootPath: string,
  rootName: string,
  entries: IWorkspaceEntry[] = [],
): IWorkspaceDirectoryPayload => ({
  rootPath,
  rootName,
  entries,
});

export const isWorkspaceRootAccessible = async (
  workspaceRootPath: string,
  listWorkspaceEntries: TListWorkspaceEntries,
): Promise<boolean> => {
  try {
    await listWorkspaceEntries(undefined, workspaceRootPath);
    return true;
  } catch {
    return false;
  }
};




const workspaceEntryMatchesSearch = (entry: IWorkspaceEntry, query: string): boolean => {
  const normalizedQuery = normalizeWorkspaceQuery(query);
  if (!normalizedQuery) {
    return true;
  }

  return (
    entry.name.toLowerCase().includes(normalizedQuery) ||
    normalizeFileSystemPath(entry.path).toLowerCase().includes(normalizedQuery)
  );
};

const workspaceEntryMatchesTree = (
  entry: IWorkspaceEntry,
  query: string,
  childrenMap: TWorkspaceChildrenMap,
): boolean => {
  const normalizedQuery = normalizeWorkspaceQuery(query);
  if (!normalizedQuery || workspaceEntryMatchesSearch(entry, normalizedQuery)) {
    return true;
  }

  if (entry.kind !== 'directory') {
    return false;
  }

  const descendants = childrenMap[entry.path] ?? [];
  return descendants.some((child) =>
    workspaceEntryMatchesTree(child, normalizedQuery, childrenMap),
  );
};

export const filterWorkspaceEntriesByQuery = (
  entries: IWorkspaceEntry[],
  query: string,
  childrenMap: TWorkspaceChildrenMap,
): IWorkspaceEntry[] => {
  const normalizedQuery = normalizeWorkspaceQuery(query);
  if (!normalizedQuery) {
    return entries;
  }

  return entries.filter((entry) => workspaceEntryMatchesTree(entry, normalizedQuery, childrenMap));
};

export const collectWorkspaceExpandedPathsByQuery = (
  entries: IWorkspaceEntry[],
  query: string,
  childrenMap: TWorkspaceChildrenMap,
): Set<string> => {
  const normalizedQuery = normalizeWorkspaceQuery(query);
  const expandedPaths = new Set<string>();

  if (!normalizedQuery) {
    return expandedPaths;
  }

  const visit = (entry: IWorkspaceEntry): boolean => {
    if (workspaceEntryMatchesSearch(entry, normalizedQuery)) {
      if (entry.kind === 'directory') {
        expandedPaths.add(entry.path);
      }

      return true;
    }

    if (entry.kind !== 'directory') {
      return false;
    }

    const descendants = childrenMap[entry.path] ?? [];
    const hasMatchingDescendant = descendants.some((child) => visit(child));

    if (hasMatchingDescendant) {
      expandedPaths.add(entry.path);
    }

    return hasMatchingDescendant;
  };

  entries.forEach((entry) => {
    void visit(entry);
  });

  return expandedPaths;
};

