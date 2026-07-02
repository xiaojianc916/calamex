import type {
  AiAgentClassifyTaskPayload,
  AiAgentNetworkPermissionPayload,
  AiApplyPatchRequest,
  AiChatStreamPayload,
  AiConfigPayload,
  AiInlineCompletionResult,
  AiProviderConnectionPayload,
  AiSetSeededModelsRequest,
  AiWebSearchInput,
  AiWebSearchPayload,
} from '@/bindings/tauri';
import type {
  IAiAgentClassifyTaskRequest,
  IAiAgentSetNetworkPermissionRequest,
  IAiApplyPatchPayload,
  IAiCancelRequest,
  IAiChatRequest,
  IAiConversationTitlePayload,
  IAiConversationTitleRequest,
  IAiEnsureAcpSessionRequest,
  IAiInlineCompletionRequest,
  IAiProposePatchPayload,
  IAiProposePatchRequest,
  IAiProviderConnectionRequest,
  IAiProviderTestPayload,
  IAiResolveApprovalRequest,
  IAiSaveConfigRequest,
  IAiSaveCredentialsRequest,
  IAiSessionConfigOptionsPayload,
  IAiSetSessionConfigOptionRequest,
  IAiSuggestionPoolPayload,
  IAiSuggestionPoolRequest,
  IAiWebFetchInput,
  IAiWebFetchPayload,
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
  IAgentExternalChatRequest,
  IAgentExternalChatResultPayload,
  IAgentSidecarCheckpointRestoreRequest,
  IAgentSidecarHealthPayload,
  IAgentSidecarResponsePayload,
  IAgentSidecarStreamEventPayload,
  IAgentSidecarWarmupPayload,
} from '../ai/sidecar';
import type {
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
  IHeartbeatTerminalSessionRequest,
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
  agentSidecarExternalChat(
    payload: IAgentExternalChatRequest,
  ): Promise<IAgentExternalChatResultPayload>;
  agentSidecarRestoreCheckpoint(
    payload: IAgentSidecarCheckpointRestoreRequest,
  ): Promise<IAgentSidecarResponsePayload>;
  onAgentSidecarStream(
    handler: (payload: IAgentSidecarStreamEventPayload) => void,
  ): Promise<() => void>;
  onAcpApproval(handler: (payload: IAcpPermissionRequestPayload) => void): Promise<() => void>;
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
  heartbeatTerminalSession(payload: IHeartbeatTerminalSessionRequest): Promise<void>;
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
  aiGetConfig(): Promise<AiConfigPayload>;
  aiSaveConfig(payload: IAiSaveConfigRequest): Promise<AiConfigPayload>;
  aiSetSeededModels(payload: AiSetSeededModelsRequest): Promise<AiConfigPayload>;
  aiSaveCredentials(payload: IAiSaveCredentialsRequest): Promise<AiConfigPayload>;
  aiClearCredentials(): Promise<void>;
  getTavilyApiKey(): Promise<string>;
  setTavilyApiKey(payload: { apiKey: string }): Promise<void>;
  aiTestProvider(): Promise<IAiProviderTestPayload>;
  aiTestProviderConfig(payload: IAiProviderConnectionRequest): Promise<IAiProviderTestPayload>;
  aiConnectProvider(payload: IAiProviderConnectionRequest): Promise<AiProviderConnectionPayload>;
  aiGenerateConversationTitle(
    payload: IAiConversationTitleRequest,
  ): Promise<IAiConversationTitlePayload>;
  aiGetSuggestionPoolCache(): Promise<IAiSuggestionPoolPayload | null>;
  aiGenerateSuggestionPool(payload: IAiSuggestionPoolRequest): Promise<IAiSuggestionPoolPayload>;
  aiChatStream(payload: IAiChatRequest): Promise<AiChatStreamPayload>;
  aiCancel(payload: IAiCancelRequest): Promise<void>;
  aiEvictThread(threadId: string): Promise<void>;
  aiResolveApproval(payload: IAiResolveApprovalRequest): Promise<boolean>;
  aiEnsureAcpSession(
    payload: IAiEnsureAcpSessionRequest,
  ): Promise<IAiSessionConfigOptionsPayload | null>;
  aiSetSessionConfigOption(
    payload: IAiSetSessionConfigOptionRequest,
  ): Promise<IAiSessionConfigOptionsPayload | null>;
  aiInlineComplete(payload: IAiInlineCompletionRequest): Promise<AiInlineCompletionResult>;
  aiAgentClassifyTask(payload: IAiAgentClassifyTaskRequest): Promise<AiAgentClassifyTaskPayload>;
  aiWebSearch(payload: AiWebSearchInput): Promise<AiWebSearchPayload>;
  aiWebFetch(payload: IAiWebFetchInput): Promise<IAiWebFetchPayload>;
  aiAgentSetNetworkPermission(
    payload: IAiAgentSetNetworkPermissionRequest,
  ): Promise<AiAgentNetworkPermissionPayload>;
  aiProposePatch(payload: IAiProposePatchRequest): Promise<IAiProposePatchPayload>;
  aiApplyPatch(payload: AiApplyPatchRequest): Promise<IAiApplyPatchPayload>;
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
