import { commands } from '@/bindings/tauri';
import type { ITauriService } from '@/types/tauri';
import { callSpectaCommand } from './tauri.ipc-runtime';
import type { IIpcCallOptions } from './tauri.ipc-types';

type TGitTauriService = Pick<
  ITauriService,
  | 'getGitRepositoryStatus'
  | 'initGitRepository'
  | 'listGitCommitHistory'
  | 'getGitCommitDetail'
  | 'getGitCommitFileDiff'
  | 'getGitCommitFileDiffPreview'
  | 'listGitBranches'
  | 'checkoutGitBranch'
  | 'checkoutGitCommit'
  | 'createGitBranch'
  | 'revertGitCommit'
  | 'setGitRemote'
  | 'getGitFileBaseline'
  | 'getGitDiffPreview'
  | 'stageGitPaths'
  | 'unstageGitPaths'
  | 'discardGitPaths'
  | 'commitGitIndex'
  | 'listGitStashes'
  | 'saveGitStash'
  | 'applyGitStash'
  | 'dropGitStash'
  | 'getGitPullRequestSupport'
  | 'listGitPullRequests'
  | 'getGitPullRequestDetail'
  | 'createGitPullRequest'
  | 'mergeGitPullRequest'
  | 'closeGitPullRequest'
>;

