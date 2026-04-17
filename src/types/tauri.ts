import type {
  IExecutionEnvironment,
  IRunResult,
  IRunScriptRequest,
  ISaveScriptRequest,
  IScriptFilePayload,
  IWorkspaceDirectoryPayload,
} from './editor';
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
  loadScript(path: string): Promise<IScriptFilePayload>;
  saveScript(payload: ISaveScriptRequest): Promise<IScriptFilePayload>;
  detectEnvironment(): Promise<IExecutionEnvironment>;
  runScript(payload: IRunScriptRequest): Promise<IRunResult>;
  listWorkspaceEntries(path?: string, rootPath?: string): Promise<IWorkspaceDirectoryPayload>;
  ensureTerminalSession(payload: IEnsureTerminalSessionRequest): Promise<ITerminalSessionPayload>;
  dispatchScriptToTerminal(
    payload: IDispatchTerminalScriptRequest,
  ): Promise<IDispatchTerminalScriptPayload>;
  writeTerminalInput(payload: IWriteTerminalInputRequest): Promise<void>;
  resizeTerminalSession(payload: IResizeTerminalSessionRequest): Promise<void>;
  closeTerminalSession(payload: ICloseTerminalSessionRequest): Promise<void>;
}
