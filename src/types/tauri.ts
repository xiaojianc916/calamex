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
  IGitFileBaselinePayload,
  IGitPathOperationRequest,
  IGitRepositoryStatusPayload,
} from './git';
import type {
  ICloseTerminalSessionRequest,
  ICancelTerminalRunRequest,
  IDispatchTerminalScriptPayload,
  IDispatchTerminalScriptRequest,
  IEnsureTerminalSessionRequest,
  IResizeTerminalSessionRequest,
  ITerminalSessionPayload,
  IWriteTerminalInputRequest,
} from './terminal';
import type { IWorkspaceSearchPayload, IWorkspaceSearchRequest } from './search';
import type {
  IAiChatPayload,
  IAiChatRequest,
  IAiChatStreamEventPayload,
  IAiChatStreamPayload,
  IAiAgentPlanPayload,
  IAiAgentPlanRequest,
  IAiApplyPatchPayload,
  IAiApplyPatchRequest,
  IAiBuildIndexPayload,
  IAiBuildIndexRequest,
  IAiCodeActionRequest,
  IAiCodeActionResult,
  IAiConfigPayload,
  IAiInlineCompletionRequest,
  IAiInlineCompletionResult,
  IAiProviderTestPayload,
  IAiProposePatchPayload,
  IAiProposePatchRequest,
  IAiQueryIndexPayload,
  IAiQueryIndexRequest,
  IAiSaveCredentialsRequest,
  IAiSaveConfigRequest,
} from './ai';

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
  aiTestProvider(): Promise<IAiProviderTestPayload>;
  aiChat(payload: IAiChatRequest, options?: { signal?: AbortSignal }): Promise<IAiChatPayload>;
  aiChatStream(payload: IAiChatRequest): Promise<IAiChatStreamPayload>;
  aiCancel(payload: { streamId: string }): Promise<void>;
  onAiChatStream(handler: (payload: IAiChatStreamEventPayload) => void): Promise<() => void>;
  aiInlineComplete(payload: IAiInlineCompletionRequest): Promise<IAiInlineCompletionResult>;
  aiCodeAction(payload: IAiCodeActionRequest): Promise<IAiCodeActionResult>;
  aiPlanTask(payload: IAiAgentPlanRequest): Promise<IAiAgentPlanPayload>;
  aiBuildIndex(payload: IAiBuildIndexRequest): Promise<IAiBuildIndexPayload>;
  aiQueryIndex(payload: IAiQueryIndexRequest): Promise<IAiQueryIndexPayload>;
  aiProposePatch(payload: IAiProposePatchRequest): Promise<IAiProposePatchPayload>;
  aiApplyPatch(payload: IAiApplyPatchRequest): Promise<IAiApplyPatchPayload>;
}