export const gitTauriService: TGitTauriService = {
  getGitRepositoryStatus(workspaceRootPath, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'get_git_repository_status',
        guardHint: '读取 Git 仓库状态',
        idempotent: true,
        input: { workspaceRootPath },
        signal: options?.signal,
      },
      () => commands.getGitRepositoryStatus(workspaceRootPath ?? null),
    );
  },

  initGitRepository(workspaceRootPath, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'init_git_repository',
        guardHint: '初始化 Git 仓库',
        input: { workspaceRootPath },
        signal: options?.signal,
      },
      () => commands.initGitRepository(workspaceRootPath ?? null),
    );
  },

  listGitCommitHistory(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'list_git_commit_history',
        guardHint: '读取 Git 提交历史',
        idempotent: true,
        timeoutMs: 20_000,
        input: payload,
        signal: options?.signal,
      },
      () => commands.listGitCommitHistory(payload),
    );
  },

  getGitCommitDetail(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'get_git_commit_detail',
        guardHint: '读取 Git 提交详情',
        idempotent: true,
        timeoutMs: 20_000,
        input: payload,
        signal: options?.signal,
      },
      () => commands.getGitCommitDetail(payload),
    );
  },

  getGitCommitFileDiff(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'get_git_commit_file_diff',
        guardHint: '读取 Git 提交文件 Diff',
        idempotent: true,
        timeoutMs: 20_000,
        input: payload,
        signal: options?.signal,
      },
      () => commands.getGitCommitFileDiff(payload),
    );
  },

  getGitCommitFileDiffPreview(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'get_git_commit_file_diff_preview',
        guardHint: '读取 Git 提交文件 Diff 预览',
        idempotent: true,
        timeoutMs: 20_000,
        input: payload,
        signal: options?.signal,
      },
      () => commands.getGitCommitFileDiffPreview(payload),
    );
  },

  listGitBranches(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'list_git_branches',
        guardHint: '读取 Git 分支列表',
        idempotent: true,
        input: payload,
        signal: options?.signal,
      },
      () => commands.listGitBranches(payload),
    );
  },

  checkoutGitBranch(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'checkout_git_branch',
        guardHint: '切换 Git 分支',
        audit: 'sensitive',
        timeoutMs: 20_000,
        input: payload,
        signal: options?.signal,
      },
      () => commands.checkoutGitBranch(payload),
    );
  },

  checkoutGitCommit(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'checkout_git_commit',
        guardHint: '检出 Git 提交（分离 HEAD）',
        audit: 'sensitive',
        timeoutMs: 20_000,
        input: payload,
        signal: options?.signal,
      },
      () => commands.checkoutGitCommit(payload),
    );
  },

  createGitBranch(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'create_git_branch',
        guardHint: '创建 Git 分支',
        audit: 'sensitive',
        timeoutMs: 20_000,
        input: payload,
        signal: options?.signal,
      },
      () => commands.createGitBranch(payload),
    );
  },

  revertGitCommit(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'revert_git_commit',
        guardHint: '回滚 Git 提交',
        audit: 'sensitive',
        timeoutMs: 20_000,
        input: payload,
        signal: options?.signal,
      },
      () => commands.revertGitCommit(payload),
    );
  },

  setGitRemote(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'set_git_remote',
        guardHint: '配置 Git 远端地址',
        audit: 'sensitive',
        timeoutMs: 15_000,
        input: payload,
        signal: options?.signal,
      },
      () => commands.setGitRemote(payload),
    );
  },

  getGitFileBaseline(path, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'get_git_file_baseline',
        guardHint: '读取 Git 文件基线',
        idempotent: true,
        input: { path },
        signal: options?.signal,
      },
      () => commands.getGitFileBaseline(path),
    );
  },

  getGitDiffPreview(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'get_git_diff_preview',
        guardHint: '读取 Git Diff 预览',
        idempotent: true,
        timeoutMs: 20_000,
        input: payload,
        signal: options?.signal,
      },
      () => commands.getGitDiffPreview(payload),
    );
  },

  stageGitPaths(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'stage_git_paths',
        guardHint: '暂存 Git 变更',
        timeoutMs: 20_000,
        input: payload,
        signal: options?.signal,
      },
      () => commands.stageGitPaths(payload),
    );
  },

  unstageGitPaths(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'unstage_git_paths',
        guardHint: '取消暂存 Git 变更',
        timeoutMs: 20_000,
        input: payload,
        signal: options?.signal,
      },
      () => commands.unstageGitPaths(payload),
    );
  },

  discardGitPaths(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'discard_git_paths',
        guardHint: '放弃 Git 工作区更改',
        audit: 'sensitive',
        timeoutMs: 20_000,
        input: payload,
        signal: options?.signal,
      },
      () => commands.discardGitPaths(payload),
    );
  },

  commitGitIndex(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'commit_git_index',
        guardHint: '创建 Git 提交',
        audit: 'sensitive',
        timeoutMs: 20_000,
        input: payload,
        signal: options?.signal,
      },
      () => commands.commitGitIndex(payload),
    );
  },

  listGitStashes(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'list_git_stashes',
        guardHint: '读取 Git 贮藏列表',
        idempotent: true,
        input: payload,
        signal: options?.signal,
      },
      () => commands.listGitStashes(payload),
    );
  },

  saveGitStash(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'save_git_stash',
        guardHint: '保存 Git 贮藏',
        audit: 'sensitive',
        timeoutMs: 20_000,
        input: payload,
        signal: options?.signal,
      },
      () => commands.saveGitStash(payload),
    );
  },

  applyGitStash(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'apply_git_stash',
        guardHint: '应用 Git 贮藏',
        audit: 'sensitive',
        timeoutMs: 20_000,
        input: payload,
        signal: options?.signal,
      },
      () => commands.applyGitStash(payload),
    );
  },

  dropGitStash(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'drop_git_stash',
        guardHint: '删除 Git 贮藏',
        audit: 'sensitive',
        timeoutMs: 20_000,
        input: payload,
        signal: options?.signal,
      },
      () => commands.dropGitStash(payload),
    );
  },

  getGitPullRequestSupport(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'get_git_pull_request_support',
        guardHint: '读取 Git 远端 Pull Request 支持信息',
        idempotent: true,
        input: payload,
        signal: options?.signal,
      },
      () => commands.getGitPullRequestSupport(payload),
    );
  },

  listGitPullRequests(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'list_git_pull_requests',
        guardHint: '读取 GitHub Pull Request 列表',
        idempotent: true,
        timeoutMs: 20_000,
        input: payload,
        signal: options?.signal,
      },
      () => commands.listGitPullRequests(payload),
    );
  },

  getGitPullRequestDetail(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'get_git_pull_request_detail',
        guardHint: '读取 GitHub Pull Request 详情',
        idempotent: true,
        timeoutMs: 20_000,
        input: payload,
        signal: options?.signal,
      },
      () => commands.getGitPullRequestDetail(payload),
    );
  },

  createGitPullRequest(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'create_git_pull_request',
        guardHint: '创建 GitHub Pull Request',
        audit: 'sensitive',
        timeoutMs: 30_000,
        input: payload,
        signal: options?.signal,
      },
      () => commands.createGitPullRequest(payload),
    );
  },

  mergeGitPullRequest(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'merge_git_pull_request',
        guardHint: '合并 GitHub Pull Request',
        audit: 'sensitive',
        timeoutMs: 30_000,
        input: payload,
        signal: options?.signal,
      },
      () => commands.mergeGitPullRequest(payload),
    );
  },

  closeGitPullRequest(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'close_git_pull_request',
        guardHint: '关闭 GitHub Pull Request',
        audit: 'sensitive',
        timeoutMs: 20_000,
        input: payload,
        signal: options?.signal,
      },
      () => commands.closeGitPullRequest(payload),
    );
  },
};
