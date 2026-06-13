import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IWorkspaceDirectoryPayload, IWorkspaceEntry } from '@/types/editor';
import { useWorkspaceExplorerMutations } from '../useWorkspaceExplorerMutations';

const { createWorkspacePathMock, successMock, errorMock } = vi.hoisted(() => ({
  createWorkspacePathMock: vi.fn(),
  successMock: vi.fn(),
  errorMock: vi.fn(),
}));

vi.mock('@/composables/useMessage', () => ({
  useMessage: () => ({ success: successMock, error: errorMock, warning: vi.fn(), info: vi.fn() }),
}));

vi.mock('@/composables/useDialog', () => ({
  useDialog: () => ({ confirm: vi.fn().mockResolvedValue('confirm') }),
}));

vi.mock('@/services/tauri', () => ({
  tauriService: {
    createWorkspacePath: (...args: unknown[]) => createWorkspacePathMock(...args),
    renameWorkspacePath: vi.fn(),
    deleteWorkspacePath: vi.fn(),
  },
}));

const ROOT: IWorkspaceDirectoryPayload = { rootPath: 'D:/repo', rootName: 'repo', entries: [] };

const createMutations = (
  overrides: { directoryEntries?: Record<string, IWorkspaceEntry[]> } = {},
) => {
  const directoryEntries = overrides.directoryEntries ?? {};
  const markDirectoryRecentlyRefreshed = vi.fn();
  const loadDirectoryEntries = vi.fn().mockResolvedValue(undefined);
  const api = useWorkspaceExplorerMutations({
    getRoot: () => ROOT,
    getWorkspaceRootPath: () => ROOT.rootPath,
    getSectionElement: () => null,
    getDirectoryEntries: (path) => directoryEntries[path],
    expandExplorerPath: vi.fn().mockResolvedValue(undefined),
    loadDirectoryEntries,
    refreshExplorer: vi.fn().mockResolvedValue(undefined),
    pruneWorkspaceSubtreeState: vi.fn(),
    markDirectoryRecentlyRefreshed,
    resolveParentPathForMutation: (path) => {
      const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
      return index <= 0 ? null : path.slice(0, index);
    },
    onOpenFile: vi.fn(),
  });
  return { api, markDirectoryRecentlyRefreshed, loadDirectoryEntries };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useWorkspaceExplorerMutations inline create', () => {
  it('右键文件时把新建父目录解析为该文件所在目录', async () => {
    const { api } = createMutations();
    await api.handleCreateWorkspaceEntry('file', {
      path: 'D:/repo/src/demo.c',
      name: 'demo.c',
      kind: 'file',
      isRoot: false,
    });
    expect(api.inlineCreateDraft.open).toBe(true);
    expect(api.inlineCreateDraft.parentPath).toBe('D:/repo/src');
    expect(api.inlineCreateDraft.placeholder).toBe('文件名称');
  });

  it('内容为空时取消草稿且不调用后端', async () => {
    const { api } = createMutations();
    await api.handleCreateWorkspaceEntry('directory', {
      path: 'D:/repo',
      name: 'repo',
      kind: 'directory',
      isRoot: true,
    });
    api.handleInlineCreateInputValue('   ');
    await api.confirmInlineCreateWorkspaceEntry();
    expect(createWorkspacePathMock).not.toHaveBeenCalled();
    expect(api.inlineCreateDraft.open).toBe(false);
  });

  it('有效名称时调用后端并标记目录已刷新', async () => {
    createWorkspacePathMock.mockResolvedValue({
      path: 'D:/repo/new.txt',
      name: 'new.txt',
      kind: 'file',
    });
    const { api, markDirectoryRecentlyRefreshed } = createMutations();
    await api.handleCreateWorkspaceEntry('file', {
      path: 'D:/repo',
      name: 'repo',
      kind: 'directory',
      isRoot: true,
    });
    api.handleInlineCreateInputValue('new.txt');
    await api.confirmInlineCreateWorkspaceEntry();
    expect(createWorkspacePathMock).toHaveBeenCalledWith({
      parentPath: 'D:/repo',
      rootPath: 'D:/repo',
      name: 'new.txt',
      kind: 'file',
    });
    expect(markDirectoryRecentlyRefreshed).toHaveBeenCalledWith('D:/repo');
    expect(api.inlineCreateDraft.open).toBe(false);
  });

  it('命中同名时报错且不调用后端', async () => {
    const { api } = createMutations({
      directoryEntries: {
        'D:/repo': [{ path: 'D:/repo/dup.txt', name: 'dup.txt', kind: 'file', hasChildren: false }],
      },
    });
    await api.handleCreateWorkspaceEntry('file', {
      path: 'D:/repo',
      name: 'repo',
      kind: 'directory',
      isRoot: true,
    });
    api.handleInlineCreateInputValue('dup.txt');
    await api.confirmInlineCreateWorkspaceEntry();
    expect(createWorkspacePathMock).not.toHaveBeenCalled();
    expect(errorMock).toHaveBeenCalled();
    expect(api.inlineCreateDraft.open).toBe(true);
  });

  it('重新打开新建草稿会切换到新的父目录并清空输入', async () => {
    const { api } = createMutations();
    await api.handleCreateWorkspaceEntry('file', {
      path: 'D:/repo/a',
      name: 'a',
      kind: 'directory',
      isRoot: false,
    });
    api.handleInlineCreateInputValue('typing');
    await api.handleCreateWorkspaceEntry('directory', {
      path: 'D:/repo/b',
      name: 'b',
      kind: 'directory',
      isRoot: false,
    });
    expect(api.inlineCreateDraft.open).toBe(true);
    expect(api.inlineCreateDraft.parentPath).toBe('D:/repo/b');
    expect(api.inlineCreateDraft.kind).toBe('directory');
    expect(api.inlineCreateDraft.value).toBe('');
  });
});
