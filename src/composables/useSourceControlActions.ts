import type { useDialog } from '@/composables/useDialog';
import type { useMessage } from '@/composables/useMessage';
import type { useGitStore } from '@/store/git';
import type { IGitFileStatusPayload } from '@/types/git';
import { toErrorMessage } from '@/utils/error/error';
import { areFileSystemPathsEqual } from '@/utils/file/path';
import type { TGitSectionKey } from './useSourceControlContextMenu';

export type TGitEntryActionKey = 'stage' | 'unstage' | 'discard';

type TGitStore = ReturnType<typeof useGitStore>;
type TMessage = ReturnType<typeof useMessage>;
type TDialog = ReturnType<typeof useDialog>;

interface IUseSourceControlActionsOptions {
  gitStore: TGitStore;
  message: TMessage;
  dialog: TDialog;
  getWorkspaceRootPath: () => string | null;
  getStageableEntries: () => IGitFileStatusPayload[];
  getStagedPaths: () => string[];
  getDiscardableEntries: () => IGitFileStatusPayload[];
  getStagedCount: () => number;
  getCommitMessage: () => string;
  setCommitMessage: (value: string) => void;
  runWithPending: (key: string, task: () => Promise<void>) => Promise<boolean>;
  setSourceControlActionError: (value: string | null) => void;
  syncRepositoryStatus: (
    workspaceRootPath: string,
    options?: {
      showSuccessMessage?: boolean;
      showErrorMessage?: boolean;
    },
  ) => Promise<void>;
}

const collectPaths = (entries: IGitFileStatusPayload[]): string[] =>
  entries.map((entry) => entry.path);

