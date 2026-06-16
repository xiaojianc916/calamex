import type { IWorkspaceDirectoryPayload, IWorkspaceEntry } from '@/types/editor';

export type TListWorkspaceEntries = (
  path?: string,
  rootPath?: string,
) => Promise<IWorkspaceDirectoryPayload>;

const EMPTY_WORKSPACE_KEY = '__empty_workspace__';

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

const normalizeWorkspaceQuery = (value: string): string => value.trim().toLocaleLowerCase();

export const collectWorkspaceExpandedPathsByQuery = (
  entries: readonly IWorkspaceEntry[],
  query: string,
  childrenMap: Readonly<Record<string, readonly IWorkspaceEntry[]>> = {},
): ReadonlySet<string> => {
  const normalizedQuery = normalizeWorkspaceQuery(query);
  const expandedPaths = new Set<string>();
  if (!normalizedQuery) {
    return expandedPaths;
  }

  const visit = (items: readonly IWorkspaceEntry[], ancestorPaths: readonly string[]): void => {
    for (const entry of items) {
      const haystack = normalizeWorkspaceQuery(`${entry.name} ${entry.path}`);
      if (haystack.includes(normalizedQuery)) {
        ancestorPaths.forEach((path) => {
          expandedPaths.add(path);
        });
      }

      if (entry.kind !== 'directory') {
        continue;
      }

      const children = childrenMap[entry.path] ?? [];
      if (children.length > 0) {
        visit(children, [...ancestorPaths, entry.path]);
      }
    }
  };

  visit(entries, []);
  return expandedPaths;
};
