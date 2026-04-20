import type {
  IAnalyzeScriptPayload,
  IAnalyzeScriptRequest,
  IExecutionEnvironment,
  IFormatScriptPayload,
  IFormatScriptRequest,
  IImageAssetPayload,
  IRunResult,
  IRunScriptRequest,
  ISaveScriptRequest,
  IScriptFilePayload,
  IStartupWorkspacePayload,
  IWorkspaceDirectoryPayload,
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
  IDispatchTerminalScriptPayload,
  IDispatchTerminalScriptRequest,
  IEnsureTerminalSessionRequest,
  IResizeTerminalSessionRequest,
  ITerminalSessionPayload,
  IWriteTerminalInputRequest,
} from './terminal';

export interface ITauriService {
  getStartupWorkspace(): Promise<IStartupWorkspacePayload>;
  analyzeScript(payload: IAnalyzeScriptRequest): Promise<IAnalyzeScriptPayload>;
  formatScript(payload: IFormatScriptRequest): Promise<IFormatScriptPayload>;
  loadScript(path: string): Promise<IScriptFilePayload>;
  loadImageAsset(path: string): Promise<IImageAssetPayload>;
  saveScript(payload: ISaveScriptRequest): Promise<IScriptFilePayload>;
  detectEnvironment(): Promise<IExecutionEnvironment>;
  runScript(payload: IRunScriptRequest): Promise<IRunResult>;
  listWorkspaceEntries(path?: string, rootPath?: string): Promise<IWorkspaceDirectoryPayload>;
  getGitRepositoryStatus(workspaceRootPath?: string | null): Promise<IGitRepositoryStatusPayload>;
  getGitFileBaseline(path: string): Promise<IGitFileBaselinePayload>;
  stageGitPaths(payload: IGitPathOperationRequest): Promise<IGitRepositoryStatusPayload>;
  unstageGitPaths(payload: IGitPathOperationRequest): Promise<IGitRepositoryStatusPayload>;
  commitGitIndex(payload: IGitCommitRequest): Promise<IGitCommitResultPayload>;
  ensureTerminalSession(payload: IEnsureTerminalSessionRequest): Promise<ITerminalSessionPayload>;
  dispatchScriptToTerminal(
    payload: IDispatchTerminalScriptRequest,
  ): Promise<IDispatchTerminalScriptPayload>;
  writeTerminalInput(payload: IWriteTerminalInputRequest): Promise<void>;
  resizeTerminalSession(payload: IResizeTerminalSessionRequest): Promise<void>;
  closeTerminalSession(payload: ICloseTerminalSessionRequest): Promise<void>;
}
