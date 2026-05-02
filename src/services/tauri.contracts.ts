import {
  agentSidecarApprovalResolveRequestSchema,
  agentSidecarChatRequestSchema,
  agentSidecarExecuteRequestSchema,
  agentSidecarHealthPayloadSchema,
  agentSidecarPlanRequestSchema,
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
  aiAgentApprovePlanPayloadSchema,
  aiAgentApprovePlanRequestSchema,
  aiAgentClassifyTaskPayloadSchema,
  aiAgentClassifyTaskRequestSchema,
  aiAgentListRunsPayloadSchema,
  aiAgentNetworkPermissionPayloadSchema,
  aiAgentPlanPayloadSchema,
  aiAgentPlanRequestSchema,
  aiAgentRunIdRequestSchema,
  aiAgentRunPayloadSchema,
  aiAgentRunPlanRequestSchema,
  aiAgentRunStepRequestSchema,
  aiAgentResolveToolConfirmationRequestSchema,
  aiAgentSetNetworkPermissionRequestSchema,
  aiApplyPatchMetadataSchema,
  aiChatPayloadSchema,
  aiChatRequestSchema,
  aiChatStreamPayloadSchema,
  aiCodeActionPayloadSchema,
  aiCodeActionRequestSchema,
  aiConfigPayloadSchema,
  aiConversationTitlePayloadSchema,
  aiConversationTitleRequestSchema,
  aiPatchSetSchema,
  aiProviderProfileDetailPayloadSchema,
  aiProviderProfilePayloadSchema,
  aiProviderConnectionPayloadSchema,
  aiProviderConnectionRequestSchema,
  aiProviderTestPayloadSchema,
  aiProviderTypeSchema,
  aiToolDefinitionPayloadSchema,
  aiWebFetchInputSchema,
  aiWebFetchPayloadSchema,
  aiWebSearchInputSchema,
  aiWebSearchPayloadSchema,
} from '@/types/ai.schema';
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
  score: z.number(),
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
});

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
  agentSidecarChat: {
    inSchema: agentSidecarChatRequestSchema,
    outSchema: agentSidecarResponsePayloadSchema,
  },
  agentSidecarPlan: {
    inSchema: agentSidecarPlanRequestSchema,
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
  testSshConnection: {
    inSchema: sshConnectionInputSchema,
    outSchema: z.object({
      ok: z.boolean(),
      code: z.string(),
      message: z.string(),
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
  aiChat: {
    inSchema: aiChatRequestSchema,
    outSchema: aiChatPayloadSchema,
  },
  aiGenerateConversationTitle: {
    inSchema: aiConversationTitleRequestSchema,
    outSchema: aiConversationTitlePayloadSchema,
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
  aiPlanTask: {
    inSchema: aiAgentPlanRequestSchema,
    outSchema: aiAgentPlanPayloadSchema,
  },
  aiAgentApprovePlan: {
    inSchema: aiAgentApprovePlanRequestSchema,
    outSchema: aiAgentApprovePlanPayloadSchema,
  },
  aiAgentRunPlan: {
    inSchema: aiAgentRunPlanRequestSchema,
    outSchema: aiAgentRunPayloadSchema,
  },
  aiAgentRunStep: {
    inSchema: aiAgentRunStepRequestSchema,
    outSchema: aiAgentRunPayloadSchema,
  },
  aiAgentPause: {
    inSchema: aiAgentRunIdRequestSchema,
    outSchema: aiAgentRunPayloadSchema,
  },
  aiAgentResume: {
    inSchema: aiAgentRunIdRequestSchema,
    outSchema: aiAgentRunPayloadSchema,
  },
  aiAgentCancel: {
    inSchema: aiAgentRunIdRequestSchema,
    outSchema: aiAgentRunPayloadSchema,
  },
  aiAgentGetRun: {
    inSchema: aiAgentRunIdRequestSchema,
    outSchema: aiAgentRunPayloadSchema,
  },
  aiAgentListRuns: {
    inSchema: z.void(),
    outSchema: aiAgentListRunsPayloadSchema,
  },
  aiAgentSetNetworkPermission: {
    inSchema: aiAgentSetNetworkPermissionRequestSchema,
    outSchema: aiAgentNetworkPermissionPayloadSchema,
  },
  aiAgentResolveToolConfirmation: {
    inSchema: aiAgentResolveToolConfirmationRequestSchema,
    outSchema: aiAgentRunPayloadSchema,
  },
  aiWebSearch: {
    inSchema: aiWebSearchInputSchema,
    outSchema: aiWebSearchPayloadSchema,
  },
  aiWebFetch: {
    inSchema: aiWebFetchInputSchema,
    outSchema: aiWebFetchPayloadSchema,
  },
  aiBuildIndex: {
    inSchema: z.object({
      workspaceRootPath: z.string().min(1),
    }),
    outSchema: z.object({
      rootPath: z.string(),
      indexedFileCount: z.number().int().nonnegative(),
      skippedFileCount: z.number().int().nonnegative(),
    }),
  },
  aiQueryIndex: {
    inSchema: z.object({
      workspaceRootPath: z.string().min(1),
      query: z.string(),
      limit: z.number().int().positive().max(80).optional(),
    }),
    outSchema: z.object({
      rootPath: z.string(),
      results: z.array(z.object({
        path: z.string(),
        lineNumber: z.number().int().positive().nullable(),
        preview: z.string(),
        score: z.number(),
      })),
    }),
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
  aiListTools: {
    inSchema: z.void(),
    outSchema: z.array(aiToolDefinitionPayloadSchema),
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
