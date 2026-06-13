import { nextTick, reactive, ref } from 'vue';
import type { IExplorerContextTarget } from '@/components/workbench/sidebar/explorer/useWorkspaceExplorerContextMenu';
import { useDialog } from '@/composables/useDialog';
import { useMessage } from '@/composables/useMessage';
import { tauriService } from '@/services/tauri';
import type { IWorkspaceDirectoryPayload, TWorkbenchOpenFilePayload } from '@/types/editor';
import { toErrorMessage } from '@/utils/error';

export interface IUseWorkspaceExplorerMutationsOptions {
  /** Resolves the currently loaded workspace root payload, or null. */
  getRoot: () => IWorkspaceDirectoryPayload | null;
  /** Resolves the workspace root path fallback (e.g. props.workspaceRootPath). */
  getWorkspaceRootPath: () => string | null;
  /** Resolves the explorer section host element used for inline-input focus. */
  getSectionElement: () => HTMLElement | null;
  /** Ensures the given directory path is expanded (and its entries loaded). */
  expandExplorerPath: (path: string) => Promise<void>;
  /** Reloads the entries for a single directory. */
  loadDirectoryEntries: (path: string, options?: { silent?: boolean }) => Promise<void>;
  /** Reloads the entire workspace root tree. */
  refreshExplorer: () => Promise<void>;
  /** Drops cached state for a path and everything beneath it. */
  pruneWorkspaceSubtreeState: (path: string) => void;
  /** Resolves the parent directory path for a mutated entry. */
  resolveParentPathForMutation: (path: string) => string | null;
  /** Opens a file in the editor. */
  onOpenFile: (payload: TWorkbenchOpenFilePayload) => void;
}

/**
 * Owns workspace explorer filesystem mutations: the inline create/rename draft
 * state plus the create, rename, and delete flows. Extracted from AppSidebar so
 * the explorer domain owns its own mutation behaviour. Tree/root state access is
 * delegated back to the host via the options callbacks.
 */