export const useSourceControlActions = (options: IUseSourceControlActionsOptions) => {
  const isWorkspaceRootCurrent = (workspaceRootPath: string | null): boolean => {
    const currentWorkspaceRootPath = options.getWorkspaceRootPath();
    if (!workspaceRootPath || !currentWorkspaceRootPath) {
      return workspaceRootPath === currentWorkspaceRootPath;
    }
    return areFileSystemPathsEqual(workspaceRootPath, currentWorkspaceRootPath);
  };

  const confirmDangerAction = async (config: {
    title: string;
    description: string;
    confirmText: string;
  }): Promise<boolean> => {
    const action = await options.dialog.confirm({
      ...config,
      cancelText: '取消',
      variant: 'danger',
    });

    return action === 'confirm';
  };

  const handleRefresh = async (): Promise<void> => {
    const workspaceRootPath = options.getWorkspaceRootPath();
    if (!workspaceRootPath) {
      return;
    }

    options.setSourceControlActionError(null);
    await options.syncRepositoryStatus(workspaceRootPath, {
      showSuccessMessage: true,
      showErrorMessage: true,
    });
  };

  const runBulkPathsAction = async (config: {
    paths: string[];
    emptyMessage: string;
    pendingKey: string;
    mutate: (paths: string[]) => Promise<unknown>;
    successMessage: (count: number) => string;
    errorMessage: string;
    confirm?: () => Promise<boolean>;
  }): Promise<void> => {
    if (config.paths.length === 0) {
      options.message.info(config.emptyMessage);
      return;
    }

    if (config.confirm && !(await config.confirm())) {
      return;
    }

    const workspaceRootPathAtStart = options.getWorkspaceRootPath();

    try {
      const didRun = await options.runWithPending(config.pendingKey, async () => {
        await config.mutate(config.paths);
      });
      if (!didRun || !isWorkspaceRootCurrent(workspaceRootPathAtStart)) {
        return;
      }
      options.message.success(config.successMessage(config.paths.length));
    } catch (error) {
      if (!isWorkspaceRootCurrent(workspaceRootPathAtStart)) {
        return;
      }
      options.message.error(toErrorMessage(error, config.errorMessage));
    }
  };

  const handleStageAll = (): Promise<void> =>
    runBulkPathsAction({
      paths: collectPaths(options.getStageableEntries()),
      emptyMessage: '没有可暂存的变更。',
      pendingKey: 'stage-all',
      mutate: (paths) => options.gitStore.stagePaths(paths),
      successMessage: (count) => `已暂存 ${count} 项变更`,
      errorMessage: '暂存全部变更失败',
    });

  const handleUnstageAll = (): Promise<void> =>
    runBulkPathsAction({
      paths: options.getStagedPaths(),
      emptyMessage: '没有已暂存的变更。',
      pendingKey: 'unstage-all',
      mutate: (paths) => options.gitStore.unstagePaths(paths),
      successMessage: (count) => `已取消暂存 ${count} 项变更`,
      errorMessage: '取消暂存全部变更失败',
    });

  const handleDiscardAll = (): Promise<void> => {
    const paths = collectPaths(options.getDiscardableEntries());
    return runBulkPathsAction({
      paths,
      emptyMessage: '没有可放弃的未暂存更改。',
      pendingKey: 'discard-all',
      mutate: (entries) => options.gitStore.discardPaths(entries),
      successMessage: (count) => `已放弃 ${count} 项未暂存更改`,
      errorMessage: '放弃未暂存更改失败',
      confirm: () =>
        confirmDangerAction({
          title: '放弃所有未暂存更改？',
          description: `将丢弃 ${paths.length} 项工作区更改；未跟踪文件会被删除。此操作无法撤销。`,
          confirmText: '放弃更改',
        }),
    });
  };

  const handleInitRepository = async (): Promise<void> => {
    const workspaceRootPath = options.getWorkspaceRootPath();
    if (!workspaceRootPath) {
      return;
    }

    options.setSourceControlActionError(null);

    try {
      const didRun = await options.runWithPending('init-repository', async () => {
        // gitStore.initRepository 内部已通过 assertInitializedRepositoryStatus 校验,
        // 并返回最新仓库状态,无需再次刷新或在此重复断言。
        await options.gitStore.initRepository(workspaceRootPath);
      });

      if (!didRun || !isWorkspaceRootCurrent(workspaceRootPath)) {
        return;
      }

      options.message.success('Git 仓库已初始化');
    } catch (error) {
      if (!isWorkspaceRootCurrent(workspaceRootPath)) {
        return;
      }
      const errorMessage = toErrorMessage(error, '初始化 Git 仓库失败');
      options.setSourceControlActionError(errorMessage);
      options.message.error(errorMessage);
    }
  };

  const handleCommit = async (): Promise<void> => {
    const nextCommitMessage = options.getCommitMessage().trim();
    if (!nextCommitMessage) {
      options.message.warning('请先输入提交说明。');
      return;
    }

    if (options.getStagedCount() === 0) {
      options.message.warning('请先暂存至少一项变更。');
      return;
    }

    const workspaceRootPathAtStart = options.getWorkspaceRootPath();

    try {
      await options.runWithPending('commit', async () => {
        const result = await options.gitStore.commitIndex(nextCommitMessage);
        if (!isWorkspaceRootCurrent(workspaceRootPathAtStart)) {
          return;
        }
        options.setCommitMessage('');
        options.message.success(`已创建提交 ${result.commitId?.slice(0, 7) ?? ''}`);
      });
    } catch (error) {
      if (!isWorkspaceRootCurrent(workspaceRootPathAtStart)) {
        return;
      }
      options.message.error(toErrorMessage(error, '创建 Git 提交失败'));
    }
  };

  const handleDiscardEntry = async (entry: IGitFileStatusPayload): Promise<void> => {
    const workspaceRootPathAtStart = options.getWorkspaceRootPath();
    const confirmed = await confirmDangerAction({
      title: entry.isUntracked ? '删除未跟踪文件？' : '放弃此文件的未暂存更改？',
      description: entry.isUntracked
        ? `将删除未跟踪文件 ${entry.relativePath}。此操作无法撤销。`
        : `将把 ${entry.relativePath} 的工作区内容恢复到索引/HEAD。此操作无法撤销。`,
      confirmText: entry.isUntracked ? '删除文件' : '放弃更改',
    });
    if (!confirmed || !isWorkspaceRootCurrent(workspaceRootPathAtStart)) {
      return;
    }

    try {
      const didRun = await options.runWithPending(`discard:${entry.path}`, async () => {
        await options.gitStore.discardPaths([entry.path]);
      });
      if (!didRun || !isWorkspaceRootCurrent(workspaceRootPathAtStart)) {
        return;
      }
      options.message.success(`已放弃更改 ${entry.fileName}`);
    } catch (error) {
      if (!isWorkspaceRootCurrent(workspaceRootPathAtStart)) {
        return;
      }
      options.message.error(toErrorMessage(error, `放弃更改 ${entry.fileName} 失败`));
    }
  };

  const handleSectionAction = async (
    sectionKey: TGitSectionKey,
    entry: IGitFileStatusPayload,
  ): Promise<void> => {
    if (sectionKey === 'conflicts') {
      return;
    }

    const workspaceRootPathAtStart = options.getWorkspaceRootPath();

    try {
      if (sectionKey === 'staged') {
        const didRun = await options.runWithPending(`unstage:${entry.path}`, async () => {
          await options.gitStore.unstagePaths([entry.path]);
        });
        if (!didRun || !isWorkspaceRootCurrent(workspaceRootPathAtStart)) {
          return;
        }
        options.message.success(`已取消暂存 ${entry.fileName}`);
        return;
      }

      const didRun = await options.runWithPending(`stage:${entry.path}`, async () => {
        await options.gitStore.stagePaths([entry.path]);
      });
      if (!didRun || !isWorkspaceRootCurrent(workspaceRootPathAtStart)) {
        return;
      }
      options.message.success(`已暂存 ${entry.fileName}`);
    } catch (error) {
      if (!isWorkspaceRootCurrent(workspaceRootPathAtStart)) {
        return;
      }
      options.message.error(toErrorMessage(error, 'Git 变更操作失败'));
    }
  };

  const handleEntryAction = async (
    actionKey: TGitEntryActionKey,
    sectionKey: TGitSectionKey,
    entry: IGitFileStatusPayload,
  ): Promise<void> => {
    if (actionKey === 'discard') {
      await handleDiscardEntry(entry);
      return;
    }

    await handleSectionAction(sectionKey, entry);
  };

  return {
    handleRefresh,
    handleStageAll,
    handleUnstageAll,
    handleDiscardAll,
    handleInitRepository,
    handleCommit,
    handleDiscardEntry,
    handleSectionAction,
    handleEntryAction,
  };
};
