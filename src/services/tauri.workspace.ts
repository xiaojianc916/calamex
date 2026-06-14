import { commands } from '@/bindings/tauri';
import type { IWorkspaceSearchStreamEvent } from '@/types/search';
import type { ITauriService } from '@/types/tauri';
import { assertDesktopRuntime } from '@/utils/desktop-runtime';
import { runCommand, type ICommandMeta } from './tauri.ipc-define';
import { measureScriptContentInput } from './tauri.ipc-metrics';
import { loadTauriEvent, pickDialogPath } from './tauri.ipc-runtime';
import type { IIpcCallOptions } from './tauri.ipc-types';

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

type TWorkspaceTauriService = Pick<
  ITauriService,
  | 'analyzeScript'
  | 'formatScript'
  | 'formatDocument'
  | 'loadScript'
  | 'loadImageAsset'
  | 'saveScript'
  | 'detectEnvironment'
  | 'listWorkspaceEntries'
  | 'createWorkspacePath'
  | 'renameWorkspacePath'
  | 'deleteWorkspacePath'
  | 'startWorkspaceWatching'
  | 'stopWorkspaceWatching'
  | 'searchWorkspace'
  | 'onWorkspaceSearchStream'
  | 'previewWorkspaceReplacement'
  | 'applyWorkspaceReplacement'
> & {
  pickOpenPath(): Promise<string | null>;
  pickAnyOpenPath(): Promise<string | null>;
  pickOpenFolderPath(): Promise<string | null>;
  pickSavePath(defaultPath: string): Promise<string | null>;
  pickAnySavePath(defaultPath: string): Promise<string | null>;
};

const WORKSPACE_COMMAND_META = {
  analyzeScript: {
    command: 'analyze_script',
    guardHint: '执行 ShellCheck 实时诊断',
    idempotent: true,
  },
  formatScript: {
    command: 'format_script',
    guardHint: '使用 shfmt 格式化脚本',
    // 后端 shfmt 守卫超时为 12s (SHFMT_TIMEOUT)，前端预算需高于它，
    // 否则会在后端完成前就以「IPC 超时」取消，给出误导性的失败。
    timeoutMs: 15_000,
    measureInput: measureScriptContentInput,
  },
  formatDocument: {
    command: 'format_document',
    guardHint: '调用多语言 formatter 格式化文档',
    // 后端 External formatter 守卫超时 12s (FORMAT_TIMEOUT)，前端预算需高于它。
    timeoutMs: 15_000,
    measureInput: measureScriptContentInput,
  },
  loadScript: {
    command: 'load_script',
    guardHint: '读取脚本文件',
    idempotent: true,
  },
  loadImageAsset: {
    command: 'load_image_asset',
    guardHint: '读取图片资源',
    idempotent: true,
  },
  saveScript: {
    command: 'save_script',
    guardHint: '写入脚本文件',
    measureInput: measureScriptContentInput,
  },
  detectEnvironment: {
    command: 'detect_execution_environment',
    guardHint: '检测执行环境',
    idempotent: true,
  },
  listWorkspaceEntries: {
    command: 'list_workspace_entries',
    guardHint: '读取工作区目录',
    idempotent: true,
  },
  createWorkspacePath: {
    command: 'create_workspace_path',
    guardHint: '创建工作区资源',
    audit: 'sensitive',
  },
  renameWorkspacePath: {
    command: 'rename_workspace_path',
    guardHint: '重命名工作区资源',
    audit: 'sensitive',
  },
  deleteWorkspacePath: {
    command: 'delete_workspace_path',
    guardHint: '删除工作区资源',
    audit: 'sensitive',
  },
  startWorkspaceWatching: {
    command: 'start_workspace_watching',
    guardHint: '启动文件监听',
    audit: 'info',
  },
  stopWorkspaceWatching: {
    command: 'stop_workspace_watching',
    guardHint: '停止文件监听',
    audit: 'info',
  },
  searchWorkspace: {
    command: 'search_workspace',
    guardHint: '搜索工作区',
    idempotent: true,
    timeoutMs: 30_000,
  },
  previewWorkspaceReplacement: {
    command: 'preview_workspace_replacement',
    guardHint: '预览工作区替换',
    idempotent: true,
    audit: 'sensitive',
    timeoutMs: 30_000,
  },
  applyWorkspaceReplacement: {
    command: 'apply_workspace_replacement',
    guardHint: '应用工作区替换',
    audit: 'sensitive',
    timeoutMs: 30_000,
  },
} satisfies Record<string, ICommandMeta>;

