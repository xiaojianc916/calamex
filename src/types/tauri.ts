import type {
  IAgentSidecarApprovalResolveRequest,
  IAgentSidecarChatRequest,
  IAgentSidecarExecuteRequest,
  IAgentSidecarHealthPayload,
  IAgentSidecarPlanRequest,
  IAgentSidecarResponsePayload,
  IAgentSidecarStreamEventPayload,
} from './agent-sidecar';
import type {
  IAiAgentApprovePlanPayload,
  IAiAgentApprovePlanRequest,
  IAiAgentClassifyTaskPayload,
  IAiAgentClassifyTaskRequest,
  IAiAgentListRunsPayload,
  IAiAgentNetworkPermissionPayload,
  IAiAgentPlanPayload,
  IAiAgentPlanRequest,
  IAiAgentRunIdRequest,
  IAiAgentRunPayload,
  IAiAgentRunPlanRequest,
  IAiAgentRunStepRequest,
  IAiAgentResolveToolConfirmationRequest,
  IAiAgentSetNetworkPermissionRequest,
  IAiApplyPatchPayload,
  IAiApplyPatchRequest,
  IAiBuildIndexPayload,
  IAiBuildIndexRequest,
  IAiChatPayload,
  IAiChatRequest,
  IAiChatStreamEventPayload,
  IAiChatStreamPayload,
  IAiCodeActionRequest,
  IAiCodeActionResult,
  IAiConfigPayload,
  IAiConversationTitlePayload,
  IAiConversationTitleRequest,
  TAiAgentStreamEvent,
  IAiInlineCompletionRequest,
  IAiInlineCompletionResult,
  IAiProposePatchPayload,
  IAiProposePatchRequest,
  IAiProviderConnectionPayload,
  IAiProviderConnectionRequest,
  IAiProviderProfileDetailPayload,
  IAiProviderProfilePayload,
  IAiProviderProfileSwitchRequest,
  IAiProviderTestPayload,
  IAiQueryIndexPayload,
  IAiQueryIndexRequest,
  IAiSaveConfigRequest,
  IAiSaveCredentialsRequest,
  IAiToolDefinitionPayload,
  IAiWebFetchInput,
  IAiWebFetchPayload,
  IAiWebSearchInput,
  IAiWebSearchPayload,
} from './ai';
import type {
  IAiEditAuthState,
  IAiEditCreateSnapshotPayload,
  IAiEditCreateSnapshotRequest,
  IAiEditGetDiffPayload,
  IAiEditGetDiffRequest,
  IAiEditListTimelinePayload,
  IAiEditListTimelineRequest,
  IAiEditRestoreSnapshotPayload,
  IAiEditRestoreSnapshotRequest,
  IAiEditRevertFilePayload,
  IAiEditRevertFileRequest,
  IAiEditRevertHunkPayload,
  IAiEditRevertHunkRequest,
  IAiEditRevertTaskPayload,
  IAiEditRevertTaskRequest,
  IAiEditSetAuthLevelRequest,
  IAiEditUndoOperationPayload,
  IAiEditUndoOperationRequest,
} from './ai-edit';
import type {
  IAnalyzeScriptPayload,
  IAnalyzeScriptRequest,
  IExecutionEnvironment,
  IFormatScriptPayload,
  IFormatScriptRequest,
  IImageAssetPayload,
  ISaveScriptRequest,
  IScriptFilePayload,
  IWorkspaceDirectoryPayload,
  IWorkspacePathCreatePayload,
  IWorkspacePathCreateRequest,
  IWorkspacePathDeletePayload,
  IWorkspacePathDeleteRequest,
  IWorkspacePathRenamePayload,
  IWorkspacePathRenameRequest,
} from './editor';
import type {
  IGitCommitRequest,
  IGitCommitResultPayload,
  IGitDiffPreviewPayload,
  IGitDiffPreviewRequest,
  IGitFileBaselinePayload,
  IGitPathOperationRequest,
  IGitRepositoryStatusPayload,
} from './git';
import type { IWorkspaceSearchPayload, IWorkspaceSearchRequest } from './search';
import type {
  ICancelTerminalRunRequest,
  ICloseTerminalSessionRequest,
  IDispatchTerminalScriptPayload,
  IDispatchTerminalScriptRequest,
  IEnsureTerminalSessionRequest,
  IResizeTerminalSessionRequest,
  ITerminalSessionPayload,
  IWriteTerminalInputRequest,
} from './terminal';

