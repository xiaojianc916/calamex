import type {
  ILinearContextMenuGroup,
  ILinearContextMenuItem,
} from '@/components/common/linear-context-menu.types';
import type { IGitFileStatusPayload } from '@/types/git';

export type TGitSectionKey = 'conflicts' | 'staged' | 'changes' | 'untracked';

export type TSourceControlMenuAction =
  | 'refresh'
  | 'stage-all'
  | 'unstage-all'
  | 'discard-all'
  | 'commit'
  | 'open-diff'
  | 'open-file'
  | 'copy-path'
  | 'stage-entry'
  | 'unstage-entry'
  | 'discard-entry';

export interface ISourceControlMenuItem extends ILinearContextMenuItem {
  action: TSourceControlMenuAction;
  sectionKey?: TGitSectionKey;
  entry?: IGitFileStatusPayload;
}

export type TSourceControlMenuGroup = ILinearContextMenuGroup<ISourceControlMenuItem>;

interface IUseSourceControlContextMenuOptions {
  isBusy: () => boolean;
  canStageAll: () => boolean;
  canUnstageAll: () => boolean;
  canDiscardAll: () => boolean;
  canCommit: () => boolean;
  onRefresh: () => Promise<void>;
  onStageAll: () => Promise<void>;
  onUnstageAll: () => Promise<void>;
  onDiscardAll: () => Promise<void>;
  onCommit: () => Promise<void>;
  onOpenDiff: (sectionKey: TGitSectionKey, entry: IGitFileStatusPayload) => void;
  onOpenFile: (path: string) => void;
  onCopyPath: (path: string) => Promise<void>;
  onStageEntry: (sectionKey: TGitSectionKey, entry: IGitFileStatusPayload) => Promise<void>;
  onUnstageEntry: (entry: IGitFileStatusPayload) => Promise<void>;
  onDiscardEntry: (entry: IGitFileStatusPayload) => Promise<void>;
}

const createMenuItem = (
  item: Omit<ISourceControlMenuItem, 'children'> & {
    children?: ISourceControlMenuItem[];
  },
): ISourceControlMenuItem => item;

export const useSourceControlContextMenu = (options: IUseSourceControlContextMenuOptions) => {
  const buildRepositoryMenuGroups = (): TSourceControlMenuGroup[] => [
    {
      key: 'repository',

      items: [
        createMenuItem({
          key: 'refresh',
          label: '刷新状态',
          icon: 'refresh',
          shortcut: ['Ctrl', 'R'],
          action: 'refresh',
          disabled: options.isBusy(),
        }),
      ],
    },
    {
      key: 'changes',

      items: [
        createMenuItem({
          key: 'stage-all',
          label: '全部暂存',
          icon: 'plus',
          action: 'stage-all',
          disabled: !options.canStageAll(),
        }),
        createMenuItem({
          key: 'unstage-all',
          label: '全部取消暂存',
          icon: 'minus',
          action: 'unstage-all',
          disabled: !options.canUnstageAll(),
        }),
        createMenuItem({
          key: 'discard-all',
          label: '放弃所有未暂存更改',
          icon: 'trash',
          action: 'discard-all',
          disabled: !options.canDiscardAll(),
        }),
      ],
    },
    {
      key: 'commit',

      items: [
        createMenuItem({
          key: 'commit',
          label: '提交已暂存更改',
          icon: 'commit',
          shortcut: ['Ctrl', 'Enter'],
          action: 'commit',
          disabled: !options.canCommit(),
        }),
      ],
    },
  ];

  const buildEntryMenuGroups = (
    sectionKey: TGitSectionKey,
    entry: IGitFileStatusPayload,
  ): TSourceControlMenuGroup[] => {
    const changeItems: ISourceControlMenuItem[] = [];

    if (sectionKey === 'staged') {
      changeItems.push(
        createMenuItem({
          key: 'unstage-entry',
          label: '取消暂存',
          icon: 'minus',
          action: 'unstage-entry',
          sectionKey,
          entry,
          disabled: options.isBusy(),
        }),
      );
    } else if (sectionKey !== 'conflicts') {
      changeItems.push(
        createMenuItem({
          key: 'stage-entry',
          label: '暂存更改',
          icon: 'plus',
          action: 'stage-entry',
          sectionKey,
          entry,
          disabled: options.isBusy(),
        }),
        createMenuItem({
          key: 'discard-entry',
          label: entry.isUntracked ? '删除未跟踪文件' : '放弃更改',
          icon: 'trash',
          action: 'discard-entry',
          sectionKey,
          entry,
          disabled: options.isBusy(),
        }),
      );
    }

    return [
      {
        key: 'file',
        title: 'File',
        items: [
          createMenuItem({
            key: 'open-diff',
            label: '查看 Diff',
            icon: 'goto',
            action: 'open-diff',
            sectionKey,
            entry,
          }),
          createMenuItem({
            key: 'open-file',
            label: '打开文件',
            icon: 'goto',
            action: 'open-file',
            sectionKey,
            entry,
          }),
          createMenuItem({
            key: 'copy-path',
            label: '复制路径',
            icon: 'copy',
            action: 'copy-path',
            sectionKey,
            entry,
          }),
        ],
      },
      ...(changeItems.length > 0
        ? [
            {
              key: 'change',
              title: 'Change',
              items: changeItems,
            },
          ]
        : []),
    ];
  };

  const handleContextMenuSelect = async (item: ILinearContextMenuItem): Promise<void> => {
    const actionItem = item as ISourceControlMenuItem;

    switch (actionItem.action) {
      case 'refresh':
        await options.onRefresh();
        return;
      case 'stage-all':
        await options.onStageAll();
        return;
      case 'unstage-all':
        await options.onUnstageAll();
        return;
      case 'discard-all':
        await options.onDiscardAll();
        return;
      case 'commit':
        await options.onCommit();
        return;
      case 'open-diff':
        if (actionItem.entry && actionItem.sectionKey) {
          options.onOpenDiff(actionItem.sectionKey, actionItem.entry);
        }
        return;
      case 'open-file':
        if (actionItem.entry) {
          options.onOpenFile(actionItem.entry.path);
        }
        return;
      case 'copy-path':
        if (actionItem.entry) {
          await options.onCopyPath(actionItem.entry.path);
        }
        return;
      case 'stage-entry':
        if (actionItem.entry && actionItem.sectionKey) {
          await options.onStageEntry(actionItem.sectionKey, actionItem.entry);
        }
        return;
      case 'unstage-entry':
        if (actionItem.entry) {
          await options.onUnstageEntry(actionItem.entry);
        }
        return;
      case 'discard-entry':
        if (actionItem.entry) {
          await options.onDiscardEntry(actionItem.entry);
        }
        return;
      default:
        return;
    }
  };

  return {
    buildRepositoryMenuGroups,
    buildEntryMenuGroups,
    handleContextMenuSelect,
  };
};
