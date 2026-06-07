import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { describe, expect, it } from 'vitest';
import type { IWorkspaceEntry } from '@/types/editor';
import WorkspaceTreeNode from './WorkspaceTreeNode.vue';

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
});
