import type {
  IAiAgentClassifyTaskPayload,
  IAiAgentClassifyTaskRequest,
  IAiAgentNetworkPermissionPayload,
  IAiAgentSetNetworkPermissionRequest,
  IAiApplyPatchPayload,
  IAiApplyPatchRequest,
  IAiCancelRequest,
  IAiChatRequest,
  IAiChatStreamPayload,
  IAiConfigPayload,
  IAiConversationTitlePayload,
  IAiConversationTitleRequest,
  IAiInlineCompletionRequest,
  IAiInlineCompletionResult,
  IAiProposePatchPayload,
  IAiProposePatchRequest,
  IAiProviderConnectionPayload,
  IAiProviderConnectionRequest,
  IAiProviderTestPayload,
  IAiSaveConfigRequest,
  IAiSaveCredentialsRequest,
  IAiSuggestionPoolPayload,
  IAiSuggestionPoolRequest,
  IAiWebFetchInput,
  IAiWebFetchPayload,
  IAiWebSearchInput,
  IAiWebSearchPayload,
} from '../ai';
import type { IAcpPermissionRequestPayload } from '../ai/acp-permission.schema';
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
  IAiEditSetPinPayload,
  IAiEditSetPinRequest,
  IAiEditUndoOperationPayload,
  IAiEditUndoOperationRequest,
} from '../ai/edit';
import type {
  IAgentSidecarApprovalResolveRequest,
  IAgentSidecarChatRequest,
  IAgentSidecarCheckpointRestoreRequest,
  IAgentSidecarHealthPayload,
  IAgentSidecarOrchestratePayload,
  IAgentSidecarOrchestrateRequest,
  IAgentSidecarOrchestrateResumeRequest,
  IAgentSidecarResponsePayload,
  IAgentSidecarStreamEventPayload,
  IAgentSidecarWarmupPayload,
} from '../ai/sidecar';
import type {
  IAnalyzeScriptPayload,
  IAnalyzeScriptRequest,
  IExecutionEnvironment,
  IFormatDocumentPayload,
  IFormatDocumentRequest,
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
} from '../editor';
import type {
  IGitBranchCheckoutRequest,
  IGitBranchCreateRequest,
  IGitBranchListPayload,
  IGitCommitCheckoutRequest,
  IGitCommitDetailPayload,
  IGitCommitDetailRequest,
  IGitCommitFileDiffPayload,
  IGitCommitFileDiffRequest,
  IGitCommitHistoryPayload,
  IGitCommitHistoryRequest,
  IGitCommitRequest,
  IGitCommitResultPayload,
  IGitCommitRevertRequest,
  IGitDiffPreviewPayload,
  IGitDiffPreviewRequest,
  IGitFileBaselinePayload,
  IGitPathOperationRequest,
  IGitPullRequestSupportPayload,
  IGitRemoteSetRequest,
  IGitRepositoryRootRequest,
  IGitRepositoryStatusPayload,
  IGitStashApplyRequest,
  IGitStashDropRequest,
  IGitStashListPayload,
  IGitStashSaveRequest,
} from '../git';
import type {
  IWorkspaceReplacementApplyPayload,
  IWorkspaceReplacementApplyRequest,
  IWorkspaceReplacementPreviewPayload,
  IWorkspaceReplacementRequest,
  IWorkspaceSearchPayload,
  IWorkspaceSearchRequest,
  IWorkspaceSearchStreamEvent,
} from '../search';
import type {
  ICancelTerminalRunRequest,
  ICloseTerminalSessionRequest,
  IDispatchTerminalScriptPayload,
  IDispatchTerminalScriptRequest,
  IEnsureTerminalSessionRequest,
  IResizeTerminalSessionRequest,
  ITerminalSessionPayload,
  IWriteTerminalInputRequest,
} from '../terminal';

export interface ISshConnectionTestRequest {
  host: string;
  port: number;
  username: string;
  authMode: 'key' | 'password';
  identityPath: string | null;
  password: string | null;
}

export interface ITauriCallOptions {
  signal?: AbortSignal;
}

type TWorkspaceScopedSaveScriptRequest = ISaveScriptRequest & {
  workspaceRootPath?: string | null;
};