export interface ISshConnectionTestRequest {
  host: string;
  port: number;
  username: string;
  authMode: 'key' | 'password';
  identityPath: string | null;
}

export interface ISshConnectionTestPayload {
  ok: boolean;
  code: string;
  message: string;
}

export interface ISshDirectoryListRequest extends ISshConnectionTestRequest {
  path: string;
}

export interface ISshDirectoryEntryPayload {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  size: number;
}

export interface ISshDirectoryListPayload {
  path: string;
  entries: ISshDirectoryEntryPayload[];
}

export interface ISshFileDownloadRequest extends ISshConnectionTestRequest {
  remotePath: string;
  localPath: string;
}

export interface ISshFileDownloadPayload {
  remotePath: string;
  localPath: string;
  byteSize: number;
}

export interface ISshFileUploadRequest extends ISshConnectionTestRequest {
  localPath: string;
  remoteDirectory: string;
}

export interface ISshFileUploadPayload {
  localPath: string;
  remotePath: string;
  byteSize: number;
}

export interface ISshPathDeleteRequest extends ISshConnectionTestRequest {
  remotePath: string;
}

export interface ISshPathDeletePayload {
  remotePath: string;
}

export interface ISshPathRenameRequest extends ISshConnectionTestRequest {
  remotePath: string;
  newName: string;
}

export interface ISshPathRenamePayload {
  oldPath: string;
  newPath: string;
}

export interface ISshDirectoryCreateRequest extends ISshConnectionTestRequest {
  remoteDirectory: string;
  name: string;
}

export interface ISshDirectoryCreatePayload {
  remotePath: string;
}

export interface ISshConfigHostPayload {
  id: string;
  name: string;
  username: string;
  host: string;
  port: number;
  identityPath: string | null;
  lastUsedLabel: string;
}

