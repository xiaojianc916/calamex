import { describe, expect, it } from 'vitest';
import type { IWorkspaceEntry } from '@/types/editor';
import { collectWorkspaceExpandedPathsByQuery } from '@/utils/file/workspace';

const createEntry = (
  path: string,
  name: string,
  kind: IWorkspaceEntry['kind'],
  hasChildren = false,
): IWorkspaceEntry => ({
  path,
  name,
  kind,
  hasChildren,
});

describe('workspace utils', () => {
  it('搜索命中深层文件时会收集祖先目录作为展开路径', () => {
    const entries = [
      createEntry('src', 'src', 'directory', true),
      createEntry('README.md', 'README.md', 'file'),
    ];
    const childrenMap = {
      src: [
        createEntry('src/components', 'components', 'directory', true),
        createEntry('src/main.ts', 'main.ts', 'file'),
      ],
      'src/components': [createEntry('src/components/FileTree.vue', 'FileTree.vue', 'file')],
    } satisfies Record<string, IWorkspaceEntry[]>;

    const expandedPaths = [
      ...collectWorkspaceExpandedPathsByQuery(entries, 'filetree', childrenMap),
    ].sort();

    expect(expandedPaths).toEqual(['src', 'src/components']);
  });

  it('搜索仅命中顶层文件时不会额外展开目录', () => {
    const entries = [
      createEntry('src', 'src', 'directory', true),
      createEntry('README.md', 'README.md', 'file'),
    ];
    const childrenMap = {
      src: [
        createEntry('src/components', 'components', 'directory', true),
        createEntry('src/main.ts', 'main.ts', 'file'),
      ],
      'src/components': [createEntry('src/components/FileTree.vue', 'FileTree.vue', 'file')],
    } satisfies Record<string, IWorkspaceEntry[]>;

    const expandedPaths = [...collectWorkspaceExpandedPathsByQuery(entries, 'readme', childrenMap)];

    expect(expandedPaths).toEqual([]);
  });
});
