import { commands } from '@/bindings/tauri';
import type { ITauriService } from '@/types/tauri';
import { utf8ByteLength } from '@/utils/core/bytes';
import { type ICommandMeta, runCommand } from './tauri.ipc-define';
import { buildPayloadMetrics } from './tauri.ipc-metrics';
import type { IIpcCallOptions } from './tauri.ipc-types';

const textByteLength = (value: unknown): number =>
  typeof value === 'string' && value.length > 0 ? utf8ByteLength(value) : 0;

const sumTextBytes = (...values: unknown[]): number =>
  values.reduce<number>((total, value) => total + textByteLength(value), 0);

// Git 出参浅层字节度量的固定开销常量：把原散落的魔法数字语义化，数值与原实现逐一对齐。
const PAYLOAD_BASE_OVERHEAD_BYTES = 96; // 单个 payload（detail / diff）的固定基准开销
const CONTAINER_OVERHEAD_BYTES = 32; // 容器节点（每个 hunk、提交历史列表）的结构开销
const PER_ITEM_OVERHEAD_BYTES = 24; // 每个 file / 提交 entry 的结构开销
const PER_LEAF_OVERHEAD_BYTES = 16; // 每个 diff line / ref 的结构开销
const SCALAR_FIELD_BYTES = 8; // 单个 number/boolean/parentId 的计量字节

const shallowStringBytes = (value: unknown): number => {
  if (!value || typeof value !== 'object') return textByteLength(value);
  let total = 0;
  for (const fieldValue of Object.values(value as Record<string, unknown>)) {
    if (typeof fieldValue === 'string') {
      total += textByteLength(fieldValue);
    } else if (typeof fieldValue === 'number' || typeof fieldValue === 'boolean') {
      total += SCALAR_FIELD_BYTES;
    }
  }
  return total;
};

// NOTE: 浅层字段遍历度量替代 JSON.stringify，避免对大 payload 的序列化开销。
const measureGitCommitDetailOutput = (output: unknown) => {
  if (!output || typeof output !== 'object') return buildPayloadMetrics(output);

  const payload = output as {
    files?: Array<Record<string, unknown>>;
    body?: string;
    summary?: string;
    authorName?: string;
    authorEmail?: string;
    authoredAt?: string;
    id?: string;
    shortId?: string;
  };

  const baseBytes = sumTextBytes(
    payload.id,
    payload.shortId,
    payload.summary,
    payload.body,
    payload.authorName,
    payload.authorEmail,
    payload.authoredAt,
  );

  const filesBytes = Array.isArray(payload.files)
    ? payload.files.reduce(
        (total, file) => total + shallowStringBytes(file) + PER_ITEM_OVERHEAD_BYTES,
        0,
      )
    : 0;

  return { bytes: baseBytes + filesBytes + PAYLOAD_BASE_OVERHEAD_BYTES };
};

const measureGitDiffPayloadOutput = (output: unknown) => {
  if (!output || typeof output !== 'object') return buildPayloadMetrics(output);

  const payload = output as {
    originalContent?: string;
    modifiedContent?: string;
    relativePath?: string;
    fileName?: string;
    title?: string;
    mode?: string;
    id?: string;
    repositoryRootPath?: string;
    path?: string;
    hunks?: Array<{
      lines?: Array<{
        content?: string;
        tag?: string;
        oldLine?: number | null;
        newLine?: number | null;
      }>;
    }>;
  };

  const scalarBytes = sumTextBytes(
    payload.id,
    payload.repositoryRootPath,
    payload.path,
    payload.relativePath,
    payload.fileName,
    payload.title,
    payload.mode,
    payload.originalContent,
    payload.modifiedContent,
  );
  let bytes = scalarBytes + PAYLOAD_BASE_OVERHEAD_BYTES;

  if (Array.isArray(payload.hunks)) {
    for (const hunk of payload.hunks) {
      bytes += CONTAINER_OVERHEAD_BYTES;
      if (!Array.isArray(hunk.lines)) continue;
      for (const line of hunk.lines) {
        bytes += textByteLength(line.content) + textByteLength(line.tag) + PER_LEAF_OVERHEAD_BYTES;
      }
    }
  }

  return { bytes };
};

