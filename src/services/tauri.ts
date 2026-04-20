import type {
  IAnalyzeScriptPayload,
  IAnalyzeScriptRequest,
  IExecutionEnvironment,
  IFormatScriptPayload,
  IFormatScriptRequest,
  IImageAssetPayload,
  IRunResult,
  IScriptFilePayload,
  IStartupWorkspacePayload,
  IWorkspaceDirectoryPayload,
} from '@/types/editor';
import type {
  IGitCommitRequest,
  IGitCommitResultPayload,
  IGitFileBaselinePayload,
  IGitPathOperationRequest,
  IGitRepositoryStatusPayload,
} from '@/types/git';
import type { ITauriService } from '@/types/tauri';
import type {
  ICloseTerminalSessionRequest,
  IDispatchTerminalScriptPayload,
  IDispatchTerminalScriptRequest,
  IEnsureTerminalSessionRequest,
  IResizeTerminalSessionRequest,
  ITerminalSessionPayload,
  IWriteTerminalInputRequest,
} from '@/types/terminal';
import { assertDesktopRuntime } from '@/utils/desktop-runtime';

type TauriCoreModule = typeof import('@tauri-apps/api/core');
type TauriDialogModule = typeof import('@tauri-apps/plugin-dialog');

const openFileFilters = [
  {
    name: 'Shell Script',
    extensions: ['sh', 'bash'],
  },
  {
    name: 'Images',
    extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'],
  },
];

const saveFileFilters = [
  {
    name: 'Shell Script',
    extensions: ['sh', 'bash'],
  },
];

// 动态 import 的单例缓存，避免每次调用都走一次 microtask
let tauriCorePromise: Promise<TauriCoreModule> | null = null;
let tauriDialogPromise: Promise<TauriDialogModule> | null = null;

const loadTauriCore = (): Promise<TauriCoreModule> => {
  if (!tauriCorePromise) {
    tauriCorePromise = import('@tauri-apps/api/core');
  }
  return tauriCorePromise;
};

const loadTauriDialog = (): Promise<TauriDialogModule> => {
  if (!tauriDialogPromise) {
    tauriDialogPromise = import('@tauri-apps/plugin-dialog');
  }
  return tauriDialogPromise;
};

// 统一错误包装：保留原 cause，同时把操作名带出，便于调试 / Sentry 定位
const wrapInvocationError = (guardHint: string, command: string, error: unknown): Error => {
  const baseMessage = error instanceof Error ? error.message : String(error);
  if (error instanceof Error) {
    return new Error(`[${guardHint}] ${command} 调用失败: ${baseMessage}`, {
      cause: error,
    });
  }

  return new Error(`[${guardHint}] ${command} 调用失败: ${baseMessage}`);
};

/**
 * 调用一个 Rust 端 `#[tauri::command]`。
 * - 执行运行时守卫（非桌面环境会抛错）。
 * - 复用动态 import 的核心模块。
 * - 统一把异常包装为带操作名的 Error。
 */
const runTauriCommand = async <T>(
  guardHint: string,
  command: string,
  args?: Record<string, unknown>,
): Promise<T> => {
  await assertDesktopRuntime(guardHint);
  const { invoke } = await loadTauriCore();
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw wrapInvocationError(guardHint, command, error);
  }
};

const runTauriVoidCommand = (
  guardHint: string,
  command: string,
  args?: Record<string, unknown>,
): Promise<void> => runTauriCommand<void>(guardHint, command, args);

/**
 * 统一处理 open/save 对话框：Tauri 在用户取消时返回 null，非字符串结果统一当作 null 处理。
 */
const normalizeDialogResult = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

