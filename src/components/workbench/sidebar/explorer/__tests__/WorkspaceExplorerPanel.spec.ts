import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { describe, expect, it, vi } from 'vitest';
import type { IEditorDocument, IWorkspaceDirectoryPayload } from '@/types/editor';
import WorkspaceExplorerPanel from '../WorkspaceExplorerPanel.vue';

vi.mock('@/components/common/LinearContextMenu.vue', () => ({
  name: 'LinearContextMenu',
  __isKeepAlive: false,
  __isTeleport: false,
  default: { name: 'LinearContextMenu', render: () => null },
}));

const documentFixture: IEditorDocument = {
  id: 'doc-1',
  path: null,
  name: 'untitled.sh',
  kind: 'text',
  content: '',
  encoding: 'utf-8',
  savedContent: '',
  savedEncoding: 'utf-8',
  isDirty: false,
  lineCount: 1,
  charCount: 0,
};

const emptyWorkspaceRoot: IWorkspaceDirectoryPayload = {
  rootPath: 'D:/repo',
  rootName: 'repo',
  entries: [],
};

const populatedWorkspaceRoot: IWorkspaceDirectoryPayload = {
  rootPath: 'D:/repo',
  rootName: 'repo',
  entries: [
    {
      path: 'D:/repo/demo.c',
      name: 'demo.c',
      kind: 'file',
      hasChildren: false,
    },
  ],
};

const mountPanel = (
  document: IEditorDocument,
  preloadedWorkspaceRoot: IWorkspaceDirectoryPayload,
) =>
  mount(WorkspaceExplorerPanel, {
    props: {
      document,
      isActive: true,
      isDesktopRuntime: true,
      workspaceRootPath: 'D:/repo',
      preloadedWorkspaceRoot,
      startupExplorerExpandedPaths: [],
      startupExplorerSelectedPath: null,
    },
    global: {
      plugins: [createPinia()],
    },
  });

describe('WorkspaceExplorerPanel', () => {
  it('空工作区时显示 Empty 装饰并允许打开文件夹', async () => {
    const wrapper = mountPanel(documentFixture, emptyWorkspaceRoot);

    await flushPromises();

    expect(wrapper.text()).toContain('This folder is empty');

    await wrapper.get('.explorer-empty-action').trigger('click');

    expect(wrapper.emitted('open-folder')).toHaveLength(1);
  });

  it('右键未选中文件时会保留临时高亮，菜单关闭后清除', async () => {
    const wrapper = mountPanel(documentFixture, populatedWorkspaceRoot);

    await flushPromises();

    const row = wrapper
      .findAll('.explorer-tree-row')
      .find((candidate) => candidate.text().includes('demo.c'));

    expect(row).toBeDefined();

    await row!.trigger('contextmenu', {
      clientX: 80,
      clientY: 120,
    });
    await flushPromises();

    expect(row!.classes()).toContain('is-context-target');
    expect(row!.classes()).not.toContain('is-active');

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await flushPromises();

    expect(row!.classes()).not.toContain('is-context-target');
  });

  it('右键当前已选中文件时不叠加临时高亮类', async () => {
    const wrapper = mountPanel(
      {
        ...documentFixture,
        path: 'D:/repo/demo.c',
        name: 'demo.c',
      },
      populatedWorkspaceRoot,
    );

    await flushPromises();

    const row = wrapper
      .findAll('.explorer-tree-row')
      .find((candidate) => candidate.text().includes('demo.c'));

    expect(row).toBeDefined();
    expect(row!.classes()).toContain('is-active');

    await row!.trigger('contextmenu', {
      clientX: 80,
      clientY: 120,
    });
    await flushPromises();

    expect(row!.classes()).toContain('is-active');
    expect(row!.classes()).not.toContain('is-context-target');
  });
});