/**
 * git log（提交历史）出参的浅层字节度量。与 measureGitCommitDetailOutput /
 * measureGitDiffPayloadOutput 同口径：只累加已知标量字段与 parentIds/refs 的字节，
 * 避免对整份提交列表做一次纯统计用途的 JSON.stringify。导出以便单测覆盖。
 */
export const measureGitCommitHistoryOutput = (output: unknown) => {
  if (!output || typeof output !== 'object') return buildPayloadMetrics(output);

  const payload = output as {
    entries?: Array<{
      id?: string;
      shortId?: string;
      summary?: string;
      authorName?: string;
      authorEmail?: string;
      authoredAt?: string;
      parentIds?: string[];
      refs?: Array<Record<string, unknown>>;
    }>;
  };

  const entriesBytes = Array.isArray(payload.entries)
    ? payload.entries.reduce((total, entry) => {
        const scalarBytes = sumTextBytes(
          entry.id,
          entry.shortId,
          entry.summary,
          entry.authorName,
          entry.authorEmail,
          entry.authoredAt,
        );
        let entryBytes = scalarBytes + PER_ITEM_OVERHEAD_BYTES;

        if (Array.isArray(entry.parentIds)) {
          for (const parentId of entry.parentIds) {
            entryBytes += textByteLength(parentId) + SCALAR_FIELD_BYTES;
          }
        }

        if (Array.isArray(entry.refs)) {
          for (const ref of entry.refs) {
            entryBytes += shallowStringBytes(ref) + PER_LEAF_OVERHEAD_BYTES;
          }
        }

        return total + entryBytes;
      }, 0)
    : 0;

  return { bytes: entriesBytes + CONTAINER_OVERHEAD_BYTES };
};

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

/**
 * Git Tauri 命令的声明式包装元数据表。每条的语义与原手写 callSpectaCommand 逐字段对齐，
 * 运行期行为不变；只是把重复的 option 字面量集中到一处便于审计。
 */
