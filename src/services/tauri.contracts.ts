import { z } from 'zod';
import {
  aiEditAuthStateSchema,
  aiEditCreateSnapshotPayloadSchema,
  aiEditCreateSnapshotRequestSchema,
  aiEditGetDiffPayloadSchema,
  aiEditGetDiffRequestSchema,
  aiEditListTimelinePayloadSchema,
  aiEditListTimelineRequestSchema,
  aiEditRestoreSnapshotPayloadSchema,
  aiEditRestoreSnapshotRequestSchema,
  aiEditRevertFilePayloadSchema,
  aiEditRevertFileRequestSchema,
  aiEditRevertHunkPayloadSchema,
  aiEditRevertHunkRequestSchema,
  aiEditRevertTaskPayloadSchema,
  aiEditRevertTaskRequestSchema,
  aiEditSetAuthLevelRequestSchema,
  aiEditSetPinPayloadSchema,
  aiEditSetPinRequestSchema,
  aiEditUndoOperationPayloadSchema,
  aiEditUndoOperationRequestSchema,
} from '@/types/ai/edit.schema';
import {
  aiAgentClassifyTaskPayloadSchema,
  aiAgentClassifyTaskRequestSchema,
  aiAgentNetworkPermissionPayloadSchema,
  aiAgentSetNetworkPermissionRequestSchema,
  aiApplyPatchMetadataSchema,
  aiChatRequestSchema,
  aiChatStreamPayloadSchema,
  aiConfigPayloadSchema,
  aiConversationTitlePayloadSchema,
  aiConversationTitleRequestSchema,
  aiModelRoleSchema,
  aiPatchSetSchema,
  aiProviderConnectionPayloadSchema,
  aiProviderConnectionRequestSchema,
  aiProviderTestPayloadSchema,
  aiProviderTypeSchema,
  aiSuggestionPoolPayloadSchema,
  aiSuggestionPoolRequestSchema,
  aiWebFetchInputSchema,
  aiWebFetchPayloadSchema,
  aiWebSearchInputSchema,
  aiWebSearchPayloadSchema,
} from '@/types/ai/schema';
import {
  agentSidecarApprovalResolveRequestSchema,
  agentSidecarChatRequestSchema,
  agentSidecarCheckpointRestoreRequestSchema,
  agentSidecarExecuteRequestSchema,
  agentSidecarHealthPayloadSchema,
  agentSidecarPlanApproveRequestSchema,
  agentSidecarPlanFinishRequestSchema,
  agentSidecarPlanQueryRequestSchema,
  agentSidecarPlanRejectRequestSchema,
  agentSidecarPlanReplanRequestSchema,
  agentSidecarPlanRequestSchema,
  agentSidecarPlanValidateRequestSchema,
  agentSidecarResponsePayloadSchema,
  agentSidecarWarmupPayloadSchema,
} from '@/types/ai/sidecar.schema';

/**
 * @deprecated Tauri invoke 契约正在迁移到 tauri-specta 生成绑定。
 * 新增或迁移后的 Tauri invoke 路径不得在这里继续维护手写 Zod contract。
 */
export const zTauriVoid = z
  .union([z.null(), z.undefined(), z.void()])
  .transform(() => undefined as void);

const gitChangeKindSchema = z.enum([
  'added',
  'modified',
  'deleted',
  'renamed',
  'typechange',
  'untracked',
  'conflicted',
]);

const gitDiffModeSchema = z.enum(['worktree', 'staged']);

const sshConfigHostPayloadSchema = z.object({
  id: z.string(),
  name: z.string(),
  username: z.string(),
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  identityPath: z.string().nullable(),
  lastUsedLabel: z.string(),
});

const sshConnectionInputSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1),
  authMode: z.enum(['key', 'password']),
  identityPath: z.string().nullable(),
  password: z.string().nullable(),
});

const sshPasswordIdentitySchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1),
});

const sshPreviewEncodingSchema = z.enum(['utf-8', 'utf-8-bom']);
const sshPreviewLineEndingSchema = z.enum(['lf', 'crlf', 'cr', 'mixed', 'none']);

const gitCommitSummaryPayloadSchema = z.object({
  id: z.string(),
  shortId: z.string(),
  summary: z.string(),
  authorName: z.string(),
  authoredAt: z.string(),
});

const gitCommitHistoryPayloadSchema = z.object({
  entries: z.array(gitCommitSummaryPayloadSchema),
  hasMore: z.boolean(),
  nextOffset: z.number().int().nonnegative().nullable(),
});

const gitFileStatusPayloadSchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  fileName: z.string(),
  previousPath: z.string().nullable(),
  previousRelativePath: z.string().nullable(),
  indexStatus: gitChangeKindSchema.nullable(),
  worktreeStatus: gitChangeKindSchema.nullable(),
  isConflicted: z.boolean(),
  isUntracked: z.boolean(),
});

const gitBranchKindSchema = z.enum(['local', 'remote']);

const gitBranchPayloadSchema = z.object({
  name: z.string(),
  shorthand: z.string(),
  kind: gitBranchKindSchema,
  upstreamName: z.string().nullable(),
  isCurrent: z.boolean(),
  isHead: z.boolean(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  lastCommit: gitCommitSummaryPayloadSchema.nullable(),
});

const gitBranchListPayloadSchema = z.object({
  branches: z.array(gitBranchPayloadSchema),
});

const gitRepositoryStatusPayloadSchema = z.object({
  available: z.boolean(),
  message: z.string().nullable(),
  repositoryRootPath: z.string().nullable(),
  repositoryName: z.string().nullable(),
  gitDirPath: z.string().nullable(),
  headBranchName: z.string().nullable(),
  headShortName: z.string().nullable(),
  headShortOid: z.string().nullable(),
  isDetached: z.boolean(),
  isClean: z.boolean(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  stagedCount: z.number().int().nonnegative(),
  unstagedCount: z.number().int().nonnegative(),
  untrackedCount: z.number().int().nonnegative(),
  conflictedCount: z.number().int().nonnegative(),
  files: z.array(gitFileStatusPayloadSchema),
  lastCommit: gitCommitSummaryPayloadSchema.nullable(),
});

const gitStashEntryPayloadSchema = z.object({
  index: z.number().int().nonnegative(),
  stashId: z.string(),
  summary: z.string(),
  branchName: z.string().nullable(),
  commitShortId: z.string().nullable(),
});

const gitStashListPayloadSchema = z.object({
  entries: z.array(gitStashEntryPayloadSchema),
});

const gitPullRequestProviderSchema = z.enum(['github', 'gitlab', 'gitea', 'bitbucket', 'unknown']);

const gitPullRequestSupportPayloadSchema = z.object({
  available: z.boolean(),
  remoteName: z.string().nullable(),
  provider: gitPullRequestProviderSchema,
  repositoryUrl: z.string().nullable(),
  pullRequestsUrl: z.string().nullable(),
  createPullRequestUrl: z.string().nullable(),
});

export const tauriContracts = {
  agentSidecarHealth: {
    inSchema: z.void(),
    outSchema: agentSidecarHealthPayloadSchema,
  },
  agentSidecarRestart: {
    inSchema: z.void(),
    outSchema: agentSidecarHealthPayloadSchema,
  },
  agentSidecarWarmup: {
    inSchema: z.void(),
    outSchema: agentSidecarWarmupPayloadSchema,
  },
  agentSidecarChat: {
    inSchema: agentSidecarChatRequestSchema,
    outSchema: agentSidecarResponsePayloadSchema,
  },
  agentSidecarPlan: {
    inSchema: agentSidecarPlanRequestSchema,
    outSchema: agentSidecarResponsePayloadSchema,
  },
  agentSidecarPlanApprove: {
    inSchema: agentSidecarPlanApproveRequestSchema,
    outSchema: agentSidecarResponsePayloadSchema,
  },
  agentSidecarPlanQuery: {
    inSchema: agentSidecarPlanQueryRequestSchema,
    outSchema: agentSidecarResponsePayloadSchema,
  },
  agentSidecarPlanReject: {
    inSchema: agentSidecarPlanRejectRequestSchema,
    outSchema: agentSidecarResponsePayloadSchema,
  },
  agentSidecarPlanFinish: {
    inSchema: agentSidecarPlanFinishRequestSchema,
    outSchema: agentSidecarResponsePayloadSchema,
  },
  agentSidecarPlanValidate: {
    inSchema: agentSidecarPlanValidateRequestSchema,
    outSchema: agentSidecarResponsePayloadSchema,
  },
  agentSidecarPlanReplan: {
    inSchema: agentSidecarPlanReplanRequestSchema,
    outSchema: agentSidecarResponsePayloadSchema,
  },
  agentSidecarExecute: {
    inSchema: agentSidecarExecuteRequestSchema,
    outSchema: agentSidecarResponsePayloadSchema,
  },
  agentSidecarResolveApproval: {
    inSchema: agentSidecarApprovalResolveRequestSchema,
    outSchema: agentSidecarResponsePayloadSchema,
  },
  agentSidecarRestoreCheckpoint: {
    inSchema: agentSidecarCheckpointRestoreRequestSchema,
    outSchema: agentSidecarResponsePayloadSchema,
  },
  getGitRepositoryStatus: {
    inSchema: z.object({
      workspaceRootPath: z.string().nullable().optional(),
    }),
    outSchema: gitRepositoryStatusPayloadSchema,
  },
  initGitRepository: {
    inSchema: z.object({
      workspaceRootPath: z.string().nullable().optional(),
    }),
    outSchema: gitRepositoryStatusPayloadSchema,
  },
  listGitCommitHistory: {
    inSchema: z.object({
      repositoryRootPath: z.string().min(1),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(200).optional(),
    }),
    outSchema: gitCommitHistoryPayloadSchema,
  },
  listGitBranches: {
    inSchema: z.object({
      repositoryRootPath: z.string().min(1),
    }),
    outSchema: gitBranchListPayloadSchema,
  },
  checkoutGitBranch: {
    inSchema: z.object({
      repositoryRootPath: z.string().min(1),
      branchName: z.string().min(1),
    }),
    outSchema: gitRepositoryStatusPayloadSchema,
  },
  createGitBranch: {
    inSchema: z.object({
      repositoryRootPath: z.string().min(1),
      branchName: z.string().min(1),
      checkout: z.boolean(),
    }),
    outSchema: gitRepositoryStatusPayloadSchema,
  },
  getGitFileBaseline: {
    inSchema: z.object({
      path: z.string().min(1),
    }),
    outSchema: z.object({
      available: z.boolean(),
      message: z.string().nullable(),
      repositoryRootPath: z.string().nullable(),
      filePath: z.string(),
      relativePath: z.string().nullable(),
      isTracked: z.boolean(),
      content: z.string().nullable(),
    }),
  },
  getGitDiffPreview: {
    inSchema: z.object({
      repositoryRootPath: z.string().min(1),
      path: z.string().min(1),
      mode: gitDiffModeSchema,
    }),
    outSchema: z.object({
      id: z.string().min(1),
      repositoryRootPath: z.string().min(1),
      path: z.string().min(1),
      relativePath: z.string().min(1),
      title: z.string().min(1),
      mode: gitDiffModeSchema,
      originalContent: z.string(),
      modifiedContent: z.string(),
      isEmpty: z.boolean(),
    }),
  },
  stageGitPaths: {
    inSchema: z.object({
      repositoryRootPath: z.string(),
      paths: z.array(z.string()),
    }),
    outSchema: gitRepositoryStatusPayloadSchema,
  },
  unstageGitPaths: {
    inSchema: z.object({
      repositoryRootPath: z.string(),
      paths: z.array(z.string()),
    }),
    outSchema: gitRepositoryStatusPayloadSchema,
  },
  discardGitPaths: {
    inSchema: z.object({
      repositoryRootPath: z.string(),
      paths: z.array(z.string()),
    }),
    outSchema: gitRepositoryStatusPayloadSchema,
  },
  commitGitIndex: {
    inSchema: z.object({
      repositoryRootPath: z.string(),
      message: z.string(),
    }),
    outSchema: z.object({
      status: gitRepositoryStatusPayloadSchema,
      commit: gitCommitSummaryPayloadSchema,
    }),
  },
  listGitStashes: {
    inSchema: z.object({
      repositoryRootPath: z.string().min(1),
    }),
    outSchema: gitStashListPayloadSchema,
  },
  saveGitStash: {
    inSchema: z.object({
      repositoryRootPath: z.string().min(1),
      message: z.string().nullable(),
      includeUntracked: z.boolean(),
    }),
    outSchema: gitRepositoryStatusPayloadSchema,
  },
  applyGitStash: {
    inSchema: z.object({
      repositoryRootPath: z.string().min(1),
      stashIndex: z.number().int().nonnegative(),
      pop: z.boolean(),
    }),
    outSchema: gitRepositoryStatusPayloadSchema,
  },
  dropGitStash: {
    inSchema: z.object({
      repositoryRootPath: z.string().min(1),
      stashIndex: z.number().int().nonnegative(),
    }),
    outSchema: gitRepositoryStatusPayloadSchema,
  },
  getGitPullRequestSupport: {
    inSchema: z.object({
      repositoryRootPath: z.string().min(1),
    }),
    outSchema: gitPullRequestSupportPayloadSchema,
  },
  testSshConnection: {
    inSchema: sshConnectionInputSchema,
    outSchema: z.object({
      ok: z.boolean(),
      code: z.string(),
      message: z.string(),
    }),
  },
  saveSshPassword: {
    inSchema: sshPasswordIdentitySchema.extend({
      password: z.string().min(1),
    }),
    outSchema: z.object({
      hasPassword: z.boolean(),
    }),
  },
  getSshPassword: {
    inSchema: sshPasswordIdentitySchema,
    outSchema: z.object({
      password: z.string().min(1),
    }),
  },
  listSshConfigHosts: {
    inSchema: z.void(),
    outSchema: z.array(sshConfigHostPayloadSchema),
  },
  listSshDirectory: {
    inSchema: sshConnectionInputSchema.extend({
      path: z.string(),
    }),
    outSchema: z.object({
      path: z.string(),
      entries: z.array(
        z.object({
          name: z.string(),
          path: z.string(),
          kind: z.enum(['directory', 'file']),
          size: z.number().int().nonnegative(),
        }),
      ),
    }),
  },
  downloadSshFile: {
    inSchema: sshConnectionInputSchema.extend({
      remotePath: z.string().min(1),
      localPath: z.string().min(1),
    }),
    outSchema: z.object({
      remotePath: z.string(),
      localPath: z.string(),
      byteSize: z.number().int().nonnegative(),
    }),
  },
  uploadSshFile: {
    inSchema: sshConnectionInputSchema.extend({
      localPath: z.string().min(1),
      remoteDirectory: z.string(),
    }),
    outSchema: z.object({
      localPath: z.string(),
      remotePath: z.string(),
      byteSize: z.number().int().nonnegative(),
    }),
  },
  readSshFile: {
    inSchema: sshConnectionInputSchema.extend({
      remotePath: z.string().min(1),
    }),
    outSchema: z.object({
      remotePath: z.string(),
      content: z.string(),
      byteSize: z.number().int().nonnegative(),
      encoding: sshPreviewEncodingSchema,
      lineCount: z.number().int().nonnegative(),
      lineEnding: sshPreviewLineEndingSchema,
      permission: z.string(),
      owner: z.string(),
      modifiedAt: z.string().nullable(),
    }),
  },
  writeSshFile: {
    inSchema: sshConnectionInputSchema.extend({
      remotePath: z.string().min(1),
      content: z.string(),
      encoding: sshPreviewEncodingSchema,
      lineEnding: sshPreviewLineEndingSchema,
    }),
    outSchema: z.object({
      remotePath: z.string(),
      byteSize: z.number().int().nonnegative(),
    }),
  },
  deleteSshPath: {
    inSchema: sshConnectionInputSchema.extend({
      remotePath: z.string().min(1),
    }),
    outSchema: z.object({
      remotePath: z.string(),
    }),
  },
  renameSshPath: {
    inSchema: sshConnectionInputSchema.extend({
      remotePath: z.string().min(1),
      newName: z.string().min(1),
    }),
    outSchema: z.object({
      oldPath: z.string(),
      newPath: z.string(),
    }),
  },
  createSshDirectory: {
    inSchema: sshConnectionInputSchema.extend({
      remoteDirectory: z.string(),
    }),
    outSchema: z.object({
      remotePath: z.string(),
    }),
  },
  aiGetConfig: {
    inSchema: z.void(),
    outSchema: aiConfigPayloadSchema,
  },
  aiSaveConfig: {
    inSchema: z.object({
      role: aiModelRoleSchema.optional(),
      providerType: aiProviderTypeSchema,
      selectedModel: z.string().nullable(),
      baseUrl: z.string().nullable(),
      inlineCompletionEnabled: z.boolean(),
      chatEnabled: z.boolean(),
      agentEnabled: z.boolean(),
    }),
    outSchema: aiConfigPayloadSchema,
  },
  aiSaveCredentials: {
    inSchema: z.object({
      providerId: z.string().min(1),
      apiKey: z.string().min(1),
    }),
    outSchema: aiConfigPayloadSchema,
  },
  aiTestProviderConfig: {
    inSchema: aiProviderConnectionRequestSchema,
    outSchema: aiProviderTestPayloadSchema,
  },
  aiConnectProvider: {
    inSchema: aiProviderConnectionRequestSchema,
    outSchema: aiProviderConnectionPayloadSchema,
  },
  aiClearCredentials: {
    inSchema: z.void(),
    outSchema: zTauriVoid,
  },
  aiTestProvider: {
    inSchema: z.void(),
    outSchema: aiProviderTestPayloadSchema,
  },
  aiGenerateConversationTitle: {
    inSchema: aiConversationTitleRequestSchema,
    outSchema: aiConversationTitlePayloadSchema,
  },
  aiGetSuggestionPoolCache: {
    inSchema: z.void(),
    outSchema: aiSuggestionPoolPayloadSchema.nullable(),
  },
  aiGenerateSuggestionPool: {
    inSchema: aiSuggestionPoolRequestSchema,
    outSchema: aiSuggestionPoolPayloadSchema,
  },
  aiChatStream: {
    inSchema: aiChatRequestSchema,
    outSchema: aiChatStreamPayloadSchema,
  },
  aiCancel: {
    inSchema: z.object({
      streamId: z.string().min(1),
    }),
    outSchema: zTauriVoid,
  },
  aiInlineComplete: {
    inSchema: z.object({
      filePath: z.string(),
      language: z.string(),
      cursorOffset: z.number().int().nonnegative(),
      prefix: z.string(),
      suffix: z.string(),
      recentEdits: z.array(z.string()).optional(),
    }),
    outSchema: z.object({
      insertText: z.string(),
      range: z.object({
        startOffset: z.number().int().nonnegative(),
        endOffset: z.number().int().nonnegative(),
      }),
      confidence: z.enum(['low', 'medium', 'high']),
    }),
  },
  aiAgentClassifyTask: {
    inSchema: aiAgentClassifyTaskRequestSchema,
    outSchema: aiAgentClassifyTaskPayloadSchema,
  },
  aiAgentSetNetworkPermission: {
    inSchema: aiAgentSetNetworkPermissionRequestSchema,
    outSchema: aiAgentNetworkPermissionPayloadSchema,
  },
  aiWebSearch: {
    inSchema: aiWebSearchInputSchema,
    outSchema: aiWebSearchPayloadSchema,
  },
  aiWebFetch: {
    inSchema: aiWebFetchInputSchema,
    outSchema: aiWebFetchPayloadSchema,
  },
  aiProposePatch: {
    inSchema: z.object({
      path: z.string().min(1),
      originalContent: z.string(),
      updatedContent: z.string(),
      summary: z.string(),
    }),
    outSchema: z.object({
      patch: aiPatchSetSchema,
    }),
  },
  aiApplyPatch: {
    inSchema: z.object({
      patch: aiPatchSetSchema,
      metadata: aiApplyPatchMetadataSchema.optional(),
    }),
    outSchema: z.object({
      appliedFiles: z.array(
        z.object({
          path: z.string(),
          byteSize: z.number().int().nonnegative(),
        }),
      ),
    }),
  },
  aiEditGetAuthLevel: {
    inSchema: z.void(),
    outSchema: aiEditAuthStateSchema,
  },
  aiEditSetAuthLevel: {
    inSchema: aiEditSetAuthLevelRequestSchema,
    outSchema: aiEditAuthStateSchema,
  },
  aiEditListTimeline: {
    inSchema: aiEditListTimelineRequestSchema,
    outSchema: aiEditListTimelinePayloadSchema,
  },
  aiEditCreateSnapshot: {
    inSchema: aiEditCreateSnapshotRequestSchema,
    outSchema: aiEditCreateSnapshotPayloadSchema,
  },
  aiEditSetPin: {
    inSchema: aiEditSetPinRequestSchema,
    outSchema: aiEditSetPinPayloadSchema,
  },
  aiEditGetDiff: {
    inSchema: aiEditGetDiffRequestSchema,
    outSchema: aiEditGetDiffPayloadSchema,
  },
  aiEditRestoreSnapshot: {
    inSchema: aiEditRestoreSnapshotRequestSchema,
    outSchema: aiEditRestoreSnapshotPayloadSchema,
  },
  aiEditUndoOperation: {
    inSchema: aiEditUndoOperationRequestSchema,
    outSchema: aiEditUndoOperationPayloadSchema,
  },
  aiEditRevertFile: {
    inSchema: aiEditRevertFileRequestSchema,
    outSchema: aiEditRevertFilePayloadSchema,
  },
  aiEditRevertHunk: {
    inSchema: aiEditRevertHunkRequestSchema,
    outSchema: aiEditRevertHunkPayloadSchema,
  },
  aiEditRevertTask: {
    inSchema: aiEditRevertTaskRequestSchema,
    outSchema: aiEditRevertTaskPayloadSchema,
  },
} as const;
