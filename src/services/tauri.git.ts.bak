import { commands } from '@/bindings/tauri';
import type { ITauriService } from '@/types/tauri';
import { callSpectaCommand } from './tauri.ipc-runtime';

type TGitTauriService = Pick<
  ITauriService,
  | 'getGitRepositoryStatus'
  | 'initGitRepository'
  | 'listGitCommitHistory'
  | 'listGitBranches'
  | 'checkoutGitBranch'
  | 'createGitBranch'
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
>;

export const gitTauriService: TGitTauriService = {
  getGitRepositoryStatus(workspaceRootPath) {
    return callSpectaCommand(
      {
        command: 'get_git_repository_status',
        guardHint: '读取 Git 仓库状态',
        idempotent: true,
        input: { workspaceRootPath },
      },
      () => commands.getGitRepositoryStatus(workspaceRootPath ?? null),
    );
  },

  initGitRepository(workspaceRootPath) {
    return callSpectaCommand(
      {
        command: 'init_git_repository',
        guardHint: '初始化 Git 仓库',
        input: { workspaceRootPath },
      },
      () => commands.initGitRepository(workspaceRootPath ?? null),
    );
  },

  listGitCommitHistory(payload) {
    return callSpectaCommand(
      {
        command: 'list_git_commit_history',
        guardHint: '读取 Git 提交历史',
        idempotent: true,
        timeoutMs: 20_000,
        input: payload,
      },
      () => commands.listGitCommitHistory(payload),
    );
  },

  listGitBranches(payload) {
    return callSpectaCommand(
      {
        command: 'list_git_branches',
        guardHint: '读取 Git 分支列表',
        idempotent: true,
        input: payload,
      },
      () => commands.listGitBranches(payload),
    );
  },

  checkoutGitBranch(payload) {
    return callSpectaCommand(
      {
        command: 'checkout_git_branch',
        guardHint: '切换 Git 分支',
        audit: 'sensitive',
        timeoutMs: 20_000,
        input: payload,
      },
      () => commands.checkoutGitBranch(payload),
    );
  },

  createGitBranch(payload) {
    return callSpectaCommand(
      {
        command: 'create_git_branch',
        guardHint: '创建 Git 分支',
        audit: 'sensitive',
        timeoutMs: 20_000,
        input: payload,
      },
      () => commands.createGitBranch(payload),
    );
  },

  getGitFileBaseline(path) {
    return callSpectaCommand(
      {
        command: 'get_git_file_baseline',
        guardHint: '读取 Git 文件基线',
        idempotent: true,
        input: { path },
      },
      () => commands.getGitFileBaseline(path),
    );
  },

  getGitDiffPreview(payload) {
    return callSpectaCommand(
      {
        command: 'get_git_diff_preview',
        guardHint: '读取 Git Diff 预览',
        idempotent: true,
        timeoutMs: 20_000,
        input: payload,
      },
      () => commands.getGitDiffPreview(payload),
    );
  },

  stageGitPaths(payload) {
    return callSpectaCommand(
      {
        command: 'stage_git_paths',
        guardHint: '暂存 Git 变更',
        input: payload,
      },
      () => commands.stageGitPaths(payload),
    );
  },

  unstageGitPaths(payload) {
    return callSpectaCommand(
      {
        command: 'unstage_git_paths',
        guardHint: '取消暂存 Git 变更',
        input: payload,
      },
      () => commands.unstageGitPaths(payload),
    );
  },

  discardGitPaths(payload) {
    return callSpectaCommand(
      {
        command: 'discard_git_paths',
        guardHint: '放弃 Git 工作区更改',
        audit: 'sensitive',
        input: payload,
      },
      () => commands.discardGitPaths(payload),
    );
  },

  commitGitIndex(payload) {
    return callSpectaCommand(
      {
        command: 'commit_git_index',
        guardHint: '创建 Git 提交',
        audit: 'sensitive',
        input: payload,
      },
      () => commands.commitGitIndex(payload),
    );
  },

  listGitStashes(payload) {
    return callSpectaCommand(
      {
        command: 'list_git_stashes',
        guardHint: '读取 Git 贮藏列表',
        idempotent: true,
        input: payload,
      },
      () => commands.listGitStashes(payload),
    );
  },

  saveGitStash(payload) {
    return callSpectaCommand(
      {
        command: 'save_git_stash',
        guardHint: '保存 Git 贮藏',
        audit: 'sensitive',
        timeoutMs: 20_000,
        input: payload,
      },
      () => commands.saveGitStash(payload),
    );
  },

  applyGitStash(payload) {
    return callSpectaCommand(
      {
        command: 'apply_git_stash',
        guardHint: '应用 Git 贮藏',
        audit: 'sensitive',
        timeoutMs: 20_000,
        input: payload,
      },
      () => commands.applyGitStash(payload),
    );
  },

  dropGitStash(payload) {
    return callSpectaCommand(
      {
        command: 'drop_git_stash',
        guardHint: '删除 Git 贮藏',
        audit: 'sensitive',
        timeoutMs: 20_000,
        input: payload,
      },
      () => commands.dropGitStash(payload),
    );
  },

  getGitPullRequestSupport(payload) {
    return callSpectaCommand(
      {
        command: 'get_git_pull_request_support',
        guardHint: '读取 Git 远端 Pull Request 支持信息',
        idempotent: true,
        input: payload,
      },
      () => commands.getGitPullRequestSupport(payload),
    );
  },
};
