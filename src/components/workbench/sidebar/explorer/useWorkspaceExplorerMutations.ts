import { nextTick, reactive, ref } from 'vue';
import type { IExplorerContextTarget } from '@/components/workbench/sidebar/explorer/useWorkspaceExplorerContextMenu';
import { useDialog } from '@/composables/useDialog';
import { useMessage } from '@/composables/useMessage';
import { tauriService } from '@/services/tauri';
import type {
  IWorkspaceDirectoryPayload,
  IWorkspaceEntry,
  TWorkbenchOpenFilePayload,
} from '@/types/editor';
import { toErrorMessage } from '@/utils/error';
import { areFileSystemPathsEqual } from '@/utils/path';

export interface IUseWorkspaceExplorerMutationsOptions {
  /** Resolves the currently loaded workspace root payload, or null. */
  getRoot: () => IWorkspaceDirectoryPayload | null;
  /** Resolves the workspace root path fallback (e.g. props.workspaceRootPath). */
  getWorkspaceRootPath: () => string | null;
  /** Resolves the explorer section host element used for inline-input focus. */
  getSectionElement: () => HTMLElement | null;
  /** Resolves already-loaded child entries for a directory, used for duplicate-name pre-checks. */
  getDirectoryEntries: (path: string) => IWorkspaceEntry[] | undefined;
  /** Ensures the given directory path is expanded (and its entries loaded). */
  expandExplorerPath: (path: string) => Promise<void>;
  /** Reloads the entries for a single directory. */
  loadDirectoryEntries: (path: string, options?: { silent?: boolean }) => Promise<void>;
  /** Reloads the entire workspace root tree. */
  refreshExplorer: () => Promise<void>;
  /** Drops cached state for a path and everything beneath it. */
  pruneWorkspaceSubtreeState: (path: string) => void;
  /** Marks a directory as just reloaded so the fs watcher can skip a redundant reload. */
  markDirectoryRecentlyRefreshed: (path: string) => void;
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
    getDirectoryEntries,
    expandExplorerPath,
    loadDirectoryEntries,
    refreshExplorer,
    pruneWorkspaceSubtreeState,
    markDirectoryRecentlyRefreshed,
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

  const waitNextFrame = (): Promise<void> => {
    return new Promise((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  };

  const resolveCreationParentPath = (target: IExplorerContextTarget | null): string | null => {
    if (target?.kind === 'directory') {
      return target.path;
    }
    if (target?.kind === 'file') {
      // 右键文件时，在该文件所在目录创建“同级”条目。
      return (
        resolveParentPathForMutation(target.path) ?? getRoot()?.rootPath ?? getWorkspaceRootPath()
      );
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

  // 可靠地聚焦内联“新建”输入框：等待一次 DOM 更新与一帧绘制后，把输入框滚入视口并聚焦。
  // 虚拟滚动场景下，行的真正挂载与滚动由 WorkspaceTreeNode 负责，这里作为兜底；
  // 两处都聚焦同一个输入框且彼此幂等。
  const focusInlineCreateInput = async (): Promise<void> => {
    await nextTick();
    await waitNextFrame();
    const input = (getSectionElement()?.querySelector('.explorer-inline-create-input') ??
      null) as HTMLInputElement | null;
    if (!input) {
      return;
    }
    input.scrollIntoView({ block: 'nearest' });
    input.focus();
    input.select();
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
    // 复用同一个草稿前先关闭旧草稿，避免旧输入框失焦时把内容提交到旧目录。
    if (inlineCreateDraft.open) {
      closeInlineCreateDraft();
    }
    await expandExplorerPath(parentPath);
    inlineCreateDraft.open = true;
    inlineCreateDraft.parentPath = parentPath;
    inlineCreateDraft.kind = kind;
    inlineCreateDraft.value = '';
    inlineCreateDraft.placeholder = kind === 'directory' ? '文件夹名称' : '文件名称';
    await focusInlineCreateInput();
  };

  const handleInlineCreateInputValue = (value: string): void => {
    inlineCreateDraft.value = value;
  };
  const cancelInlineCreateWorkspaceEntry = (): void => {
    closeInlineCreateDraft();
  };

  // 轻量的前置校验：拦截路径分隔符 / 保留名，并基于已加载的同级条目做重名预检查；
  // 后端仍是最终权威（会再次校验并报错）。
  const validateInlineCreateName = (name: string, parentPath: string): string | null => {
    if (/[\\/]/.test(name)) {
      return '名称不能包含路径分隔符。';
    }
    if (name === '.' || name === '..') {
      return '名称无效。';
    }
    const siblings = getDirectoryEntries(parentPath);
    if (siblings) {
      const candidatePath = `${parentPath.replace(/[\\/]+$/, '')}/${name}`;
      const exists = siblings.some((entry) => areFileSystemPathsEqual(entry.path, candidatePath));
      if (exists) {
        return '同名文件或文件夹已存在。';
      }
    }
    return null;
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
    const validationError = validateInlineCreateName(name, parentPath);
    if (validationError) {
      // 保持草稿打开，方便用户直接修正名称。
      message.error(validationError);
      return;
    }
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
    const parentPathAtBlur = inlineCreateDraft.parentPath;
    // 延后一帧再处理失焦：虚拟列表重渲染 / 滚动会让输入框瞬时失焦。
    // 若一帧后焦点又回到新建输入框，或草稿已被关闭 / 切换到别的目录，则忽略本次失焦，
    // 避免误把内容提交到错误的位置或意外取消草稿。
    void waitNextFrame().then(() => {
      if (!inlineCreateDraft.open || isInlineCreateSubmitting.value) {
        return;
      }
      if (inlineCreateDraft.parentPath !== parentPathAtBlur) {
        return;
      }
      const input = getSectionElement()?.querySelector('.explorer-inline-create-input') ?? null;
      if (input && input === document.activeElement) {
        return;
      }
      void confirmInlineCreateWorkspaceEntry();
    });
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
    // 标记该目录刚被主动刷新，文件系统监听器会在短时间内跳过对同一目录的重复重载。
    markDirectoryRecentlyRefreshed(path);
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
