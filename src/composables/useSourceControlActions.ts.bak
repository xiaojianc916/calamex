import type { useDialog } from '@/composables/useDialog';
import type { useMessage } from '@/composables/useMessage';
import type { useGitStore } from '@/store/git';
import type { IGitFileStatusPayload, IGitRepositoryStatusPayload } from '@/types/git';
import { toErrorMessage } from '@/utils/error';
import { areFileSystemPathsEqual } from '@/utils/path';
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
  markStatusSynced: () => void;
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

const assertWorkspaceRepositoryReady = (
  payload: IGitRepositoryStatusPayload,
  workspaceRootPath: string,
): void => {
  if (!payload.available || !payload.repositoryRootPath) {
    throw new Error(payload.message ?? 'Git 初始化后仍未检测到仓库。');
  }

  if (!areFileSystemPathsEqual(payload.repositoryRootPath, workspaceRootPath)) {
    throw new Error(
      `Git 仓库根目录与当前工作区不一致：当前工作区 ${workspaceRootPath}，检测到 ${payload.repositoryRootPath}。`,
    );
  }
};

export const useSourceControlActions = (options: IUseSourceControlActionsOptions) => {
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

  const handleStageAll = async (): Promise<void> => {
    const paths = collectPaths(options.getStageableEntries());
    if (paths.length === 0) {
      options.message.info('没有可暂存的变更。');
      return;
    }

    try {
      await options.runWithPending('stage-all', async () => {
        await options.gitStore.stagePaths(paths);
      });
      options.markStatusSynced();
      options.message.success(`已暂存 ${paths.length} 项变更`);
    } catch (error) {
      options.message.error(toErrorMessage(error, '暂存全部变更失败'));
    }
  };

  const handleUnstageAll = async (): Promise<void> => {
    const paths = options.getStagedPaths();
    if (paths.length === 0) {
      options.message.info('没有已暂存的变更。');
      return;
    }

    try {
      await options.runWithPending('unstage-all', async () => {
        await options.gitStore.unstagePaths(paths);
      });
      options.markStatusSynced();
      options.message.success(`已取消暂存 ${paths.length} 项变更`);
    } catch (error) {
      options.message.error(toErrorMessage(error, '取消暂存全部变更失败'));
    }
  };

  const handleDiscardAll = async (): Promise<void> => {
    const paths = collectPaths(options.getDiscardableEntries());
    if (paths.length === 0) {
      options.message.info('没有可放弃的未暂存更改。');
      return;
    }

    const confirmed = await confirmDangerAction({
      title: '放弃所有未暂存更改？',
      description: `将丢弃 ${paths.length} 项工作区更改；未跟踪文件会被删除。此操作无法撤销。`,
      confirmText: '放弃更改',
    });
    if (!confirmed) {
      return;
    }

    try {
      await options.runWithPending('discard-all', async () => {
        await options.gitStore.discardPaths(paths);
      });
      options.markStatusSynced();
      options.message.success(`已放弃 ${paths.length} 项未暂存更改`);
    } catch (error) {
      options.message.error(toErrorMessage(error, '放弃未暂存更改失败'));
    }
  };

  const handleInitRepository = async (): Promise<void> => {
    const workspaceRootPath = options.getWorkspaceRootPath();
    if (!workspaceRootPath) {
      return;
    }

    options.setSourceControlActionError(null);

    try {
      const didRun = await options.runWithPending('init-repository', async () => {
        const initializedStatus = await options.gitStore.initRepository(workspaceRootPath);
        assertWorkspaceRepositoryReady(initializedStatus, workspaceRootPath);

        const refreshedStatus = await options.gitStore.refreshRepositoryStatus(workspaceRootPath);
        assertWorkspaceRepositoryReady(refreshedStatus, workspaceRootPath);
      });

      if (!didRun) {
        return;
      }

      options.markStatusSynced();
      options.message.success('Git 仓库已初始化');
    } catch (error) {
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

    try {
      await options.runWithPending('commit', async () => {
        const result = await options.gitStore.commitIndex(nextCommitMessage);
        options.setCommitMessage('');
        options.markStatusSynced();
        options.message.success(`已创建提交 ${result.commitId?.slice(0, 7) ?? ''}`);
      });
    } catch (error) {
      options.message.error(toErrorMessage(error, '创建 Git 提交失败'));
    }
  };

  const handleDiscardEntry = async (entry: IGitFileStatusPayload): Promise<void> => {
    const confirmed = await confirmDangerAction({
      title: entry.isUntracked ? '删除未跟踪文件？' : '放弃此文件的未暂存更改？',
      description: entry.isUntracked
        ? `将删除未跟踪文件 ${entry.relativePath}。此操作无法撤销。`
        : `将把 ${entry.relativePath} 的工作区内容恢复到索引/HEAD。此操作无法撤销。`,
      confirmText: entry.isUntracked ? '删除文件' : '放弃更改',
    });
    if (!confirmed) {
      return;
    }

    try {
      await options.runWithPending(`discard:${entry.path}`, async () => {
        await options.gitStore.discardPaths([entry.path]);
      });
      options.markStatusSynced();
      options.message.success(`已放弃更改 ${entry.fileName}`);
    } catch (error) {
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

    try {
      if (sectionKey === 'staged') {
        await options.runWithPending(`unstage:${entry.path}`, async () => {
          await options.gitStore.unstagePaths([entry.path]);
        });
        options.markStatusSynced();
        options.message.success(`已取消暂存 ${entry.fileName}`);
        return;
      }

      await options.runWithPending(`stage:${entry.path}`, async () => {
        await options.gitStore.stagePaths([entry.path]);
      });
      options.markStatusSynced();
      options.message.success(`已暂存 ${entry.fileName}`);
    } catch (error) {
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