export const tauriService: ITauriService & {
  pickOpenPath(): Promise<string | null>;
  pickOpenFolderPath(): Promise<string | null>;
  pickSavePath(defaultPath: string): Promise<string | null>;
} = {
  getStartupWorkspace() {
    return runTauriCommand<IStartupWorkspacePayload>('加载默认工作区', 'get_startup_workspace');
  },

  analyzeScript(payload: IAnalyzeScriptRequest) {
    return runTauriCommand<IAnalyzeScriptPayload>('执行 ShellCheck 实时诊断', 'analyze_script', {
      payload,
    });
  },

  formatScript(payload: IFormatScriptRequest) {
    return runTauriCommand<IFormatScriptPayload>('使用 shfmt 格式化脚本', 'format_script', {
      payload,
    });
  },

  async pickOpenPath() {
    await assertDesktopRuntime('打开本地脚本');
    const { open } = await loadTauriDialog();
    const result = await open({
      multiple: false,
      directory: false,
      filters: openFileFilters,
    });
    return normalizeDialogResult(result);
  },

  async pickOpenFolderPath() {
    await assertDesktopRuntime('打开本地文件夹');
    const { open } = await loadTauriDialog();
    const result = await open({
      multiple: false,
      directory: true,
    });
    return normalizeDialogResult(result);
  },

  async pickSavePath(defaultPath) {
    await assertDesktopRuntime('保存脚本');
    const { save } = await loadTauriDialog();
    const result = await save({
      defaultPath,
      filters: saveFileFilters,
    });
    return normalizeDialogResult(result);
  },

  // 下面这一组命令 Rust 端直接接收扁平参数，不是 { payload } 包装
  loadScript(path) {
    return runTauriCommand<IScriptFilePayload>('读取脚本文件', 'load_script', { path });
  },

  loadImageAsset(path) {
    return runTauriCommand<IImageAssetPayload>('读取图片资源', 'load_image_asset', { path });
  },

  saveScript(payload) {
    return runTauriCommand<IScriptFilePayload>('写入脚本文件', 'save_script', { payload });
  },

  detectEnvironment() {
    return runTauriCommand<IExecutionEnvironment>('检测执行环境', 'detect_execution_environment');
  },

  runScript(payload) {
    return runTauriCommand<IRunResult>('运行脚本', 'run_script', { payload });
  },

  listWorkspaceEntries(path, rootPath) {
    return runTauriCommand<IWorkspaceDirectoryPayload>('读取工作区目录', 'list_workspace_entries', {
      path,
      rootPath,
    });
  },

  getGitRepositoryStatus(workspaceRootPath) {
    return runTauriCommand<IGitRepositoryStatusPayload>(
      '读取 Git 仓库状态',
      'get_git_repository_status',
      {
        workspaceRootPath,
      },
    );
  },

  getGitFileBaseline(path) {
    return runTauriCommand<IGitFileBaselinePayload>('读取 Git 文件基线', 'get_git_file_baseline', {
      path,
    });
  },

  stageGitPaths(payload: IGitPathOperationRequest) {
    return runTauriCommand<IGitRepositoryStatusPayload>('暂存 Git 变更', 'stage_git_paths', {
      payload,
    });
  },

  unstageGitPaths(payload: IGitPathOperationRequest) {
    return runTauriCommand<IGitRepositoryStatusPayload>('取消暂存 Git 变更', 'unstage_git_paths', {
      payload,
    });
  },

  commitGitIndex(payload: IGitCommitRequest) {
    return runTauriCommand<IGitCommitResultPayload>('创建 Git 提交', 'commit_git_index', {
      payload,
    });
  },

  ensureTerminalSession(payload: IEnsureTerminalSessionRequest) {
    return runTauriCommand<ITerminalSessionPayload>(
      '连接 WSL2 终端',
      'ensure_terminal_session',
      { payload },
    );
  },

  dispatchScriptToTerminal(payload: IDispatchTerminalScriptRequest) {
    return runTauriCommand<IDispatchTerminalScriptPayload>(
      '在终端中执行脚本',
      'dispatch_script_to_terminal',
      { payload },
    );
  },

  writeTerminalInput(payload: IWriteTerminalInputRequest) {
    return runTauriVoidCommand('写入终端输入', 'write_terminal_input', { payload });
  },

  resizeTerminalSession(payload: IResizeTerminalSessionRequest) {
    return runTauriVoidCommand('同步终端尺寸', 'resize_terminal_session', { payload });
  },

  closeTerminalSession(payload: ICloseTerminalSessionRequest) {
    return runTauriVoidCommand('关闭终端会话', 'close_terminal_session', { payload });
  },
};
