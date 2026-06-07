import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IEditorDocument, IWorkspaceDirectoryPayload } from '@/types/editor';
import AppSidebar from './AppSidebar.vue';

const asyncPanelStub = (name: string) => ({
  default: { name, render: () => null },
});

const workspaceFsEventListenMock = vi.fn();
const refreshRepositoryStatusMock = vi.fn();
const tauriServiceMock = {
  listWorkspaceEntries: vi.fn(),
  startWorkspaceWatching: vi.fn(),
  stopWorkspaceWatching: vi.fn(),
  createWorkspacePath: vi.fn(),
  renameWorkspacePath: vi.fn(),
  deleteWorkspacePath: vi.fn(),
};

vi.mock('@/bindings/tauri', () => ({
  events: {
    workspaceFsEvent: {
      listen: workspaceFsEventListenMock,
    },
  },
}));
vi.mock('@/services/tauri', () => ({
  tauriService: tauriServiceMock,
}));
vi.mock('@/store/git', () => ({
  useGitStore: () => ({
    refreshRepositoryStatus: refreshRepositoryStatusMock,
  }),
}));
vi.mock('@/components/workbench/SshSidebarPanel.vue', () => asyncPanelStub('SshSidebarPanel'));
vi.mock('@/components/workbench/SearchSidebarPanel.vue', () =>
  asyncPanelStub('SearchSidebarPanel'),
);
vi.mock('@/components/workbench/RunSidebarPanel.vue', () => asyncPanelStub('RunSidebarPanel'));
vi.mock('@/components/workbench/SourceControlPanel.vue', () =>
  asyncPanelStub('SourceControlPanel'),
);
vi.mock('@/components/common/LinearContextMenu.vue', () => asyncPanelStub('LinearContextMenu'));

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
    {
      path: 'D:/repo/src',
      name: 'src',
      kind: 'directory',
      hasChildren: true,
    },
  ],
};

const nextWorkspaceRoot: IWorkspaceDirectoryPayload = {
  rootPath: 'D:/repo-next',
  rootName: 'repo-next',
  entries: [],
};

const mountExplorerSidebar = (
  document: IEditorDocument,
  options: {
    workspaceRootPath?: string | null;
    preloadedWorkspaceRoot?: IWorkspaceDirectoryPayload | null;
  } = {},
) => {
  return mount(AppSidebar, {
    props: {
      document,
      view: 'explorer',
      isDesktopRuntime: true,
      workspaceRootPath: options.workspaceRootPath ?? 'D:/repo',
      preloadedWorkspaceRoot: options.preloadedWorkspaceRoot ?? populatedWorkspaceRoot,
      startupExplorerExpandedPaths: [],
      startupExplorerSelectedPath: null,
      canRun: true,
      isRunning: false,
      hasRunArtifacts: false,
      activeRun: null,
      runHistory: [],
      commandTemplates: [],
      executor: 'wsl',
    },
    global: {
      plugins: [createPinia()],
      stubs: {
        SourceControlPanel: true,
        DeferredSearchSidebarPanel: true,
        DeferredRunSidebarPanel: true,
        DeferredSshSidebarPanel: true,
        DeferredLinearContextMenu: true,
      },
    },
  });
};

describe('AppSidebar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    workspaceFsEventListenMock.mockResolvedValue(vi.fn());
    tauriServiceMock.listWorkspaceEntries.mockResolvedValue({
      rootPath: 'D:/repo',
      rootName: 'repo',
      entries: [],
    });
    tauriServiceMock.startWorkspaceWatching.mockResolvedValue(undefined);
    tauriServiceMock.stopWorkspaceWatching.mockResolvedValue(undefined);
    refreshRepositoryStatusMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('空工作区时显示 Empty 装饰并允许打开文件夹', async () => {
    const wrapper = mount(AppSidebar, {
      props: {
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
      },
      global: {
        plugins: [createPinia()],
        stubs: {
          SourceControlPanel: true,
          DeferredSearchSidebarPanel: true,
          DeferredRunSidebarPanel: true,
          DeferredSshSidebarPanel: true,
          DeferredLinearContextMenu: true,
          FileTree: true,
          WorkspaceTreeNode: true,
        },
      },
    });

    await flushPromises();

    expect(wrapper.text()).toContain('This folder is empty');

    await wrapper.get('.explorer-empty-action').trigger('click');

    expect(wrapper.emitted('open-folder')).toHaveLength(1);
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

  it('监听启动过程中切换工作区会注销旧 listener，避免旧 watcher 挂回当前界面', async () => {
    const staleUnlisten = vi.fn();
    let resolveListen: ((unlisten: () => void) => void) | null = null;
    workspaceFsEventListenMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveListen = resolve;
      }),
    );
    const wrapper = mountExplorerSidebar(documentFixture);

    await flushPromises();
    expect(workspaceFsEventListenMock).toHaveBeenCalledTimes(1);

    await wrapper.setProps({
      workspaceRootPath: 'D:/repo-next',
      preloadedWorkspaceRoot: nextWorkspaceRoot,
    });
    resolveListen?.(staleUnlisten);
    await flushPromises();

    expect(staleUnlisten).toHaveBeenCalledTimes(1);
    expect(tauriServiceMock.startWorkspaceWatching).not.toHaveBeenCalledWith('D:/repo');
  });

  it('旧工作区文件事件不会触发目录刷新或 Git 状态刷新', async () => {
    let listener: ((event: { payload: unknown }) => void) | null = null;
    workspaceFsEventListenMock.mockImplementationOnce(async (callback) => {
      listener = callback;
      return vi.fn();
    });
    const wrapper = mountExplorerSidebar(documentFixture);
    await flushPromises();

    await wrapper.setProps({
      workspaceRootPath: 'D:/repo-next',
      preloadedWorkspaceRoot: nextWorkspaceRoot,
    });
    await flushPromises();

    listener?.({
      payload: {
        rootPath: 'D:/repo',
        changes: [{ path: 'D:/repo/src/demo.c', kind: 'modified' }],
      },
    });
    await vi.advanceTimersByTimeAsync(200);

    expect(tauriServiceMock.listWorkspaceEntries).not.toHaveBeenCalledWith('D:/repo/src', 'D:/repo-next');
    expect(refreshRepositoryStatusMock).not.toHaveBeenCalledWith('D:/repo');
  });
});
