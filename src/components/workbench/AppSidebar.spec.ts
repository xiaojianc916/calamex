import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { TooltipProvider } from 'reka-ui';
import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import type { IEditorDocument, IWorkspaceDirectoryPayload } from '@/types/editor';
import AppSidebar from './AppSidebar.vue';

const documentFixture = {
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

const baseStubs = {
  SourceControlPanel: true,
  DeferredSearchSidebarPanel: true,
  DeferredRunSidebarPanel: true,
  DeferredSshSidebarPanel: true,
  DeferredLinearContextMenu: true,
};

// reka-ui 的 Tooltip 基元需要祖先 TooltipProvider;单测用一个 provider 包裹被测组件。
const mountInProvider = (renderChild: () => ReturnType<typeof h>, stubs: Record<string, unknown>) =>
  mount(
    defineComponent({
      setup() {
        return () => h(TooltipProvider, null, { default: renderChild });
      },
    }),
    {
      global: {
        plugins: [createPinia()],
        stubs,
      },
    },
  );

const mountExplorerSidebar = (document: IEditorDocument) =>
  mountInProvider(
    () =>
      h(AppSidebar, {
        document,
        view: 'explorer',
        isDesktopRuntime: true,
        workspaceRootPath: 'D:/repo',
        preloadedWorkspaceRoot: populatedWorkspaceRoot,
        startupExplorerExpandedPaths: [],
        startupExplorerSelectedPath: null,
        canRun: true,
        isRunning: false,
        hasRunArtifacts: false,
        activeRun: null,
        runHistory: [],
        commandTemplates: [],
        executor: 'wsl',
      }),
    baseStubs,
  );

describe('AppSidebar', () => {
  it('空工作区时显示 Empty 装饰并允许打开文件夹', async () => {
    const wrapper = mountInProvider(
      () =>
        h(AppSidebar, {
          document: documentFixture,
          view: 'explorer',
          isDesktopRuntime: true,
          workspaceRootPath: 'D:/repo',
          preloadedWorkspaceRoot: emptyWorkspaceRoot,
          startupExplorerExpandedPaths: [],
          startupExplorerSelectedPath: null,
          canRun: true,
          isRunning: false,
          hasRunArtifacts: false,
          activeRun: null,
          runHistory: [],
          commandTemplates: [],
          executor: 'wsl',
        }),
      {
        ...baseStubs,
        FileTree: true,
        WorkspaceTreeNode: true,
      },
    );

    await flushPromises();

    expect(wrapper.text()).toContain('空文件夹');

    await wrapper.get('.explorer-empty-action').trigger('click');

    expect(wrapper.findComponent(AppSidebar).emitted('open-folder')).toHaveLength(1);
  });

  it('右键未选中文件时会保留临时高亮，菜单关闭后清除', async () => {
    const wrapper = mountExplorerSidebar(documentFixture);

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
    const wrapper = mountExplorerSidebar({
      ...documentFixture,
      path: 'D:/repo/demo.c',
      name: 'demo.c',
    });

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
