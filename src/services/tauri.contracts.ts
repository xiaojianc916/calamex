import {
  agentSidecarApprovalResolveRequestSchema,
  agentSidecarChatRequestSchema,
  agentSidecarCheckpointRestoreRequestSchema,
  agentSidecarExecuteRequestSchema,
  agentSidecarHealthPayloadSchema,
  agentSidecarPlanApproveRequestSchema,
  agentSidecarPlanFinishRequestSchema,
  agentSidecarPlanQueryRequestSchema,
  agentSidecarPlanReplanRequestSchema,
  agentSidecarPlanRequestSchema,
  agentSidecarPlanRejectRequestSchema,
  agentSidecarPlanValidateRequestSchema,
  agentSidecarResponsePayloadSchema,
} from '@/types/agent-sidecar.schema';
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
  aiEditUndoOperationPayloadSchema,
  aiEditUndoOperationRequestSchema,
} from '@/types/ai-edit.schema';
import {
  aiAgentClassifyTaskPayloadSchema,
  aiAgentClassifyTaskRequestSchema,
  aiAgentNetworkPermissionPayloadSchema,
  aiAgentSetNetworkPermissionRequestSchema,
  aiApplyPatchMetadataSchema,
  aiChatRequestSchema,
  aiChatStreamPayloadSchema,
  aiCodeActionPayloadSchema,
  aiCodeActionRequestSchema,
  aiConfigPayloadSchema,
  aiConversationTitlePayloadSchema,
  aiConversationTitleRequestSchema,
  aiModelRoleSchema,
  aiPatchSetSchema,
  aiProviderConnectionPayloadSchema,
  aiProviderConnectionRequestSchema,
  aiProviderProfileDetailPayloadSchema,
  aiProviderProfilePayloadSchema,
  aiProviderTestPayloadSchema,
  aiProviderTypeSchema,
  aiSuggestionPoolPayloadSchema,
  aiSuggestionPoolRequestSchema,
  aiWebFetchInputSchema,
  aiWebFetchPayloadSchema,
  aiWebSearchInputSchema,
  aiWebSearchPayloadSchema
} from '@/types/ai.schema';
import {
  installWslLinkAgentPayloadSchema,
  installWslLinkAgentRequestSchema,
  probeWslLinkPrimaryPayloadSchema,
  startWslLinkAgentPayloadSchema,
  startWslLinkAgentRequestSchema,
  startWslLinkSupervisorRequestSchema,
  wslLinkAgentArtifactPayloadSchema,
  wslLinkEnvironmentReportSchema,
  wslLinkSupervisorControlPayloadSchema,
  wslLinkStatusPayloadSchema,
} from '@/types/wsl-link.schema';
import { z } from 'zod';

export const zTauriVoid = z
  .union([z.null(), z.undefined(), z.void()])
  .transform(() => undefined as void);

const documentEncodingSchema = z.enum([
  'utf-8',
  'utf-8-bom',
  'gbk',
  'gb18030',
  'utf-16le',
  'utf-16be',
]);

const executorKindSchema = z.enum(['wsl']);

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

const workspaceEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.enum(['directory', 'file']),
  hasChildren: z.boolean(),
});

const workspacePathKindSchema = z.enum(['directory', 'file']);

const workspaceSearchScopeSchema = z.enum(['all', 'file-name', 'symbol', 'content']);

const workspaceSearchResultSchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  name: z.string(),
  kind: z.enum(['file-name', 'content', 'symbol']),
  lineNumber: z.number().int().positive().nullable(),
  lineText: z.string().nullable(),
  matchStart: z.number().int().nonnegative().nullable(),
  matchEnd: z.number().int().nonnegative().nullable(),
  score: z.number(),
});

const workspaceReplacementRequestSchema = z.object({
  workspaceRootPath: z.string().min(1),
  query: z.string(),
  replacement: z.string(),
  matchCase: z.boolean(),
  wholeWord: z.boolean(),
  useRegex: z.boolean(),
  useStructural: z.boolean(),
  includePatterns: z.array(z.string()),
  excludePatterns: z.array(z.string()),
  limit: z.number().int().positive().max(500).optional(),
});

