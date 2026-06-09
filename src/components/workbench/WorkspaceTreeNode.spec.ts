import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { describe, expect, it } from 'vitest';
import type { IWorkspaceEntry } from '@/types/editor';
import WorkspaceTreeNode from './WorkspaceTreeNode.vue';
import { buildWorkspaceTreeRows } from './workspace-tree-model';

const rootEntry: IWorkspaceEntry = {
  path: 'D:/repo',
  name: 'repo',
  kind: 'directory',
  hasChildren: true,
};

const mountTree = (entry: IWorkspaceEntry) =>
  mount(WorkspaceTreeNode, {
    props: {
      entry: rootEntry,
      level: 0,
      childrenMap: {
        [rootEntry.path]: [entry],
      },
      expandedPaths: new Set([rootEntry.path]),
      loadingPaths: {},
      activePath: null,
      activeDirty: false,
      contextMenuPath: null,
      rootPath: rootEntry.path,
    },
    global: {
      plugins: [createPinia()],
    },
  });

describe('WorkspaceTreeNode', () => {
  it('treats entries with children as directories even if kind is stale', async () => {
    const directoryLikeEntry: IWorkspaceEntry = {
      path: 'D:/repo/.calamex-skills',
      name: '.calamex-skills',
      kind: 'file',
      hasChildren: true,
    };
    const wrapper = mountTree(directoryLikeEntry);

    const row = wrapper
      .findAll('.explorer-tree-row')
      .find((candidate) => candidate.text().includes('.calamex-skills'));

    expect(row).toBeDefined();

    await row!.trigger('click');

    expect(wrapper.emitted('toggle-directory')).toEqual([[directoryLikeEntry.path]]);
    expect(wrapper.emitted('open-file')).toBeUndefined();
  });

  it('flattens deep expanded trees iteratively without recursive stack pressure', () => {
    const childrenMap: Record<string, IWorkspaceEntry[]> = {};
    const expandedPaths = new Set<string>([rootEntry.path]);
    let parent = rootEntry.path;

    for (let index = 0; index < 600; index += 1) {
      const childPath = `${parent}/dir-${index}`;
      const child: IWorkspaceEntry = {
        path: childPath,
        name: `dir-${index}`,
        kind: 'directory',
        hasChildren: true,
      };
      childrenMap[parent] = [child];
      expandedPaths.add(childPath);
      parent = childPath;
    }
    childrenMap[parent] = [
      {
        path: `${parent}/leaf.sh`,
        name: 'leaf.sh',
        kind: 'file',
        hasChildren: false,
      },
    ];

    const rows = buildWorkspaceTreeRows({
      entry: rootEntry,
      level: 0,
      childrenMap,
      expandedPaths,
      loadingPaths: {},
    });

    expect(rows).toHaveLength(602);
    expect(rows[0]).toMatchObject({ type: 'entry', key: rootEntry.path, level: 0 });
    expect(rows.at(-1)).toMatchObject({ type: 'entry', key: `${parent}/leaf.sh`, level: 601 });
  });

  it('keeps inline-create rows directly after visible children', () => {
    const child: IWorkspaceEntry = {
      path: 'D:/repo/scripts/run.sh',
      name: 'run.sh',
      kind: 'file',
      hasChildren: false,
    };

    const rows = buildWorkspaceTreeRows({
      entry: rootEntry,
      level: 0,
      childrenMap: {
        [rootEntry.path]: [child],
      },
      expandedPaths: new Set([rootEntry.path]),
      loadingPaths: {},
      inlineCreateDraft: {
        open: true,
        parentPath: rootEntry.path,
        kind: 'file',
        value: '',
        placeholder: '',
      },
    });

    expect(rows.map((row) => row.key)).toEqual([
      rootEntry.path,
      child.path,
      `${rootEntry.path}::inline-create`,
    ]);
  });
});
