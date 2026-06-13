import { useEventListener } from '@vueuse/core';
import { computed, reactive, ref } from 'vue';
import type {
  ILinearContextMenuGroup,
  ILinearContextMenuItem,
} from '@/components/common/linear-context-menu.types';
import type { IWorkspaceEntry } from '@/types/editor';

export type TExplorerContextMenuAction =
  | 'open'
  | 'new-file'
  | 'new-directory'
  | 'rename'
  | 'delete'
  | 'copy-path'
  | 'refresh'
  | 'open-folder';

export interface IExplorerContextMenuItem extends ILinearContextMenuItem {
  action: TExplorerContextMenuAction;
}

export interface IExplorerContextTarget {
  path: string;
  name: string;
  kind: 'directory' | 'file';
  isRoot: boolean;
}

export interface IUseWorkspaceExplorerContextMenuOptions {
  /** Resolves the active workspace root path, or null when no workspace is open. */
  resolveRootPath: () => string | null;
  /** Resolves the context target for an empty-area (background) right-click. */
  resolveEmptyAreaTarget: () => IExplorerContextTarget | null;
  /** Opens an inline-create draft for a new file or directory under the target. */
  onCreate: (
    kind: 'file' | 'directory',
    target: IExplorerContextTarget | null,
  ) => void | Promise<void>;
  /** Begins renaming the target entry. */
  onRename: (target: IExplorerContextTarget) => void | Promise<void>;
  /** Deletes the target entry. */
  onDelete: (target: IExplorerContextTarget) => void | Promise<void>;
  /** Copies the target entry's filesystem path. */
  onCopyPath: (target: IExplorerContextTarget) => void | Promise<void>;
  /** Opens the workspace folder picker. */
  onOpenFolder: () => void;
}

/**
 * Owns the explorer right-click context menu: open state, position, the
 * highlighted target, the rendered menu item groups, and action dispatch.
 * Extracted from AppSidebar so the explorer domain owns its own context-menu
 * behaviour. Filesystem mutations are delegated back to the host via the
 * options callbacks. The outside-click listener self-registers on the calling
 * component's effect scope and is cleaned up automatically on unmount.
 */
export function useWorkspaceExplorerContextMenu(options: IUseWorkspaceExplorerContextMenuOptions) {
  const {
    resolveRootPath,
    resolveEmptyAreaTarget,
    onCreate,
    onRename,
    onDelete,
    onCopyPath,
    onOpenFolder,
  } = options;

  const explorerContextMenu = reactive({ open: false, x: 0, y: 0 });
  const explorerContextTarget = ref<IExplorerContextTarget | null>(null);

  const explorerContextMenuGroups = computed<ILinearContextMenuGroup<IExplorerContextMenuItem>[]>(
    () => {
      const target = explorerContextTarget.value;
      // 目录、文件、空白区域（根）右键都允许新建：文件目标会在其父目录创建“同级”条目。
      const canCreate = Boolean(target);
      const canMutate = Boolean(target && !target.isRoot);
      return [
        {
          key: 'primary',
          items: [
            {
              key: 'new-file',
              label: '新建文件',
              icon: 'plus',
              shortcut: ['Ctrl', 'N'],
              action: 'new-file',
              disabled: !canCreate,
            },
            {
              key: 'new-directory',
              label: '新建文件夹',
              icon: 'plus',
              shortcut: ['Ctrl', 'Shift', 'N'],
              action: 'new-directory',
              disabled: !canCreate,
            },
            {
              key: 'rename',
              label: '重命名',
              icon: 'comment',
              shortcut: ['F2'],
              action: 'rename',
              disabled: !canMutate,
            },
          ],
        },
        {
          key: 'secondary',
          items: [
            {
              key: 'delete',
              label: '移动到回收站',
              icon: 'trash',
              shortcut: ['Del'],
              action: 'delete',
              disabled: !canMutate,
            },
            {
              key: 'copy-path',
              label: '复制路径',
              icon: 'copy',
              shortcut: ['Ctrl', 'Shift', 'C'],
              action: 'copy-path',
              disabled: !target,
            },
            {
              key: 'open-folder',
              label: '打开文件夹',
              icon: 'open-external',
              action: 'open-folder',
            },
          ],
        },
      ];
    },
  );

  const explorerContextMenuHighlightPath = computed(() =>
    explorerContextMenu.open ? (explorerContextTarget.value?.path ?? null) : null,
  );

  const closeExplorerContextMenu = (): void => {
    explorerContextMenu.open = false;
    explorerContextTarget.value = null;
  };

  const openExplorerContextMenu = (event: MouseEvent, target: IExplorerContextTarget): void => {
    explorerContextMenu.x = Math.min(event.clientX, Math.max(12, window.innerWidth - 236));
    explorerContextMenu.y = Math.min(event.clientY, Math.max(12, window.innerHeight - 300));
    explorerContextTarget.value = target;
    explorerContextMenu.open = true;
  };

  const handleEntryContextMenu = (payload: { event: MouseEvent; entry: IWorkspaceEntry }): void => {
    openExplorerContextMenu(payload.event, {
      path: payload.entry.path,
      name: payload.entry.name,
      kind: payload.entry.kind,
      isRoot: payload.entry.path === resolveRootPath(),
    });
  };

  const handleEmptyAreaContextMenu = (event: MouseEvent): void => {
    const target = resolveEmptyAreaTarget();
    if (!target) {
      return;
    }
    openExplorerContextMenu(event, target);
  };

  const handleExplorerContextMenuSelect = async (item: ILinearContextMenuItem): Promise<void> => {
    const actionItem = item as IExplorerContextMenuItem;
    const target = explorerContextTarget.value;
    closeExplorerContextMenu();
    if (actionItem.disabled) {
      return;
    }
    switch (actionItem.action) {
      case 'new-file':
        await onCreate('file', target);
        return;
      case 'new-directory':
        await onCreate('directory', target);
        return;
      case 'rename':
        if (target) await onRename(target);
        return;
      case 'delete':
        if (target) await onDelete(target);
        return;
      case 'copy-path':
        if (target) await onCopyPath(target);
        return;
      case 'open-folder':
        onOpenFolder();
        return;
      default:
        return;
    }
  };

  const handleWindowPointerDown = (event: PointerEvent): void => {
    if (
      explorerContextMenu.open &&
      event.target instanceof Element &&
      event.target.closest('.linear-context-menu-root') === null
    ) {
      closeExplorerContextMenu();
    }
  };

  useEventListener(window, 'pointerdown', handleWindowPointerDown, true);

  return {
    explorerContextMenu,
    explorerContextMenuGroups,
    explorerContextMenuHighlightPath,
    closeExplorerContextMenu,
    handleEntryContextMenu,
    handleEmptyAreaContextMenu,
    handleExplorerContextMenuSelect,
  };
}