export interface ISshConnectionTestPayload {
  ok: boolean;
  code: string;
  message: string;
}

export interface ISshPasswordSaveRequest {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface ISshPasswordGetRequest {
  host: string;
  port: number;
  username: string;
}

export interface ISshPasswordStatusPayload {
  hasPassword: boolean;
}

export interface ISshPasswordPayload {
  password: string;
}

export interface ISshDirectoryListRequest extends ISshConnectionTestRequest {
  path: string;
}

export interface ISshDirectoryEntryPayload {
  name: string;
  path: string;
  kind: string;
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

export interface ISshFileReadRequest extends ISshConnectionTestRequest {
  remotePath: string;
}

export interface ISshFileReadPayload {
  remotePath: string;
  content: string;
  byteSize: number;
  encoding: string;
  lineCount: number;
  lineEnding: string;
  permission: string;
  owner: string;
  modifiedAt: string | null;
}

export interface ISshFileWriteRequest extends ISshConnectionTestRequest {
  remotePath: string;
  content: string;
  encoding: 'utf-8' | 'utf-8-bom';
  lineEnding: 'lf' | 'crlf' | 'cr' | 'mixed' | 'none';
}

export interface ISshFileWritePayload {
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
  agentSidecarRestart(): Promise<IAgentSidecarHealthPayload>;
  agentSidecarWarmup(): Promise<IAgentSidecarWarmupPayload>;
  agentSidecarChat(payload: IAgentSidecarChatRequest): Promise<IAgentSidecarResponsePayload>;
  agentSidecarResolveApproval(
    payload: IAgentSidecarApprovalResolveRequest,
  ): Promise<IAgentSidecarResponsePayload>;
  agentSidecarRestoreCheckpoint(
    payload: IAgentSidecarCheckpointRestoreRequest,
  ): Promise<IAgentSidecarResponsePayload>;
  agentSidecarOrchestrate(
    payload: IAgentSidecarOrchestrateRequest,
  ): Promise<IAgentSidecarOrchestratePayload>;
  agentSidecarOrchestrateResume(
    payload: IAgentSidecarOrchestrateResumeRequest,
  ): Promise<IAgentSidecarOrchestratePayload>;
  onAgentSidecarStream(
    handler: (payload: IAgentSidecarStreamEventPayload) => void,
  ): Promise<() => void>;
  onAcpApproval(
    handler: (payload: IAcpPermissionRequestPayload) => void,
  ): Promise<() => void>;
  analyzeScript(payload: IAnalyzeScriptRequest): Promise<IAnalyzeScriptPayload>;
  formatScript(payload: IFormatScriptRequest): Promise<IFormatScriptPayload>;
  formatDocument(payload: IFormatDocumentRequest): Promise<IFormatDocumentPayload>;
  loadScript(path: string, workspaceRootPath?: string | null): Promise<IScriptFilePayload>;
  loadImageAsset(path: string): Promise<IImageAssetPayload>;
  saveScript(payload: TWorkspaceScopedSaveScriptRequest): Promise<IScriptFilePayload>;
  detectEnvironment(): Promise<IExecutionEnvironment>;
  listWorkspaceEntries(path?: string, rootPath?: string): Promise<IWorkspaceDirectoryPayload>;
  createWorkspacePath(payload: IWorkspacePathCreateRequest): Promise<IWorkspacePathCreatePayload>;
  renameWorkspacePath(payload: IWorkspacePathRenameRequest): Promise<IWorkspacePathRenamePayload>;
  deleteWorkspacePath(payload: IWorkspacePathDeleteRequest): Promise<IWorkspacePathDeletePayload>;
  startWorkspaceWatching(rootPath: string): Promise<void>;
  stopWorkspaceWatching(): Promise<void>;
  searchWorkspace(
    payload: IWorkspaceSearchRequest,
    options?: ITauriCallOptions,
  ): Promise<IWorkspaceSearchPayload>;
  onWorkspaceSearchStream(
    handler: (payload: IWorkspaceSearchStreamEvent) => void,
  ): Promise<() => void>;
  previewWorkspaceReplacement(
    payload: IWorkspaceReplacementRequest,
    options?: ITauriCallOptions,
  ): Promise<IWorkspaceReplacementPreviewPayload>;
  applyWorkspaceReplacement(
    payload: IWorkspaceReplacementApplyRequest,
  ): Promise<IWorkspaceReplacementApplyPayload>;
  getGitRepositoryStatus(workspaceRootPath?: string | null): Promise<IGitRepositoryStatusPayload>;
  initGitRepository(workspaceRootPath?: string | null): Promise<IGitRepositoryStatusPayload>;
  listGitCommitHistory(payload: IGitCommitHistoryRequest): Promise<IGitCommitHistoryPayload>;
  getGitCommitDetail(payload: IGitCommitDetailRequest): Promise<IGitCommitDetailPayload>;
  getGitCommitFileDiff(payload: IGitCommitFileDiffRequest): Promise<IGitCommitFileDiffPayload>;
  getGitCommitFileDiffPreview(payload: IGitCommitFileDiffRequest): Promise<IGitDiffPreviewPayload>;
  listGitBranches(payload: IGitRepositoryRootRequest): Promise<IGitBranchListPayload>;
  checkoutGitBranch(payload: IGitBranchCheckoutRequest): Promise<IGitRepositoryStatusPayload>;
  checkoutGitCommit(payload: IGitCommitCheckoutRequest): Promise<IGitRepositoryStatusPayload>;
  createGitBranch(payload: IGitBranchCreateRequest): Promise<IGitRepositoryStatusPayload>;
  revertGitCommit(payload: IGitCommitRevertRequest): Promise<IGitRepositoryStatusPayload>;
  setGitRemote(payload: IGitRemoteSetRequest): Promise<IGitPullRequestSupportPayload>;
  getGitFileBaseline(path: string): Promise<IGitFileBaselinePayload>;
  getGitDiffPreview(payload: IGitDiffPreviewRequest): Promise<IGitDiffPreviewPayload>;
  stageGitPaths(payload: IGitPathOperationRequest): Promise<IGitRepositoryStatusPayload>;
  unstageGitPaths(payload: IGitPathOperationRequest): Promise<IGitRepositoryStatusPayload>;
  discardGitPaths(payload: IGitPathOperationRequest): Promise<IGitRepositoryStatusPayload>;
  commitGitIndex(payload: IGitCommitRequest): Promise<IGitCommitResultPayload>;
  listGitStashes(payload: IGitRepositoryRootRequest): Promise<IGitStashListPayload>;
  saveGitStash(payload: IGitStashSaveRequest): Promise<IGitRepositoryStatusPayload>;
  applyGitStash(payload: IGitStashApplyRequest): Promise<IGitRepositoryStatusPayload>;
  dropGitStash(payload: IGitStashDropRequest): Promise<IGitRepositoryStatusPayload>;
  getGitPullRequestSupport(
    payload: IGitRepositoryRootRequest,
  ): Promise<IGitPullRequestSupportPayload>;
  ensureTerminalSession(payload: IEnsureTerminalSessionRequest): Promise<ITerminalSessionPayload>;
  dispatchScriptToTerminal(
    payload: IDispatchTerminalScriptRequest,
  ): Promise<IDispatchTerminalScriptPayload>;
  writeTerminalInput(payload: IWriteTerminalInputRequest): Promise<void>;
  resizeTerminalSession(payload: IResizeTerminalSessionRequest): Promise<void>;
  closeTerminalSession(payload: ICloseTerminalSessionRequest): Promise<void>;
  cancelTerminalRun(payload: ICancelTerminalRunRequest): Promise<void>;
  testSshConnection(payload: ISshConnectionTestRequest): Promise<ISshConnectionTestPayload>;
  saveSshPassword(payload: ISshPasswordSaveRequest): Promise<ISshPasswordStatusPayload>;
  getSshPassword(payload: ISshPasswordGetRequest): Promise<ISshPasswordPayload>;
  listSshConfigHosts(): Promise<ISshConfigHostPayload[]>;
  listSshDirectory(payload: ISshDirectoryListRequest): Promise<ISshDirectoryListPayload>;
  downloadSshFile(payload: ISshFileDownloadRequest): Promise<ISshFileDownloadPayload>;
  uploadSshFile(payload: ISshFileUploadRequest): Promise<ISshFileUploadPayload>;
  readSshFile(payload: ISshFileReadRequest): Promise<ISshFileReadPayload>;
  writeSshFile(payload: ISshFileWriteRequest): Promise<ISshFileWritePayload>;
  deleteSshPath(payload: ISshPathDeleteRequest): Promise<ISshPathDeletePayload>;
  renameSshPath(payload: ISshPathRenameRequest): Promise<ISshPathRenamePayload>;
  createSshDirectory(payload: ISshDirectoryCreateRequest): Promise<ISshDirectoryCreatePayload>;
  aiGetConfig(): Promise<IAiConfigPayload>;
  aiSaveConfig(payload: IAiSaveConfigRequest): Promise<IAiConfigPayload>;
  aiSaveCredentials(payload: IAiSaveCredentialsRequest): Promise<IAiConfigPayload>;
  aiClearCredentials(): Promise<void>;
  aiTestProvider(): Promise<IAiProviderTestPayload>;
  aiTestProviderConfig(payload: IAiProviderConnectionRequest): Promise<IAiProviderTestPayload>;
  aiConnectProvider(payload: IAiProviderConnectionRequest): Promise<IAiProviderConnectionPayload>;
  aiGenerateConversationTitle(
    payload: IAiConversationTitleRequest,
  ): Promise<IAiConversationTitlePayload>;
  aiGetSuggestionPoolCache(): Promise<IAiSuggestionPoolPayload | null>;
  aiGenerateSuggestionPool(payload: IAiSuggestionPoolRequest): Promise<IAiSuggestionPoolPayload>;
  aiChatStream(payload: IAiChatRequest): Promise<IAiChatStreamPayload>;
  aiCancel(payload: IAiCancelRequest): Promise<void>;
  aiInlineComplete(payload: IAiInlineCompletionRequest): Promise<IAiInlineCompletionResult>;
  aiAgentClassifyTask(payload: IAiAgentClassifyTaskRequest): Promise<IAiAgentClassifyTaskPayload>;
  aiWebSearch(payload: IAiWebSearchInput): Promise<IAiWebSearchPayload>;
  aiWebFetch(payload: IAiWebFetchInput): Promise<IAiWebFetchPayload>;
  aiAgentSetNetworkPermission(
    payload: IAiAgentSetNetworkPermissionRequest,
  ): Promise<IAiAgentNetworkPermissionPayload>;
  aiProposePatch(payload: IAiProposePatchRequest): Promise<IAiProposePatchPayload>;
  aiApplyPatch(payload: IAiApplyPatchRequest): Promise<IAiApplyPatchPayload>;
  aiEditGetAuthLevel(): Promise<IAiEditAuthState>;
  aiEditSetAuthLevel(payload: IAiEditSetAuthLevelRequest): Promise<IAiEditAuthState>;
  aiEditListTimeline(payload: IAiEditListTimelineRequest): Promise<IAiEditListTimelinePayload>;
  aiEditCreateSnapshot(
    payload: IAiEditCreateSnapshotRequest,
  ): Promise<IAiEditCreateSnapshotPayload>;
  aiEditSetPin(payload: IAiEditSetPinRequest): Promise<IAiEditSetPinPayload>;
  aiEditGetDiff(payload: IAiEditGetDiffRequest): Promise<IAiEditGetDiffPayload>;
  aiEditRestoreSnapshot(
    payload: IAiEditRestoreSnapshotRequest,
  ): Promise<IAiEditRestoreSnapshotPayload>;
  aiEditUndoOperation(payload: IAiEditUndoOperationRequest): Promise<IAiEditUndoOperationPayload>;
  aiEditRevertFile(payload: IAiEditRevertFileRequest): Promise<IAiEditRevertFilePayload>;
  aiEditRevertHunk(payload: IAiEditRevertHunkRequest): Promise<IAiEditRevertHunkPayload>;
  aiEditRevertTask(payload: IAiEditRevertTaskRequest): Promise<IAiEditRevertTaskPayload>;
}