const GIT_COMMAND_META = {
  getGitRepositoryStatus: {
    command: 'get_git_repository_status',
    guardHint: '读取 Git 仓库状态',
    idempotent: true,
  },
  initGitRepository: {
    command: 'init_git_repository',
    guardHint: '初始化 Git 仓库',
  },
  listGitCommitHistory: {
    command: 'list_git_commit_history',
    guardHint: '读取 Git 提交历史',
    idempotent: true,
    timeoutMs: 20_000,
    measureOutput: measureGitCommitHistoryOutput,
  },
  getGitCommitDetail: {
    command: 'get_git_commit_detail',
    guardHint: '读取 Git 提交详情',
    idempotent: true,
    timeoutMs: 20_000,
    measureOutput: measureGitCommitDetailOutput,
  },
  getGitCommitFileDiff: {
    command: 'get_git_commit_file_diff',
    guardHint: '读取 Git 提交文件 Diff',
    idempotent: true,
    timeoutMs: 20_000,
    measureOutput: measureGitDiffPayloadOutput,
  },
  getGitCommitFileDiffPreview: {
    command: 'get_git_commit_file_diff_preview',
    guardHint: '读取 Git 提交文件 Diff 预览',
    idempotent: true,
    timeoutMs: 20_000,
    measureOutput: measureGitDiffPayloadOutput,
  },
  listGitBranches: {
    command: 'list_git_branches',
    guardHint: '读取 Git 分支列表',
    idempotent: true,
  },
  checkoutGitBranch: {
    command: 'checkout_git_branch',
    guardHint: '切换 Git 分支',
    audit: 'sensitive',
    timeoutMs: 20_000,
  },
  checkoutGitCommit: {
    command: 'checkout_git_commit',
    guardHint: '检出 Git 提交（分离 HEAD）',
    audit: 'sensitive',
    timeoutMs: 20_000,
  },
  createGitBranch: {
    command: 'create_git_branch',
    guardHint: '创建 Git 分支',
    audit: 'sensitive',
    timeoutMs: 20_000,
  },
  revertGitCommit: {
    command: 'revert_git_commit',
    guardHint: '回滚 Git 提交',
    audit: 'sensitive',
    timeoutMs: 20_000,
  },
  setGitRemote: {
    command: 'set_git_remote',
    guardHint: '配置 Git 远端地址',
    audit: 'sensitive',
    timeoutMs: 15_000,
  },
  getGitFileBaseline: {
    command: 'get_git_file_baseline',
    guardHint: '读取 Git 文件基线',
    idempotent: true,
  },
  getGitDiffPreview: {
    command: 'get_git_diff_preview',
    guardHint: '读取 Git Diff 预览',
    idempotent: true,
    timeoutMs: 20_000,
    measureOutput: measureGitDiffPayloadOutput,
  },
  stageGitPaths: {
    command: 'stage_git_paths',
    guardHint: '暂存 Git 变更',
    timeoutMs: 20_000,
  },
  unstageGitPaths: {
    command: 'unstage_git_paths',
    guardHint: '取消暂存 Git 变更',
    timeoutMs: 20_000,
  },
  discardGitPaths: {
    command: 'discard_git_paths',
    guardHint: '放弃 Git 工作区更改',
    audit: 'sensitive',
    timeoutMs: 20_000,
  },
  commitGitIndex: {
    command: 'commit_git_index',
    guardHint: '创建 Git 提交',
    audit: 'sensitive',
    timeoutMs: 20_000,
  },
  listGitStashes: {
    command: 'list_git_stashes',
    guardHint: '读取 Git 贮藏列表',
    idempotent: true,
  },
  saveGitStash: {
    command: 'save_git_stash',
    guardHint: '保存 Git 贮藏',
    audit: 'sensitive',
    timeoutMs: 20_000,
  },
  applyGitStash: {
    command: 'apply_git_stash',
    guardHint: '应用 Git 贮藏',
    audit: 'sensitive',
    timeoutMs: 20_000,
  },
  dropGitStash: {
    command: 'drop_git_stash',
    guardHint: '删除 Git 贮藏',
    audit: 'sensitive',
    timeoutMs: 20_000,
  },
  getGitPullRequestSupport: {
    command: 'get_git_pull_request_support',
    guardHint: '读取 Git 远端 Pull Request 支持信息',
    idempotent: true,
  },
  listGitPullRequests: {
    command: 'list_git_pull_requests',
    guardHint: '读取 GitHub Pull Request 列表',
    idempotent: true,
    timeoutMs: 20_000,
  },
  getGitPullRequestDetail: {
    command: 'get_git_pull_request_detail',
    guardHint: '读取 GitHub Pull Request 详情',
    idempotent: true,
    timeoutMs: 20_000,
  },
  createGitPullRequest: {
    command: 'create_git_pull_request',
    guardHint: '创建 GitHub Pull Request',
    audit: 'sensitive',
    timeoutMs: 30_000,
  },
  mergeGitPullRequest: {
    command: 'merge_git_pull_request',
    guardHint: '合并 GitHub Pull Request',
    audit: 'sensitive',
    timeoutMs: 30_000,
  },
  closeGitPullRequest: {
    command: 'close_git_pull_request',
    guardHint: '关闭 GitHub Pull Request',
    audit: 'sensitive',
    timeoutMs: 20_000,
  },
} satisfies Record<string, ICommandMeta>;