export interface ITauriService {
  agentSidecarHealth(): Promise<IAgentSidecarHealthPayload>;
  agentSidecarChat(payload: IAgentSidecarChatRequest): Promise<IAgentSidecarResponsePayload>;
  agentSidecarPlan(payload: IAgentSidecarPlanRequest): Promise<IAgentSidecarResponsePayload>;
  agentSidecarExecute(payload: IAgentSidecarExecuteRequest): Promise<IAgentSidecarResponsePayload>;
  agentSidecarResolveApproval(
    payload: IAgentSidecarApprovalResolveRequest,
  ): Promise<IAgentSidecarResponsePayload>;
  onAgentSidecarStream(
    handler: (payload: IAgentSidecarStreamEventPayload) => void,
  ): Promise<() => void>;
  analyzeScript(payload: IAnalyzeScriptRequest): Promise<IAnalyzeScriptPayload>;
  formatScript(payload: IFormatScriptRequest): Promise<IFormatScriptPayload>;
  loadScript(path: string): Promise<IScriptFilePayload>;
  loadImageAsset(path: string): Promise<IImageAssetPayload>;
  saveScript(payload: ISaveScriptRequest): Promise<IScriptFilePayload>;
  detectEnvironment(): Promise<IExecutionEnvironment>;
  listWorkspaceEntries(path?: string, rootPath?: string): Promise<IWorkspaceDirectoryPayload>;
  createWorkspacePath(payload: IWorkspacePathCreateRequest): Promise<IWorkspacePathCreatePayload>;
  renameWorkspacePath(payload: IWorkspacePathRenameRequest): Promise<IWorkspacePathRenamePayload>;
  deleteWorkspacePath(payload: IWorkspacePathDeleteRequest): Promise<IWorkspacePathDeletePayload>;
  searchWorkspace(payload: IWorkspaceSearchRequest): Promise<IWorkspaceSearchPayload>;
  getGitRepositoryStatus(workspaceRootPath?: string | null): Promise<IGitRepositoryStatusPayload>;
  initGitRepository(workspaceRootPath?: string | null): Promise<IGitRepositoryStatusPayload>;
  getGitFileBaseline(path: string): Promise<IGitFileBaselinePayload>;
  getGitDiffPreview(payload: IGitDiffPreviewRequest): Promise<IGitDiffPreviewPayload>;
  stageGitPaths(payload: IGitPathOperationRequest): Promise<IGitRepositoryStatusPayload>;
  unstageGitPaths(payload: IGitPathOperationRequest): Promise<IGitRepositoryStatusPayload>;
  discardGitPaths(payload: IGitPathOperationRequest): Promise<IGitRepositoryStatusPayload>;
  commitGitIndex(payload: IGitCommitRequest): Promise<IGitCommitResultPayload>;
  ensureTerminalSession(payload: IEnsureTerminalSessionRequest): Promise<ITerminalSessionPayload>;
  dispatchScriptToTerminal(
    payload: IDispatchTerminalScriptRequest,
  ): Promise<IDispatchTerminalScriptPayload>;
  writeTerminalInput(payload: IWriteTerminalInputRequest): Promise<void>;
  resizeTerminalSession(payload: IResizeTerminalSessionRequest): Promise<void>;
  closeTerminalSession(payload: ICloseTerminalSessionRequest): Promise<void>;
  cancelTerminalRun(payload: ICancelTerminalRunRequest): Promise<void>;
  testSshConnection(payload: ISshConnectionTestRequest): Promise<ISshConnectionTestPayload>;
  listSshConfigHosts(): Promise<ISshConfigHostPayload[]>;
  listSshDirectory(payload: ISshDirectoryListRequest): Promise<ISshDirectoryListPayload>;
  downloadSshFile(payload: ISshFileDownloadRequest): Promise<ISshFileDownloadPayload>;
  uploadSshFile(payload: ISshFileUploadRequest): Promise<ISshFileUploadPayload>;
  deleteSshPath(payload: ISshPathDeleteRequest): Promise<ISshPathDeletePayload>;
  renameSshPath(payload: ISshPathRenameRequest): Promise<ISshPathRenamePayload>;
  createSshDirectory(payload: ISshDirectoryCreateRequest): Promise<ISshDirectoryCreatePayload>;
  aiGetConfig(): Promise<IAiConfigPayload>;
  aiSaveConfig(payload: IAiSaveConfigRequest): Promise<IAiConfigPayload>;
  aiSaveCredentials(payload: IAiSaveCredentialsRequest): Promise<IAiConfigPayload>;
  aiClearCredentials(): Promise<void>;
  aiListProviderProfiles(): Promise<IAiProviderProfilePayload[]>;
  aiGetProviderProfileDetail(
    payload: IAiProviderProfileSwitchRequest,
  ): Promise<IAiProviderProfileDetailPayload>;
  aiSwitchProviderProfile(
    payload: IAiProviderProfileSwitchRequest,
  ): Promise<IAiConfigPayload>;
  aiTestProvider(): Promise<IAiProviderTestPayload>;
  aiTestProviderConfig(payload: IAiProviderConnectionRequest): Promise<IAiProviderTestPayload>;
  aiConnectProvider(payload: IAiProviderConnectionRequest): Promise<IAiProviderConnectionPayload>;
  aiChat(payload: IAiChatRequest, options?: { signal?: AbortSignal }): Promise<IAiChatPayload>;
  aiGenerateConversationTitle(
    payload: IAiConversationTitleRequest,
  ): Promise<IAiConversationTitlePayload>;
  aiChatStream(payload: IAiChatRequest): Promise<IAiChatStreamPayload>;
  aiCancel(payload: { streamId: string }): Promise<void>;
  onAiChatStream(handler: (payload: IAiChatStreamEventPayload) => void): Promise<() => void>;
  onAiAgentStream(handler: (payload: TAiAgentStreamEvent) => void): Promise<() => void>;
  aiInlineComplete(payload: IAiInlineCompletionRequest): Promise<IAiInlineCompletionResult>;
  aiCodeAction(payload: IAiCodeActionRequest): Promise<IAiCodeActionResult>;
  aiAgentClassifyTask(payload: IAiAgentClassifyTaskRequest): Promise<IAiAgentClassifyTaskPayload>;
  aiPlanTask(payload: IAiAgentPlanRequest): Promise<IAiAgentPlanPayload>;
  aiAgentApprovePlan(payload: IAiAgentApprovePlanRequest): Promise<IAiAgentApprovePlanPayload>;
  aiAgentRunPlan(payload: IAiAgentRunPlanRequest): Promise<IAiAgentRunPayload>;
  aiAgentRunStep(payload: IAiAgentRunStepRequest): Promise<IAiAgentRunPayload>;
  aiAgentPause(payload: IAiAgentRunIdRequest): Promise<IAiAgentRunPayload>;
  aiAgentResume(payload: IAiAgentRunIdRequest): Promise<IAiAgentRunPayload>;
  aiAgentCancel(payload: IAiAgentRunIdRequest): Promise<IAiAgentRunPayload>;
  aiAgentGetRun(payload: IAiAgentRunIdRequest): Promise<IAiAgentRunPayload>;
  aiAgentListRuns(): Promise<IAiAgentListRunsPayload>;
  aiWebSearch(payload: IAiWebSearchInput): Promise<IAiWebSearchPayload>;
  aiWebFetch(payload: IAiWebFetchInput): Promise<IAiWebFetchPayload>;
  aiAgentSetNetworkPermission(
    payload: IAiAgentSetNetworkPermissionRequest,
  ): Promise<IAiAgentNetworkPermissionPayload>;
  aiAgentResolveToolConfirmation(
    payload: IAiAgentResolveToolConfirmationRequest,
  ): Promise<IAiAgentRunPayload>;
  aiBuildIndex(payload: IAiBuildIndexRequest): Promise<IAiBuildIndexPayload>;
  aiQueryIndex(payload: IAiQueryIndexRequest): Promise<IAiQueryIndexPayload>;
  aiProposePatch(payload: IAiProposePatchRequest): Promise<IAiProposePatchPayload>;
  aiApplyPatch(payload: IAiApplyPatchRequest): Promise<IAiApplyPatchPayload>;
  aiEditGetAuthLevel(): Promise<IAiEditAuthState>;
  aiEditSetAuthLevel(payload: IAiEditSetAuthLevelRequest): Promise<IAiEditAuthState>;
  aiEditListTimeline(payload: IAiEditListTimelineRequest): Promise<IAiEditListTimelinePayload>;
  aiEditCreateSnapshot(
    payload: IAiEditCreateSnapshotRequest,
  ): Promise<IAiEditCreateSnapshotPayload>;
  aiEditGetDiff(payload: IAiEditGetDiffRequest): Promise<IAiEditGetDiffPayload>;
  aiEditRestoreSnapshot(
    payload: IAiEditRestoreSnapshotRequest,
  ): Promise<IAiEditRestoreSnapshotPayload>;
  aiEditUndoOperation(
    payload: IAiEditUndoOperationRequest,
  ): Promise<IAiEditUndoOperationPayload>;
  aiEditRevertFile(payload: IAiEditRevertFileRequest): Promise<IAiEditRevertFilePayload>;
  aiEditRevertHunk(payload: IAiEditRevertHunkRequest): Promise<IAiEditRevertHunkPayload>;
  aiEditRevertTask(payload: IAiEditRevertTaskRequest): Promise<IAiEditRevertTaskPayload>;
  aiListTools(): Promise<IAiToolDefinitionPayload[]>;
}