const workspaceReplacementLinePreviewSchema = z.object({
  id: z.string(),
  lineNumber: z.number().int().positive(),
  beforeLine: z.string(),
  afterLine: z.string(),
  replacementCount: z.number().int().positive(),
});

const workspaceReplacementFilePreviewSchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  replacementCount: z.number().int().positive(),
  beforeHash: z.string(),
  afterHash: z.string(),
  diff: z.string(),
  diffTruncated: z.boolean(),
  linePreviews: z.array(workspaceReplacementLinePreviewSchema),
});

const workspaceReplacementPreviewPayloadSchema = z.object({
  rootPath: z.string(),
  fileCount: z.number().int().nonnegative(),
  replacementCount: z.number().int().nonnegative(),
  files: z.array(workspaceReplacementFilePreviewSchema),
});

const workspaceReplacementExpectedFileSchema = z.object({
  path: z.string().min(1),
  beforeHash: z.string().min(1),
  includedMatchIds: z.array(z.string().min(1)).optional(),
});

const workspaceReplacementApplyPayloadSchema = z.object({
  rootPath: z.string(),
  changedFileCount: z.number().int().nonnegative(),
  replacementCount: z.number().int().nonnegative(),
  files: z.array(
    z.object({
      path: z.string(),
      relativePath: z.string(),
      replacementCount: z.number().int().positive(),
      byteSize: z.number().int().nonnegative(),
    }),
  ),
});

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

const executionOptionSchema = z.object({
  type: executorKindSchema,
  label: z.string(),
  available: z.boolean(),
  description: z.string(),
  commandPath: z.string().nullable(),
});

const executionOptionSnakeSchema = z.object({
  type: executorKindSchema,
  label: z.string(),
  available: z.boolean(),
  description: z.string(),
  command_path: z.string().nullable(),
}).transform((value) => ({
  type: value.type,
  label: value.label,
  available: value.available,
  description: value.description,
  commandPath: value.command_path,
}));

const scriptDiagnosticSchema = z.object({
  line: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
  endColumn: z.number().int().nonnegative(),
  level: z.enum(['error', 'warning', 'info', 'style']),
  code: z.string(),
  message: z.string(),
});

const scriptFilePayloadSchema = z.object({
  path: z.string(),
  name: z.string(),
  content: z.string(),
  encoding: documentEncodingSchema,
  lineCount: z.number().int().nonnegative(),
  charCount: z.number().int().nonnegative(),
});

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

const gitPullRequestProviderSchema = z.enum([
  'github',
  'gitlab',
  'gitea',
  'bitbucket',
  'unknown',
]);

const gitPullRequestSupportPayloadSchema = z.object({
  available: z.boolean(),
  remoteName: z.string().nullable(),
  provider: gitPullRequestProviderSchema,
  repositoryUrl: z.string().nullable(),
  pullRequestsUrl: z.string().nullable(),
  createPullRequestUrl: z.string().nullable(),
});

const terminalSessionPayloadSchema = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  shellLabel: z.string(),
  created: z.boolean(),
  initialOutput: z.string().nullable().optional(),
});

const terminalSessionPayloadSnakeSchema = z.object({
  session_id: z.string(),
  cwd: z.string(),
  shell_label: z.string(),
  created: z.boolean(),
  initial_output: z.string().nullable().optional(),
}).transform((value) => ({
  sessionId: value.session_id,
  cwd: value.cwd,
  shellLabel: value.shell_label,
  created: value.created,
  initialOutput: value.initial_output,
}));

const dispatchTerminalScriptPayloadSchema = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  commandLine: z.string(),
  usedTempFile: z.boolean(),
  startedAt: z.string(),
});

const dispatchTerminalScriptPayloadSnakeSchema = z.object({
  session_id: z.string(),
  cwd: z.string(),
  command_line: z.string(),
  used_temp_file: z.boolean(),
  started_at: z.string(),
}).transform((value) => ({
  sessionId: value.session_id,
  cwd: value.cwd,
  commandLine: value.command_line,
  usedTempFile: value.used_temp_file,
  startedAt: value.started_at,
}));

const executionEnvironmentPayloadSchema = z.object({
  recommended: executorKindSchema,
  hasAny: z.boolean(),
  executors: z.array(z.union([executionOptionSchema, executionOptionSnakeSchema])),
});