export function useWorkspaceExplorerMutations(options: IUseWorkspaceExplorerMutationsOptions) {
  const {
    getRoot,
    getWorkspaceRootPath,
    getSectionElement,
    expandExplorerPath,
    loadDirectoryEntries,
    refreshExplorer,
    pruneWorkspaceSubtreeState,
    resolveParentPathForMutation,
    onOpenFile,
  } = options;

  const message = useMessage();
  const dialog = useDialog();

  const inlineCreateDraft = reactive({
    open: false,
    parentPath: null as string | null,
    kind: 'file' as 'file' | 'directory',
    value: '',
    placeholder: '',
  });
  const inlineRenameDraft = reactive({ path: null as string | null, value: '' });
  const isInlineCreateSubmitting = ref(false);
  const isInlineRenamePriming = ref(false);

  const resolveCreationParentPath = (target: IExplorerContextTarget | null): string | null => {
    if (target?.kind === 'directory') {
      return target.path;
    }
    return getRoot()?.rootPath ?? getWorkspaceRootPath();
  };

  const closeInlineCreateDraft = (): void => {
    inlineCreateDraft.open = false;
    inlineCreateDraft.parentPath = null;
    inlineCreateDraft.value = '';
    inlineCreateDraft.placeholder = '';
    isInlineCreateSubmitting.value = false;
  };

  const focusInlineCreateInput = async (): Promise<void> => {
    await nextTick();
    const input = (getSectionElement()?.querySelector('.explorer-inline-create-input') ??
      null) as HTMLInputElement | null;
    input?.focus();
    input?.select();
  };

  const openInlineCreateDraft = async (
    kind: 'file' | 'directory',
    target: IExplorerContextTarget | null,
  ): Promise<void> => {
    if (!getRoot()) {
      message.error('请先打开工作区。');
      return;
    }
    const parentPath = resolveCreationParentPath(target);
    if (!parentPath) {
      message.error('无法解析新建位置。');
      return;
    }
    await expandExplorerPath(parentPath);
    inlineCreateDraft.open = true;
    inlineCreateDraft.parentPath = parentPath;
    inlineCreateDraft.kind = kind;
    inlineCreateDraft.value = '';
    inlineCreateDraft.placeholder = '';
    await focusInlineCreateInput();
  };

  const handleInlineCreateInputValue = (value: string): void => {
    inlineCreateDraft.value = value;
  };
  const cancelInlineCreateWorkspaceEntry = (): void => {
    closeInlineCreateDraft();
  };

  const confirmInlineCreateWorkspaceEntry = async (): Promise<void> => {
    const root = getRoot();
    if (
      !root ||
      !inlineCreateDraft.open ||
      !inlineCreateDraft.parentPath ||
      isInlineCreateSubmitting.value
    ) {
      return;
    }
    const name = inlineCreateDraft.value.trim();
    if (!name) {
      closeInlineCreateDraft();
      return;
    }
    const parentPath = inlineCreateDraft.parentPath;
    const kind = inlineCreateDraft.kind;
    const rootPath = root.rootPath;
    isInlineCreateSubmitting.value = true;
    try {
      const payload = await tauriService.createWorkspacePath({ parentPath, rootPath, name, kind });
      await refreshDirectoryAfterMutation(parentPath);
      message.success(kind === 'file' ? '已创建文件' : '已创建文件夹');
      closeInlineCreateDraft();
      if (payload.kind === 'file') {
        onOpenFile(payload.path);
      }
    } catch (error) {
      isInlineCreateSubmitting.value = false;
      message.error(toErrorMessage(error, kind === 'file' ? '创建文件失败' : '创建文件夹失败'));
    }
  };

  const handleInlineCreateBlur = (): void => {
    if (!inlineCreateDraft.open || isInlineCreateSubmitting.value) {
      return;
    }
    void confirmInlineCreateWorkspaceEntry();
  };

  let resolveInlineRename: ((value: string | null) => void) | null = null;
  const cancelInlineRename = (): void => {
    isInlineRenamePriming.value = false;
    inlineRenameDraft.path = null;
    inlineRenameDraft.value = '';
    const resolver = resolveInlineRename;
    resolveInlineRename = null;
    resolver?.(null);
  };

  const confirmInlineRename = (): void => {
    if (isInlineRenamePriming.value) {
      return;
    }
    if (!resolveInlineRename) {
      return;
    }
    const value = inlineRenameDraft.value.trim();
    inlineRenameDraft.path = null;
    inlineRenameDraft.value = '';
    const resolver = resolveInlineRename;
    resolveInlineRename = null;
    resolver(value || null);
  };

  const waitNextFrame = (): Promise<void> => {
    return new Promise((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  };

  const focusInlineRenameInput = async (): Promise<boolean> => {
    await nextTick();
    await waitNextFrame();
    const input = (getSectionElement()?.querySelector('.explorer-inline-rename-input') ??
      null) as HTMLInputElement | null;
    if (!input) {
      return false;
    }
    input.focus();
    const currentValue = input.value;
    const lastDotIndex = currentValue.lastIndexOf('.');
    if (lastDotIndex > 0) {
      input.setSelectionRange(0, lastDotIndex);
    } else {
      input.select();
    }
    return true;
  };

  const requestInlineRename = async (path: string, defaultName: string): Promise<string | null> => {
    if (resolveInlineRename) {
      cancelInlineRename();
    }
    isInlineRenamePriming.value = true;
    inlineRenameDraft.path = path;
    inlineRenameDraft.value = defaultName;
    const renamePromise = new Promise<string | null>((resolve) => {
      resolveInlineRename = resolve;
    });
    const didFocus = await focusInlineRenameInput();
    isInlineRenamePriming.value = false;
    if (!didFocus) {
      cancelInlineRename();
    }
    return renamePromise;
  };

  const refreshDirectoryAfterMutation = async (path: string | null): Promise<void> => {
    if (!getRoot() || !path) {
      await refreshExplorer();
      return;
    }
    await loadDirectoryEntries(path);
  };

  const handleCreateWorkspaceEntry = async (
    kind: 'file' | 'directory',
    target: IExplorerContextTarget | null,
  ): Promise<void> => {
    await openInlineCreateDraft(kind, target);
  };

  const handleRenameWorkspaceEntry = async (target: IExplorerContextTarget): Promise<void> => {
    const root = getRoot();
    if (!root || target.isRoot) {
      return;
    }
    const newName = await requestInlineRename(target.path, target.name);
    if (!newName || newName === target.name) {
      return;
    }
    try {
      await tauriService.renameWorkspacePath({
        path: target.path,
        rootPath: root.rootPath,
        newName,
      });
      pruneWorkspaceSubtreeState(target.path);
      await refreshDirectoryAfterMutation(resolveParentPathForMutation(target.path));
      message.success('已重命名');
    } catch (error) {
      message.error(toErrorMessage(error, '重命名失败'));
    }
  };

  const handleDeleteWorkspaceEntry = async (target: IExplorerContextTarget): Promise<void> => {
    const root = getRoot();
    if (!root || target.isRoot) {
      return;
    }
    const action = await dialog.confirm({
      title: '确认删除',
      description: `确认删除“${target.name}”？此操作不可撤销。`,
      confirmText: '删除',
      cancelText: '取消',
      dismissText: '返回',
      variant: 'danger',
    });
    if (action !== 'confirm') {
      return;
    }
    try {
      await tauriService.deleteWorkspacePath({ path: target.path, rootPath: root.rootPath });
      pruneWorkspaceSubtreeState(target.path);
      await refreshDirectoryAfterMutation(resolveParentPathForMutation(target.path));
      message.success('已移动到回收站');
    } catch (error) {
      message.error(toErrorMessage(error, '删除失败'));
    }
  };

  return {
    inlineCreateDraft,
    inlineRenameDraft,
    closeInlineCreateDraft,
    handleInlineCreateInputValue,
    handleInlineCreateBlur,
    confirmInlineCreateWorkspaceEntry,
    cancelInlineCreateWorkspaceEntry,
    confirmInlineRename,
    cancelInlineRename,
    handleCreateWorkspaceEntry,
    handleRenameWorkspaceEntry,
    handleDeleteWorkspaceEntry,
  };
}