export const gitTauriService: TGitTauriService = {
  getGitRepositoryStatus(workspaceRootPath, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.getGitRepositoryStatus, { workspaceRootPath }, options, () =>
      commands.getGitRepositoryStatus(workspaceRootPath ?? null),
    );
  },

  initGitRepository(workspaceRootPath, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.initGitRepository, { workspaceRootPath }, options, () =>
      commands.initGitRepository(workspaceRootPath ?? null),
    );
  },

  listGitCommitHistory(payload, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.listGitCommitHistory, payload, options, () =>
      commands.listGitCommitHistory(payload),
    );
  },

  getGitCommitDetail(payload, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.getGitCommitDetail, payload, options, () =>
      commands.getGitCommitDetail(payload),
    );
  },

  getGitCommitFileDiff(payload, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.getGitCommitFileDiff, payload, options, () =>
      commands.getGitCommitFileDiff(payload),
    );
  },

  getGitCommitFileDiffPreview(payload, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.getGitCommitFileDiffPreview, payload, options, () =>
      commands.getGitCommitFileDiffPreview(payload),
    );
  },

  listGitBranches(payload, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.listGitBranches, payload, options, () =>
      commands.listGitBranches(payload),
    );
  },

  checkoutGitBranch(payload, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.checkoutGitBranch, payload, options, () =>
      commands.checkoutGitBranch(payload),
    );
  },

  checkoutGitCommit(payload, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.checkoutGitCommit, payload, options, () =>
      commands.checkoutGitCommit(payload),
    );
  },

  createGitBranch(payload, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.createGitBranch, payload, options, () =>
      commands.createGitBranch(payload),
    );
  },

  revertGitCommit(payload, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.revertGitCommit, payload, options, () =>
      commands.revertGitCommit(payload),
    );
  },

  setGitRemote(payload, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.setGitRemote, payload, options, () =>
      commands.setGitRemote(payload),
    );
  },

  getGitFileBaseline(path, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.getGitFileBaseline, { path }, options, () =>
      commands.getGitFileBaseline(path),
    );
  },

  getGitDiffPreview(payload, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.getGitDiffPreview, payload, options, () =>
      commands.getGitDiffPreview(payload),
    );
  },

  stageGitPaths(payload, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.stageGitPaths, payload, options, () =>
      commands.stageGitPaths(payload),
    );
  },

  unstageGitPaths(payload, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.unstageGitPaths, payload, options, () =>
      commands.unstageGitPaths(payload),
    );
  },

  discardGitPaths(payload, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.discardGitPaths, payload, options, () =>
      commands.discardGitPaths(payload),
    );
  },

  commitGitIndex(payload, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.commitGitIndex, payload, options, () =>
      commands.commitGitIndex(payload),
    );
  },

  listGitStashes(payload, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.listGitStashes, payload, options, () =>
      commands.listGitStashes(payload),
    );
  },

  saveGitStash(payload, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.saveGitStash, payload, options, () =>
      commands.saveGitStash(payload),
    );
  },

  applyGitStash(payload, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.applyGitStash, payload, options, () =>
      commands.applyGitStash(payload),
    );
  },

  dropGitStash(payload, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.dropGitStash, payload, options, () =>
      commands.dropGitStash(payload),
    );
  },

  getGitPullRequestSupport(payload, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.getGitPullRequestSupport, payload, options, () =>
      commands.getGitPullRequestSupport(payload),
    );
  },

  listGitPullRequests(payload, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.listGitPullRequests, payload, options, () =>
      commands.listGitPullRequests(payload),
    );
  },

  getGitPullRequestDetail(payload, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.getGitPullRequestDetail, payload, options, () =>
      commands.getGitPullRequestDetail(payload),
    );
  },

  createGitPullRequest(payload, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.createGitPullRequest, payload, options, () =>
      commands.createGitPullRequest(payload),
    );
  },

  mergeGitPullRequest(payload, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.mergeGitPullRequest, payload, options, () =>
      commands.mergeGitPullRequest(payload),
    );
  },

  closeGitPullRequest(payload, options?: IIpcCallOptions) {
    return runCommand(GIT_COMMAND_META.closeGitPullRequest, payload, options, () =>
      commands.closeGitPullRequest(payload),
    );
  },
};
