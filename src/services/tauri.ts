import type {
  IExecutionEnvironment,
  IRunResult,
  IScriptFilePayload,
  IWorkspaceDirectoryPayload,
} from '@/types/editor';
import type {
  ICloseTerminalSessionRequest,
  IDispatchTerminalScriptPayload,
  IDispatchTerminalScriptRequest,
  IEnsureTerminalSessionRequest,
  IResizeTerminalSessionRequest,
  ITerminalSessionPayload,
  IWriteTerminalInputRequest,
} from '@/types/terminal';
import type { ITauriService } from '@/types/tauri';
import { assertDesktopRuntime } from '@/utils/desktop-runtime';

const fileFilters = [
  {
    name: 'Shell Script',
    extensions: ['sh', 'bash'],
  },
];

export const tauriService: ITauriService & {
  pickOpenPath(): Promise<string | null>;
  pickOpenFolderPath(): Promise<string | null>;
  pickSavePath(defaultPath: string): Promise<string | null>;
} = {
  async pickOpenPath() {
    await assertDesktopRuntime('打开本地脚本');
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({
      multiple: false,
      directory: false,
      filters: fileFilters,
    });

    return typeof path === 'string' ? path : null;
  },
  async pickOpenFolderPath() {
    await assertDesktopRuntime('打开本地文件夹');
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({
      multiple: false,
      directory: true,
    });

    return typeof path === 'string' ? path : null;
  },
  async pickSavePath(defaultPath) {
    await assertDesktopRuntime('保存脚本');
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({
      defaultPath,
      filters: fileFilters,
    });

    return typeof path === 'string' ? path : null;
  },
  async loadScript(path) {
    await assertDesktopRuntime('读取脚本文件');
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<IScriptFilePayload>('load_script', { path });
  },
  async saveScript(payload) {
    await assertDesktopRuntime('写入脚本文件');
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<IScriptFilePayload>('save_script', { payload });
  },
  async detectEnvironment() {
    await assertDesktopRuntime('检测执行环境');
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<IExecutionEnvironment>('detect_execution_environment');
  },
  async runScript(payload) {
    await assertDesktopRuntime('运行脚本');
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<IRunResult>('run_script', { payload });
  },
  async listWorkspaceEntries(path, rootPath) {
    await assertDesktopRuntime('读取工作区目录');
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<IWorkspaceDirectoryPayload>('list_workspace_entries', { path, rootPath });
  },
  async ensureTerminalSession(payload: IEnsureTerminalSessionRequest) {
    await assertDesktopRuntime('连接 WSL2 终端');
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<ITerminalSessionPayload>('ensure_terminal_session', { payload });
  },
  async dispatchScriptToTerminal(payload: IDispatchTerminalScriptRequest) {
    await assertDesktopRuntime('在终端中执行脚本');
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<IDispatchTerminalScriptPayload>('dispatch_script_to_terminal', { payload });
  },
  async writeTerminalInput(payload: IWriteTerminalInputRequest) {
    await assertDesktopRuntime('写入终端输入');
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('write_terminal_input', { payload });
  },
  async resizeTerminalSession(payload: IResizeTerminalSessionRequest) {
    await assertDesktopRuntime('同步终端尺寸');
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('resize_terminal_session', { payload });
  },
  async closeTerminalSession(payload: ICloseTerminalSessionRequest) {
    await assertDesktopRuntime('关闭终端会话');
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('close_terminal_session', { payload });
  },
};
