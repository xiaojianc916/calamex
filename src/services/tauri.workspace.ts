import { invoke } from '@tauri-apps/api/core';
import { commands, type ScriptFilePayload } from '@/bindings/tauri';
import type { ITauriService } from '@/types/tauri';
import { measureScriptContentInput } from './tauri.ipc-metrics';
import { callSpectaCommand, pickDialogPath } from './tauri.ipc-runtime';
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
  | 'previewWorkspaceReplacement'
  | 'applyWorkspaceReplacement'
> & {
  pickOpenPath(): Promise<string | null>;
  pickAnyOpenPath(): Promise<string | null>;
  pickOpenFolderPath(): Promise<string | null>;
  pickSavePath(defaultPath: string): Promise<string | null>;
  pickAnySavePath(defaultPath: string): Promise<string | null>;
};

export const workspaceTauriService: TWorkspaceTauriService = {
  analyzeScript(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'analyze_script',
        guardHint: '执行 ShellCheck 实时诊断',
        idempotent: true,
        input: payload,
        signal: options?.signal,
      },
      () => commands.analyzeScript(payload),
    );
  },

  formatScript(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'format_script',
        guardHint: '使用 shfmt 格式化脚本',
        // 后端 shfmt 守卫超时为 12s (SHFMT_TIMEOUT)，前端预算需高于它，
        // 否则会在后端完成前就以「IPC 超时」取消，给出误导性的失败。
        timeoutMs: 15_000,
        input: payload,
        measureInput: measureScriptContentInput,
        signal: options?.signal,
      },
      () => commands.formatScript(payload),
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
    return callSpectaCommand(
      {
        command: 'load_script',
        guardHint: '读取脚本文件',
        idempotent: true,
        input: { path, workspaceRootPath: workspaceRootPath ?? null },
        signal: options?.signal,
      },
      () =>
        invoke<ScriptFilePayload>('load_script', {
          path,
          workspaceRootPath: workspaceRootPath ?? null,
        }),
    );
  },

  loadImageAsset(path, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'load_image_asset',
        guardHint: '读取图片资源',
        idempotent: true,
        input: { path },
        signal: options?.signal,
      },
      () => commands.loadImageAsset(path),
    );
  },

  saveScript(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'save_script',
        guardHint: '写入脚本文件',
        input: payload,
        measureInput: measureScriptContentInput,
        signal: options?.signal,
      },
      () => commands.saveScript(payload),
    );
  },

  detectEnvironment(options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'detect_execution_environment',
        guardHint: '检测执行环境',
        idempotent: true,
        input: undefined,
        signal: options?.signal,
      },
      () => commands.detectExecutionEnvironment(),
    );
  },

  listWorkspaceEntries(path, rootPath, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'list_workspace_entries',
        guardHint: '读取工作区目录',
        idempotent: true,
        input: { path, rootPath },
        signal: options?.signal,
      },
      () => commands.listWorkspaceEntries(path ?? null, rootPath ?? null),
    );
  },

  createWorkspacePath(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'create_workspace_path',
        guardHint: '创建工作区资源',
        audit: 'sensitive',
        input: payload,
        signal: options?.signal,
      },
      () => commands.createWorkspacePath(payload),
    );
  },

  renameWorkspacePath(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'rename_workspace_path',
        guardHint: '重命名工作区资源',
        audit: 'sensitive',
        input: payload,
        signal: options?.signal,
      },
      () => commands.renameWorkspacePath(payload),
    );
  },

  deleteWorkspacePath(payload, options?: IIpcCallOptions) {
    return callSpectaCommand(
      {
        command: 'delete_workspace_path',
        guardHint: '删除工作区资源',
        audit: 'sensitive',
        input: payload,
        signal: options?.signal,
      },
      () => commands.deleteWorkspacePath(payload),
    );
  },

  startWorkspaceWatching(rootPath: string, options?: IIpcCallOptions) {
    return callSpectaCommand<void>(
      {
        command: 'start_workspace_watching',
        guardHint: '启动文件监听',
        audit: 'info',
        input: rootPath,
        signal: options?.signal,
      },
      async () => {
        await commands.startWorkspaceWatching(rootPath);
      },
    );
  },

  stopWorkspaceWatching(options?: IIpcCallOptions) {
    return callSpectaCommand<void>(
      {
        command: 'stop_workspace_watching',
        guardHint: '停止文件监听',
        audit: 'info',
        input: undefined,
        signal: options?.signal,
      },
      async () => {
        await commands.stopWorkspaceWatching();
      },
    );
  },
  searchWorkspace(payload, options) {
    const commandPayload = {
      ...payload,
      includePatterns: payload.includePatterns,
      excludePatterns: payload.excludePatterns,
      limit: payload.limit ?? null,
    };
    return callSpectaCommand(
      {
        command: 'search_workspace',
        guardHint: '搜索工作区',
        idempotent: true,
        timeoutMs: 30_000,
        signal: options?.signal,
        input: commandPayload,
      },
      () => commands.searchWorkspace(commandPayload),
    );
  },

  previewWorkspaceReplacement(payload, options) {
    const commandPayload = {
      ...payload,
      includePatterns: payload.includePatterns,
      excludePatterns: payload.excludePatterns,
      limit: payload.limit ?? null,
    };
    return callSpectaCommand(
      {
        command: 'preview_workspace_replacement',
        guardHint: '预览工作区替换',
        idempotent: true,
        audit: 'sensitive',
        timeoutMs: 30_000,
        signal: options?.signal,
        input: commandPayload,
      },
      () => commands.previewWorkspaceReplacement(commandPayload),
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
    return callSpectaCommand(
      {
        command: 'apply_workspace_replacement',
        guardHint: '应用工作区替换',
        audit: 'sensitive',
        timeoutMs: 30_000,
        input: commandPayload,
        signal: options?.signal,
      },
      () => commands.applyWorkspaceReplacement(commandPayload),
    );
  },
};
