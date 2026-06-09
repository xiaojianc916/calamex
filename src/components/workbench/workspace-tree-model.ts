import type { IWorkspaceEntry } from '@/types/editor';
import { areFileSystemPathsEqual } from '@/utils/path';
import type { TWorkspaceTreeRow } from './workspace-tree.types';

export type TWorkspaceTreeInlineCreateDraft = {
  open: boolean;
  parentPath: string | null;
  kind: 'file' | 'directory';
  value: string;
  placeholder: string;
};

type TBuildWorkspaceTreeRowsInput = {
  entry: IWorkspaceEntry;
  level: number;
  childrenMap: Record<string, IWorkspaceEntry[]>;
  expandedPaths: ReadonlySet<string>;
  loadingPaths: Record<string, boolean>;
  inlineCreateDraft?: TWorkspaceTreeInlineCreateDraft;
};

type TWorkspaceTreeFrame =
  | { type: 'entry'; node: IWorkspaceEntry; level: number }
  | {
      type: 'after-children';
      node: IWorkspaceEntry;
      level: number;
      rawChildren: IWorkspaceEntry[];
      isLoading: boolean;
      showInlineCreate: boolean;
    };

export const isDirectoryLikeEntry = (entry: IWorkspaceEntry): boolean =>
  entry.kind === 'directory' || entry.hasChildren;

export const normalizeTreeEntry = (entry: IWorkspaceEntry): IWorkspaceEntry => {
  if (!isDirectoryLikeEntry(entry) || entry.kind === 'directory') {
    return entry;
  }
  return {
    ...entry,
    kind: 'directory',
    hasChildren: true,
  };
};

/**
 * 将当前可见的工作区树拍平成行模型。
 *
 * 这里使用显式栈而不是递归：
 * - 深目录链不会消耗 JS 调用栈；
 * - 每个可见节点只入栈/出栈一次，配合 expanded path Set 保持 O(visible nodes)；
 * - inline-create / loading / empty 行仍保持和旧递归实现相同的顺序。
 */
export const buildWorkspaceTreeRows = ({
  entry,
  level,
  childrenMap,
  expandedPaths,
  loadingPaths,
  inlineCreateDraft,
}: TBuildWorkspaceTreeRowsInput): TWorkspaceTreeRow[] => {
  const result: TWorkspaceTreeRow[] = [];
  const stack: TWorkspaceTreeFrame[] = [{ type: 'entry', node: entry, level }];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;

    if (frame.type === 'after-children') {
      if (frame.isLoading) {
        result.push({
          type: 'loading',
          key: `${frame.node.path}::loading`,
          level: frame.level + 1,
        });
      }

      if (frame.showInlineCreate) {
        result.push({
          type: 'inline-create',
          key: `${frame.node.path}::inline-create`,
          parentPath: frame.node.path,
          level: frame.level,
        });
      }

      if (frame.rawChildren.length === 0 && !frame.showInlineCreate && !frame.isLoading) {
        result.push({ type: 'empty', key: `${frame.node.path}::empty`, level: frame.level + 1 });
      }
      continue;
    }

    const { node } = frame;
    const isDirectory = isDirectoryLikeEntry(node);
    const expanded = isDirectory && expandedPaths.has(node.path);

    result.push({
      type: 'entry',
      key: node.path,
      entry: normalizeTreeEntry(node),
      level: frame.level,
      expanded,
      showChevron: isDirectory,
    });

    if (!isDirectory || !expanded) {
      continue;
    }

    const rawChildren = childrenMap[node.path];
    const isLoading = loadingPaths[node.path] === true;
    const showInlineCreate =
      inlineCreateDraft?.open === true && areFileSystemPathsEqual(inlineCreateDraft.parentPath, node.path);

    if (rawChildren === undefined) {
      if (showInlineCreate) {
        result.push({
          type: 'inline-create',
          key: `${node.path}::inline-create`,
          parentPath: node.path,
          level: frame.level,
        });
      }
      if (isLoading) {
        result.push({ type: 'loading', key: `${node.path}::loading`, level: frame.level + 1 });
      }
      continue;
    }

    stack.push({
      type: 'after-children',
      node,
      level: frame.level,
      rawChildren,
      isLoading,
      showInlineCreate,
    });

    for (let index = rawChildren.length - 1; index >= 0; index -= 1) {
      stack.push({ type: 'entry', node: rawChildren[index]!, level: frame.level + 1 });
    }
  }

  return result;
};