export const workspaceTauriService: TWorkspaceTauriService = {
  analyzeScript(payload, options?: IIpcCallOptions) {
    return runCommand(WORKSPACE_COMMAND_META.analyzeScript, payload, options, () =>
      commands.analyzeScript(payload),
    );
  },

  formatScript(payload, options?: IIpcCallOptions) {
    return runCommand(WORKSPACE_COMMAND_META.formatScript, payload, options, () =>
      commands.formatScript(payload),
    );
  },

  formatDocument(payload, options?: IIpcCallOptions) {
    return runCommand(WORKSPACE_COMMAND_META.formatDocument, payload, options, () =>
      commands.formatDocument(payload),
    );
  },

  pickOpenPath() {
    return pickDialogPath('打开本地脚本', ({ open }) =>
      open({
        multiple: false,
        directory: false,
        filters: openFileFilters,
      }),
    );
  },

  pickAnyOpenPath() {
    return pickDialogPath('选择要上传的本地文件', ({ open }) =>
      open({
        multiple: false,
        directory: false,
      }),
    );
  },

  pickOpenFolderPath() {
    return pickDialogPath('打开本地文件夹', ({ open }) =>
      open({
        multiple: false,
        directory: true,
      }),
    );
  },

  pickSavePath(defaultPath) {
    return pickDialogPath('保存脚本', ({ save }) =>
      save({
        defaultPath,
        filters: saveFileFilters,
      }),
    );
  },

  pickAnySavePath(defaultPath) {
    return pickDialogPath('保存远端文件', ({ save }) =>
      save({
        defaultPath,
      }),
    );
  },

  loadScript(path, workspaceRootPath, options?: IIpcCallOptions) {
    return runCommand(
      WORKSPACE_COMMAND_META.loadScript,
      { path, workspaceRootPath: workspaceRootPath ?? null },
      options,
      () => commands.loadScript(path, workspaceRootPath ?? null),
    );
  },

  loadImageAsset(path, options?: IIpcCallOptions) {
    return runCommand(WORKSPACE_COMMAND_META.loadImageAsset, { path }, options, () =>
      commands.loadImageAsset(path),
    );
  },

  saveScript(payload, options?: IIpcCallOptions) {
    return runCommand(WORKSPACE_COMMAND_META.saveScript, payload, options, () =>
      commands.saveScript(payload),
    );
  },

  detectEnvironment(options?: IIpcCallOptions) {
    return runCommand(WORKSPACE_COMMAND_META.detectEnvironment, undefined, options, () =>
      commands.detectExecutionEnvironment(),
    );
  },

  listWorkspaceEntries(path, rootPath, options?: IIpcCallOptions) {
    return runCommand(WORKSPACE_COMMAND_META.listWorkspaceEntries, { path, rootPath }, options, () =>
      commands.listWorkspaceEntries(path ?? null, rootPath ?? null),
    );
  },

  createWorkspacePath(payload, options?: IIpcCallOptions) {
    return runCommand(WORKSPACE_COMMAND_META.createWorkspacePath, payload, options, () =>
      commands.createWorkspacePath(payload),
    );
  },

  renameWorkspacePath(payload, options?: IIpcCallOptions) {
    return runCommand(WORKSPACE_COMMAND_META.renameWorkspacePath, payload, options, () =>
      commands.renameWorkspacePath(payload),
    );
  },

  deleteWorkspacePath(payload, options?: IIpcCallOptions) {
    return runCommand(WORKSPACE_COMMAND_META.deleteWorkspacePath, payload, options, () =>
      commands.deleteWorkspacePath(payload),
    );
  },

  startWorkspaceWatching(rootPath: string, options?: IIpcCallOptions) {
    return runCommand<void>(WORKSPACE_COMMAND_META.startWorkspaceWatching, rootPath, options, async () => {
      await commands.startWorkspaceWatching(rootPath);
    });
  },

  stopWorkspaceWatching(options?: IIpcCallOptions) {
    return runCommand<void>(WORKSPACE_COMMAND_META.stopWorkspaceWatching, undefined, options, async () => {
      await commands.stopWorkspaceWatching();
    });
  },

  searchWorkspace(payload, options) {
    const commandPayload = {
      ...payload,
      includePatterns: payload.includePatterns,
      excludePatterns: payload.excludePatterns,
      limit: payload.limit ?? null,
      streamToken: payload.streamToken ?? null,
    };
    return runCommand(WORKSPACE_COMMAND_META.searchWorkspace, commandPayload, options, () =>
      commands.searchWorkspace(commandPayload),
    );
  },

  // 订阅后端 workspace-search-stream 事件：内容搜索按文件发现顺序分批 emit，前端据 streamToken 追加。
  // 仅桌面端可用——assertDesktopRuntime 在浏览器预览下会抛出，由调用方吞掉。
  async onWorkspaceSearchStream(handler) {
    await assertDesktopRuntime('监听流式搜索结果');
    const { listen } = await loadTauriEvent();
    return listen<IWorkspaceSearchStreamEvent>('workspace-search-stream', (event) => {
      handler(event.payload);
    });
  },

  previewWorkspaceReplacement(payload, options) {
    const commandPayload = {
      ...payload,
      includePatterns: payload.includePatterns,
      excludePatterns: payload.excludePatterns,
      limit: payload.limit ?? null,
    };
    return runCommand(WORKSPACE_COMMAND_META.previewWorkspaceReplacement, commandPayload, options, () =>
      commands.previewWorkspaceReplacement(commandPayload),
    );
  },

  applyWorkspaceReplacement(payload, options?: IIpcCallOptions) {
    const commandPayload = {
      request: {
        ...payload.request,
        includePatterns: payload.request.includePatterns,
        excludePatterns: payload.request.excludePatterns,
        limit: payload.request.limit ?? null,
      },
      expectedFiles: payload.expectedFiles,
    };
    return runCommand(WORKSPACE_COMMAND_META.applyWorkspaceReplacement, commandPayload, options, () =>
      commands.applyWorkspaceReplacement(commandPayload),
    );
  },
};