const executionEnvironmentPayloadSnakeSchema = z.object({
  recommended: executorKindSchema,
  has_any: z.boolean(),
  executors: z.array(z.union([executionOptionSchema, executionOptionSnakeSchema])),
}).transform((value) => ({
  recommended: value.recommended,
  hasAny: value.has_any,
  executors: value.executors,
}));

export const tauriContracts = {
  agentSidecarHealth: {
    inSchema: z.void(),
    outSchema: agentSidecarHealthPayloadSchema,
  },
  agentSidecarRestart: {
    inSchema: z.void(),
    outSchema: agentSidecarHealthPayloadSchema,
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
  analyzeScript: {
    inSchema: z.object({
      path: z.string().nullable(),
      name: z.string().nullable().optional(),
      content: z.string(),
    }),
    outSchema: z.object({
      available: z.boolean(),
      message: z.string().nullable(),
      dialect: z.string(),
      diagnostics: z.array(scriptDiagnosticSchema),
    }),
  },
  formatScript: {
    inSchema: z.object({
      path: z.string().nullable(),
      content: z.string(),
      encoding: documentEncodingSchema,
    }),
    outSchema: z.object({
      content: z.string(),
      encoding: documentEncodingSchema,
      lineCount: z.number().int().nonnegative(),
      charCount: z.number().int().nonnegative(),
    }),
  },
  loadScript: {
    inSchema: z.object({
      path: z.string().min(1),
    }),
    outSchema: scriptFilePayloadSchema,
  },
  loadImageAsset: {
    inSchema: z.object({
      path: z.string().min(1),
    }),
    outSchema: z.object({
      path: z.string(),
      name: z.string(),
      mimeType: z.string(),
      dataUrl: z.string(),
      byteSize: z.number().int().nonnegative(),
    }),
  },
  saveScript: {
    inSchema: z.object({
      path: z.string().min(1),
      content: z.string(),
      encoding: documentEncodingSchema,
    }),
    outSchema: scriptFilePayloadSchema,
  },
  detectEnvironment: {
    inSchema: z.void(),
    outSchema: z.union([executionEnvironmentPayloadSchema, executionEnvironmentPayloadSnakeSchema]),
  },
  getWslLinkStatus: {
    inSchema: z.void(),
    outSchema: wslLinkStatusPayloadSchema,
  },
  checkWslLinkEnvironment: {
    inSchema: z.void(),
    outSchema: wslLinkEnvironmentReportSchema,
  },
  getWslLinkAgentArtifactStatus: {
    inSchema: z.void(),
    outSchema: wslLinkAgentArtifactPayloadSchema,
  },
  installWslLinkAgent: {
    inSchema: installWslLinkAgentRequestSchema,
    outSchema: installWslLinkAgentPayloadSchema,
  },
  startWslLinkAgent: {
    inSchema: startWslLinkAgentRequestSchema,
    outSchema: startWslLinkAgentPayloadSchema,
  },
  startWslLinkSupervisor: {
    inSchema: startWslLinkSupervisorRequestSchema,
    outSchema: wslLinkSupervisorControlPayloadSchema,
  },
  stopWslLinkSupervisor: {
    inSchema: z.void(),
    outSchema: wslLinkSupervisorControlPayloadSchema,
  },
  probeWslLinkPrimary: {
    inSchema: z.void(),
    outSchema: probeWslLinkPrimaryPayloadSchema,
  },
  listWorkspaceEntries: {
    inSchema: z.object({
      path: z.string().optional(),
      rootPath: z.string().optional(),
    }),
    outSchema: z.object({
      rootPath: z.string(),
      rootName: z.string(),
      entries: z.array(workspaceEntrySchema),
    }),
  },
  createWorkspacePath: {
    inSchema: z.object({
      parentPath: z.string().min(1),
      rootPath: z.string().min(1),
      name: z.string().min(1),
      kind: workspacePathKindSchema,
    }),
    outSchema: z.object({
      path: z.string(),
      name: z.string(),
      kind: workspacePathKindSchema,
    }),
  },
  renameWorkspacePath: {
    inSchema: z.object({
      path: z.string().min(1),
      rootPath: z.string().min(1),
      newName: z.string().min(1),
    }),
    outSchema: z.object({
      oldPath: z.string(),
      newPath: z.string(),
      name: z.string(),
    }),
  },
  deleteWorkspacePath: {
    inSchema: z.object({
      path: z.string().min(1),
      rootPath: z.string().min(1),
    }),
    outSchema: z.object({
      path: z.string(),
    }),
  },
  searchWorkspace: {
    inSchema: z.object({
      workspaceRootPath: z.string().min(1),
      query: z.string(),
      scope: workspaceSearchScopeSchema,
      matchCase: z.boolean(),
      wholeWord: z.boolean(),
      useRegex: z.boolean(),
      useStructural: z.boolean(),
      includePatterns: z.array(z.string()),
      excludePatterns: z.array(z.string()),
      limit: z.number().int().positive().max(500).optional(),
    }),
    outSchema: z.object({
      rootPath: z.string(),
      scannedFileCount: z.number().int().nonnegative(),
      results: z.array(workspaceSearchResultSchema),
    }),
  },
  previewWorkspaceReplacement: {
    inSchema: workspaceReplacementRequestSchema,
    outSchema: workspaceReplacementPreviewPayloadSchema,
  },
  applyWorkspaceReplacement: {
    inSchema: z.object({
      request: workspaceReplacementRequestSchema,
      expectedFiles: z.array(workspaceReplacementExpectedFileSchema).min(1),
    }),
    outSchema: workspaceReplacementApplyPayloadSchema,
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
      entries: z.array(z.object({
        name: z.string(),
        path: z.string(),
        kind: z.enum(['directory', 'file']),
        size: z.number().int().nonnegative(),
      })),
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
      name: z.string().min(1),
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
      role: aiModelRoleSchema.optional(),
      providerType: aiProviderTypeSchema,
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
  aiListProviderProfiles: {
    inSchema: z.void(),
    outSchema: z.array(aiProviderProfilePayloadSchema),
  },
  aiGetProviderProfileDetail: {
    inSchema: z.object({
      profileId: z.string().min(1),
    }),
    outSchema: aiProviderProfileDetailPayloadSchema,
  },
  aiSwitchProviderProfile: {
    inSchema: z.object({
      profileId: z.string().min(1),
    }),
    outSchema: aiConfigPayloadSchema,
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
  aiCodeAction: {
    inSchema: aiCodeActionRequestSchema,
    outSchema: aiCodeActionPayloadSchema,
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
      appliedFiles: z.array(z.object({
        path: z.string(),
        byteSize: z.number().int().nonnegative(),
      })),
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
  ensureTerminalSession: {
    inSchema: z.object({
      sessionId: z.string(),
      cwd: z.string().nullable(),
      cols: z.number().int().min(1),
      rows: z.number().int().min(1),
    }),
    outSchema: z.union([terminalSessionPayloadSchema, terminalSessionPayloadSnakeSchema]),
  },
  dispatchScriptToTerminal: {
    inSchema: z.object({
      sessionId: z.string(),
      path: z.string().nullable(),
      workspaceRootPath: z.string().nullable().optional(),
      content: z.string(),
      isDirty: z.boolean(),
      runId: z.string(),
    }),
    outSchema: z.union([dispatchTerminalScriptPayloadSchema, dispatchTerminalScriptPayloadSnakeSchema]),
  },
  writeTerminalInput: {
    inSchema: z.object({
      sessionId: z.string(),
      data: z.string(),
    }),
    outSchema: zTauriVoid,
  },
  resizeTerminalSession: {
    inSchema: z.object({
      sessionId: z.string(),
      cols: z.number().int().min(1),
      rows: z.number().int().min(1),
    }),
    outSchema: zTauriVoid,
  },
  closeTerminalSession: {
    inSchema: z.object({
      sessionId: z.string(),
    }),
    outSchema: zTauriVoid,
  },
  cancelTerminalRun: {
    inSchema: z.object({
      runId: z.string(),
      mode: z.enum(['graceful', 'kill']).optional(),
    }),
    outSchema: zTauriVoid,
  },
} as const;
