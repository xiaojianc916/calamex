import type { ITauriService } from '@/types/tauri';
import { AppError, isAppError } from '@/types/app-error';
import { assertDesktopRuntime } from '@/utils/desktop-runtime';
import { toErrorMessage } from '@/utils/error';
import { z } from 'zod';
import { aiChatStreamEventPayloadSchema } from '@/types/ai.schema';
import { tauriContracts } from './tauri.contracts';

type TauriCoreModule = typeof import('@tauri-apps/api/core');
type TauriDialogModule = typeof import('@tauri-apps/plugin-dialog');
type TauriEventModule = typeof import('@tauri-apps/api/event');

export type TIpcAuditLevel = 'none' | 'info' | 'sensitive';

export interface IIpcCallOptions {
  signal?: AbortSignal;
}

interface IIpcErrorMapping {
  code: string;
  message: string;
}

type TErrorMap = Readonly<Record<string, IIpcErrorMapping>>;

interface IIpcLogRecord {
  timestamp: string;
  level: 'info' | 'error';
  scope: 'ipc';
  event: 'tauri.invoke';
  traceId: string;
  command: string;
  audit: TIpcAuditLevel;
  idempotent: boolean;
  durationMs: number;
  inputBytes: number;
  outputBytes: number;
  outcome: 'ok' | 'error';
  errorCode?: string;
  payloadSummary?: string;
}

interface IPayloadMetrics {
  bytes: number;
  summary?: string;
}

interface IDefineIpcOptions<TInSchema extends z.ZodTypeAny, TOutSchema extends z.ZodTypeAny> {
  name: string;
  guardHint: string;
  inSchema: TInSchema;
  outSchema: TOutSchema;
  timeoutMs?: number;
  idempotent?: boolean;
  audit?: TIpcAuditLevel;
  errorMap?: TErrorMap;
  measureInput?: (input: z.output<TInSchema>) => IPayloadMetrics;
  mapArgs?: (
    input: z.output<TInSchema>,
    context: { traceId: string },
  ) => Record<string, unknown> | undefined;
}

interface IIpcContract<TInSchema extends z.ZodTypeAny, TOutSchema extends z.ZodTypeAny> {
  inSchema: TInSchema;
  outSchema: TOutSchema;
}

type TIpcFactoryOptions<TInSchema extends z.ZodTypeAny, TOutSchema extends z.ZodTypeAny> = Omit<
  IDefineIpcOptions<TInSchema, TOutSchema>,
  'name' | 'guardHint' | 'inSchema' | 'outSchema'
>;

const TAURI_IPC_DEFAULT_TIMEOUT_MS = 10_000;
const LOG_PAYLOAD_SUMMARY_LIMIT = 320;
const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

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

let tauriCorePromise: Promise<TauriCoreModule> | null = null;
let tauriDialogPromise: Promise<TauriDialogModule> | null = null;
let tauriEventPromise: Promise<TauriEventModule> | null = null;

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

const loadTauriEvent = (): Promise<TauriEventModule> => {
  if (!tauriEventPromise) {
    tauriEventPromise = import('@tauri-apps/api/event');
  }
  return tauriEventPromise;
};

const createTraceId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `trace-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const serializeForLog = (value: unknown): string => {
  if (value === undefined) {
    return '';
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const buildPayloadMetricsFromSerialized = (serialized: string): IPayloadMetrics => {
  if (!serialized) {
    return { bytes: 0 };
  }

  return {
    bytes: textEncoder ? textEncoder.encode(serialized).length : serialized.length,
    summary:
      serialized.length > LOG_PAYLOAD_SUMMARY_LIMIT
        ? `${serialized.slice(0, LOG_PAYLOAD_SUMMARY_LIMIT)}...`
        : serialized,
  };
};

const buildPayloadMetrics = (value: unknown): IPayloadMetrics =>
  buildPayloadMetricsFromSerialized(serializeForLog(value));

const estimateTextBytes = (value: string): number => value.length;

const buildPayloadMetricsOmittingTextFields = <T extends Record<string, unknown>>(
  value: T,
  omittedFields: readonly string[],
): IPayloadMetrics => {
  const omittedFieldSet = new Set(omittedFields);
  let omittedBytes = 0;
  const summaryValue: Record<string, unknown> = {};

  for (const [field, fieldValue] of Object.entries(value)) {
    if (omittedFieldSet.has(field) && typeof fieldValue === 'string') {
      const bytes = estimateTextBytes(fieldValue);
      omittedBytes += bytes;
      summaryValue[field] = {
        omitted: true,
        chars: fieldValue.length,
        estimatedBytes: bytes,
      };
      continue;
    }

    summaryValue[field] = fieldValue;
  }

  const summaryMetrics = buildPayloadMetrics(summaryValue);
  return {
    bytes: summaryMetrics.bytes + omittedBytes,
    summary: summaryMetrics.summary,
  };
};

const measureScriptContentInput = <T extends { content: string }>(value: T): IPayloadMetrics =>
  buildPayloadMetricsOmittingTextFields(
    value as unknown as Record<string, unknown>,
    ['content'],
  );

const measureAiChatInput = <T extends Record<string, unknown>>(value: T): IPayloadMetrics =>
  buildPayloadMetricsOmittingTextFields(value, ['messages', 'references']);

const measureAiInlineCompletionInput = <T extends Record<string, unknown>>(
  value: T,
): IPayloadMetrics =>
  buildPayloadMetricsOmittingTextFields(value, ['prefix', 'suffix', 'recentEdits']);

const emitIpcLog = (record: IIpcLogRecord): void => {
  const serialized = JSON.stringify(record);
  if (record.outcome === 'error') {
    console.error(serialized);
    return;
  }

  console.info(serialized);
};

const normalizeDialogResult = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

const pickDialogPath = async (
  guardHint: string,
  pick: (dialogModule: TauriDialogModule) => Promise<unknown>,
): Promise<string | null> => {
  await assertDesktopRuntime(guardHint);
  const dialogModule = await loadTauriDialog();
  return normalizeDialogResult(await pick(dialogModule));
};

const normalizeInvokeArgs = (value: unknown): Record<string, unknown> | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {
    value,
  };
};

const resolveMappedError = (message: string, errorMap: TErrorMap): IIpcErrorMapping | null => {
  for (const [needle, mapped] of Object.entries(errorMap)) {
    if (message.includes(needle)) {
      return mapped;
    }
  }

  return null;
};

const createTimeoutError = (traceId: string): AppError =>
  new AppError({
    code: 'ipc.timeout',
    message: `IPC 调用超时，已记录 traceId=${traceId}。`,
    scope: 'ipc',
    traceId,
  });

const createCanceledError = (traceId: string): AppError =>
  new AppError({
    code: 'ipc.canceled',
    message: `IPC 调用已取消，已记录 traceId=${traceId}。`,
    scope: 'ipc',
    traceId,
  });

const raceWithTimeoutAndAbort = async <T>(
  invocation: Promise<T>,
  options: { timeoutMs: number; signal?: AbortSignal; traceId: string },
): Promise<T> => {
  const { timeoutMs, signal, traceId } = options;

  if (signal?.aborted) {
    throw createCanceledError(traceId);
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      if (signal) {
        signal.removeEventListener('abort', handleAbort);
      }
    };

    const finish = (handler: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      handler();
    };

    const handleAbort = (): void => {
      finish(() => reject(createCanceledError(traceId)));
    };

    timeoutId = setTimeout(() => {
      finish(() => reject(createTimeoutError(traceId)));
    }, timeoutMs);

    if (signal) {
      signal.addEventListener('abort', handleAbort, { once: true });
    }

    invocation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
};

const invokeTauriCommand = async <T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> => {
  const { invoke } = await loadTauriCore();
  return invoke<T>(command, args);
};

const normalizeIpcError = (
  error: unknown,
  context: { traceId: string; errorMap: TErrorMap },
): AppError => {
  if (isAppError(error)) {
    return error;
  }

  const baseMessage = toErrorMessage(error, 'IPC 调用失败');

  if (baseMessage.includes('浏览器预览模式')) {
    return new AppError({
      code: 'ipc.desktop-only',
      message: baseMessage,
      scope: 'ipc',
      traceId: context.traceId,
      cause: error,
    });
  }

  const mapped = resolveMappedError(baseMessage, context.errorMap);
  if (mapped) {
    return new AppError({
      code: mapped.code,
      message: mapped.message,
      scope: 'ipc',
      traceId: context.traceId,
      cause: error,
    });
  }

  return new AppError({
    code: 'ipc.invoke-failed',
    message: baseMessage,
    scope: 'ipc',
    traceId: context.traceId,
    cause: error,
  });
};

/**
 * 定义一个带运行时契约的 Tauri IPC 调用。
 *
 * 工厂会统一处理：输入校验、桌面环境守卫、traceId、超时/取消、输出校验、
 * 错误归一化与结构化日志。
 */
export const defineIpc = <TInSchema extends z.ZodTypeAny, TOutSchema extends z.ZodTypeAny>(
  options: IDefineIpcOptions<TInSchema, TOutSchema>,
) => {
  const timeoutMs = options.timeoutMs ?? TAURI_IPC_DEFAULT_TIMEOUT_MS;
  const audit = options.audit ?? 'info';
  const shouldAudit = audit !== 'none';
  const idempotent = options.idempotent ?? false;
  const errorMap = options.errorMap ?? {};

  return async (
    input: z.input<TInSchema>,
    callOptions: IIpcCallOptions = {},
  ): Promise<z.output<TOutSchema>> => {
    const traceId = createTraceId();
    const startedAt = Date.now();
    let inputMetrics: IPayloadMetrics | null = null;
    let inputBytes = 0;
    let outputBytes = 0;
    let payloadSummary: string | undefined;
    const ensureInputMetrics = (): IPayloadMetrics => {
      if (inputMetrics) {
        return inputMetrics;
      }

      inputMetrics = buildPayloadMetrics(input);
      inputBytes = inputMetrics.bytes;
      return inputMetrics;
    };

    try {
      const normalizedInput = options.inSchema.parse(input);
      if (shouldAudit) {
        inputMetrics = options.measureInput
          ? options.measureInput(normalizedInput)
          : buildPayloadMetrics(normalizedInput);
        inputBytes = inputMetrics.bytes;
      }

      if (callOptions.signal?.aborted) {
        throw createCanceledError(traceId);
      }

      await assertDesktopRuntime(options.guardHint);

      const args = options.mapArgs
        ? options.mapArgs(normalizedInput, { traceId })
        : normalizeInvokeArgs(normalizedInput);

      const invocation = invokeTauriCommand<unknown>(options.name, args);
      invocation.catch(() => undefined);
      const rawOutput = await raceWithTimeoutAndAbort(invocation, {
        timeoutMs,
        signal: callOptions.signal,
        traceId,
      });
      const parsedOutput = options.outSchema.safeParse(rawOutput);
      let outputMetrics: IPayloadMetrics | null = null;
      const ensureOutputMetrics = (): IPayloadMetrics => {
        if (outputMetrics) {
          return outputMetrics;
        }

        outputMetrics = buildPayloadMetrics(rawOutput);
        outputBytes = outputMetrics.bytes;
        return outputMetrics;
      };

      if (!parsedOutput.success) {
        payloadSummary = shouldAudit ? ensureOutputMetrics().summary : undefined;
        throw new AppError({
          code: 'ipc.contract-violation',
          message: payloadSummary
            ? `IPC 契约不一致(${options.name})，traceId=${traceId}，payload=${payloadSummary}`
            : `IPC 契约不一致(${options.name})，已记录 traceId=${traceId}。`,
          scope: 'validation',
          traceId,
          cause: {
            issues: parsedOutput.error.issues,
            payloadSummary,
          },
        });
      }

      if (shouldAudit) {
        ensureOutputMetrics();
        emitIpcLog({
          timestamp: new Date().toISOString(),
          level: 'info',
          scope: 'ipc',
          event: 'tauri.invoke',
          traceId,
          command: options.name,
          audit,
          idempotent,
          durationMs: Date.now() - startedAt,
          inputBytes,
          outputBytes,
          outcome: 'ok',
        });
      }

      return parsedOutput.data;
    } catch (error) {
      const normalizedError =
        error instanceof z.ZodError
          ? new AppError({
              code: 'ipc.input-validation',
              message: `IPC 请求参数无效，已记录 traceId=${traceId}。`,
              scope: 'validation',
              traceId,
              cause: {
                issues: error.issues,
                payloadSummary: shouldAudit ? ensureInputMetrics().summary : undefined,
              },
            })
          : normalizeIpcError(error, { traceId, errorMap });

      if (shouldAudit) {
        const fallbackInputMetrics = inputMetrics ?? ensureInputMetrics();
        emitIpcLog({
          timestamp: new Date().toISOString(),
          level: 'error',
          scope: 'ipc',
          event: 'tauri.invoke',
          traceId,
          command: options.name,
          audit,
          idempotent,
          durationMs: Date.now() - startedAt,
          inputBytes,
          outputBytes,
          outcome: 'error',
          errorCode: normalizedError.code,
          payloadSummary:
            payloadSummary ??
            buildPayloadMetrics(normalizedError.cause).summary ??
            fallbackInputMetrics.summary,
        });
      }

      throw normalizedError;
    }
  };
};

const defineContractIpc = <TInSchema extends z.ZodTypeAny, TOutSchema extends z.ZodTypeAny>(
  name: string,
  guardHint: string,
  contract: IIpcContract<TInSchema, TOutSchema>,
  options: TIpcFactoryOptions<TInSchema, TOutSchema> = {},
) =>
  defineIpc({
    name,
    guardHint,
    inSchema: contract.inSchema,
    outSchema: contract.outSchema,
    ...options,
  });

const definePayloadIpc = <TInSchema extends z.ZodTypeAny, TOutSchema extends z.ZodTypeAny>(
  name: string,
  guardHint: string,
  contract: IIpcContract<TInSchema, TOutSchema>,
  options: TIpcFactoryOptions<TInSchema, TOutSchema> = {},
) =>
  defineContractIpc(name, guardHint, contract, {
    ...options,
    mapArgs: (payload) => ({ payload }),
  });


const analyzeScriptIpc = definePayloadIpc(
  'analyze_script',
  '执行 ShellCheck 实时诊断',
  tauriContracts.analyzeScript,
  { idempotent: true },
);

const formatScriptIpc = definePayloadIpc(
  'format_script',
  '使用 shfmt 格式化脚本',
  tauriContracts.formatScript,
);

const loadScriptIpc = defineContractIpc('load_script', '读取脚本文件', tauriContracts.loadScript, {
  idempotent: true,
});

const loadImageAssetIpc = defineContractIpc(
  'load_image_asset',
  '读取图片资源',
  tauriContracts.loadImageAsset,
  { idempotent: true },
);

const saveScriptIpc = definePayloadIpc('save_script', '写入脚本文件', tauriContracts.saveScript);

const detectEnvironmentIpc = defineContractIpc(
  'detect_execution_environment',
  '检测执行环境',
  tauriContracts.detectEnvironment,
  { idempotent: true },
);

const listWorkspaceEntriesIpc = defineContractIpc(
  'list_workspace_entries',
  '读取工作区目录',
  tauriContracts.listWorkspaceEntries,
  { idempotent: true },
);

const createWorkspacePathIpc = definePayloadIpc(
  'create_workspace_path',
  '创建工作区资源',
  tauriContracts.createWorkspacePath,
  { audit: 'sensitive' },
);

const renameWorkspacePathIpc = definePayloadIpc(
  'rename_workspace_path',
  '重命名工作区资源',
  tauriContracts.renameWorkspacePath,
  { audit: 'sensitive' },
);

const deleteWorkspacePathIpc = definePayloadIpc(
  'delete_workspace_path',
  '删除工作区资源',
  tauriContracts.deleteWorkspacePath,
  { audit: 'sensitive' },
);

const searchWorkspaceIpc = definePayloadIpc(
  'search_workspace',
  '搜索工作区',
  tauriContracts.searchWorkspace,
  { idempotent: true, timeoutMs: 30_000 },
);

const getGitRepositoryStatusIpc = defineContractIpc(
  'get_git_repository_status',
  '读取 Git 仓库状态',
  tauriContracts.getGitRepositoryStatus,
  { idempotent: true },
);

const initGitRepositoryIpc = defineContractIpc(
  'init_git_repository',
  '初始化 Git 仓库',
  tauriContracts.initGitRepository,
);

const getGitFileBaselineIpc = defineContractIpc(
  'get_git_file_baseline',
  '读取 Git 文件基线',
  tauriContracts.getGitFileBaseline,
  { idempotent: true },
);

const stageGitPathsIpc = definePayloadIpc(
  'stage_git_paths',
  '暂存 Git 变更',
  tauriContracts.stageGitPaths,
);

const unstageGitPathsIpc = definePayloadIpc(
  'unstage_git_paths',
  '取消暂存 Git 变更',
  tauriContracts.unstageGitPaths,
);

const discardGitPathsIpc = definePayloadIpc(
  'discard_git_paths',
  '放弃 Git 工作区更改',
  tauriContracts.discardGitPaths,
  { audit: 'sensitive' },
);

const commitGitIndexIpc = definePayloadIpc(
  'commit_git_index',
  '创建 Git 提交',
  tauriContracts.commitGitIndex,
  { audit: 'sensitive' },
);

const testSshConnectionIpc = definePayloadIpc(
  'test_ssh_connection',
  '测试 SSH 连接',
  tauriContracts.testSshConnection,
  { idempotent: true, timeoutMs: 15_000, audit: 'sensitive' },
);

const listSshConfigHostsIpc = defineContractIpc(
  'list_ssh_config_hosts',
  '读取 SSH 配置主机',
  tauriContracts.listSshConfigHosts,
  { idempotent: true, audit: 'sensitive' },
);

const listSshDirectoryIpc = definePayloadIpc(
  'list_ssh_directory',
  '读取 SSH 远端目录',
  tauriContracts.listSshDirectory,
  { idempotent: true, timeoutMs: 15_000, audit: 'sensitive' },
);

const downloadSshFileIpc = definePayloadIpc(
  'download_ssh_file',
  '下载 SSH 远端文件',
  tauriContracts.downloadSshFile,
  { audit: 'sensitive', timeoutMs: 60_000 },
);

const uploadSshFileIpc = definePayloadIpc(
  'upload_ssh_file',
  '上传 SSH 远端文件',
  tauriContracts.uploadSshFile,
  { audit: 'sensitive', timeoutMs: 60_000 },
);

const deleteSshPathIpc = definePayloadIpc(
  'delete_ssh_path',
  '删除 SSH 远端路径',
  tauriContracts.deleteSshPath,
  { audit: 'sensitive', timeoutMs: 30_000 },
);

const renameSshPathIpc = definePayloadIpc(
  'rename_ssh_path',
  '重命名 SSH 远端路径',
  tauriContracts.renameSshPath,
  { audit: 'sensitive', timeoutMs: 30_000 },
);

const createSshDirectoryIpc = definePayloadIpc(
  'create_ssh_directory',
  '创建 SSH 远端目录',
  tauriContracts.createSshDirectory,
  { audit: 'sensitive', timeoutMs: 30_000 },
);

const aiGetConfigIpc = defineContractIpc(
  'ai_get_config',
  '读取 AI 配置',
  tauriContracts.aiGetConfig,
  { idempotent: true, audit: 'sensitive' },
);

const aiSaveConfigIpc = definePayloadIpc(
  'ai_save_config',
  '保存 AI 配置',
  tauriContracts.aiSaveConfig,
  { audit: 'sensitive' },
);

const aiSaveCredentialsIpc = definePayloadIpc(
  'ai_save_credentials',
  '保存 AI 凭证',
  tauriContracts.aiSaveCredentials,
  {
    audit: 'sensitive',
    measureInput: (value) => buildPayloadMetricsOmittingTextFields(value, ['apiKey']),
  },
);

const aiClearCredentialsIpc = defineContractIpc(
  'ai_clear_credentials',
  '清除 AI 凭证',
  tauriContracts.aiClearCredentials,
  { audit: 'sensitive' },
);

const aiTestProviderIpc = defineContractIpc(
  'ai_test_provider',
  '测试 AI Provider',
  tauriContracts.aiTestProvider,
  { idempotent: true, audit: 'sensitive' },
);

const aiChatIpc = definePayloadIpc(
  'ai_chat',
  '发送 AI 对话请求',
  tauriContracts.aiChat,
  { audit: 'sensitive', timeoutMs: 60_000, measureInput: measureAiChatInput },
);

const aiInlineCompleteIpc = definePayloadIpc(
  'ai_inline_complete',
  '请求 AI 内联补全',
  tauriContracts.aiInlineComplete,
  { audit: 'sensitive', timeoutMs: 15_000, measureInput: measureAiInlineCompletionInput },
);

const aiCodeActionIpc = definePayloadIpc(
  'ai_code_action',
  '请求 AI Code Action',
  tauriContracts.aiCodeAction,
  { audit: 'sensitive', timeoutMs: 60_000, measureInput: buildPayloadMetrics },
);

const aiPlanTaskIpc = definePayloadIpc(
  'ai_plan_task',
  '规划 AI Agent 任务',
  tauriContracts.aiPlanTask,
  { audit: 'sensitive', timeoutMs: 30_000, measureInput: measureAiChatInput },
);

const aiBuildIndexIpc = definePayloadIpc(
  'ai_build_index',
  '构建 AI 代码索引',
  tauriContracts.aiBuildIndex,
  { audit: 'sensitive', timeoutMs: 60_000 },
);

const aiQueryIndexIpc = definePayloadIpc(
  'ai_query_index',
  '查询 AI 代码索引',
  tauriContracts.aiQueryIndex,
  { audit: 'sensitive', timeoutMs: 30_000 },
);

const aiProposePatchIpc = definePayloadIpc(
  'ai_propose_patch',
  '生成 AI Patch 预览',
  tauriContracts.aiProposePatch,
  {
    audit: 'sensitive',
    timeoutMs: 30_000,
    measureInput: (value) =>
      buildPayloadMetricsOmittingTextFields(value, ['originalContent', 'updatedContent']),
  },
);

const aiApplyPatchIpc = definePayloadIpc(
  'ai_apply_patch',
  '应用 AI Patch',
  tauriContracts.aiApplyPatch,
  { audit: 'sensitive', timeoutMs: 30_000, measureInput: measureAiChatInput },
);

const aiListToolsIpc = defineContractIpc(
  'ai_list_tools',
  '读取 AI 工具白名单',
  tauriContracts.aiListTools,
  { idempotent: true, audit: 'sensitive' },
);

const ensureTerminalSessionIpc = definePayloadIpc(
  'ensure_terminal_session',
  '连接 WSL2 终端',
  tauriContracts.ensureTerminalSession,
);

const dispatchScriptToTerminalIpc = definePayloadIpc(
  'dispatch_script_to_terminal',
  '在终端中执行脚本',
  tauriContracts.dispatchScriptToTerminal,
  { measureInput: measureScriptContentInput },
);

const writeTerminalInputIpc = definePayloadIpc(
  'write_terminal_input',
  '写入终端输入',
  tauriContracts.writeTerminalInput,
  { audit: 'none' },
);

const resizeTerminalSessionIpc = definePayloadIpc(
  'resize_terminal_session',
  '同步终端尺寸',
  tauriContracts.resizeTerminalSession,
  { audit: 'none' },
);

const closeTerminalSessionIpc = definePayloadIpc(
  'close_terminal_session',
  '关闭终端会话',
  tauriContracts.closeTerminalSession,
  { audit: 'sensitive' },
);

const cancelTerminalRunIpc = definePayloadIpc(
  'cancel_terminal_run',
  '取消终端脚本运行',
  tauriContracts.cancelTerminalRun,
  { audit: 'sensitive' },
);

export const tauriService: ITauriService & {
  pickOpenPath(): Promise<string | null>;
  pickAnyOpenPath(): Promise<string | null>;
  pickOpenFolderPath(): Promise<string | null>;
  pickSavePath(defaultPath: string): Promise<string | null>;
} = {

  analyzeScript: analyzeScriptIpc,

  formatScript: formatScriptIpc,

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

  loadScript(path) {
    return loadScriptIpc({ path });
  },

  loadImageAsset(path) {
    return loadImageAssetIpc({ path });
  },

  saveScript: saveScriptIpc,

  detectEnvironment: () => detectEnvironmentIpc(undefined),

  listWorkspaceEntries(path, rootPath) {
    return listWorkspaceEntriesIpc({ path, rootPath });
  },

  createWorkspacePath: createWorkspacePathIpc,

  renameWorkspacePath: renameWorkspacePathIpc,

  deleteWorkspacePath: deleteWorkspacePathIpc,

  searchWorkspace: searchWorkspaceIpc,

  getGitRepositoryStatus(workspaceRootPath) {
    return getGitRepositoryStatusIpc({ workspaceRootPath });
  },

  initGitRepository(workspaceRootPath) {
    return initGitRepositoryIpc({ workspaceRootPath });
  },

  getGitFileBaseline(path) {
    return getGitFileBaselineIpc({ path });
  },

  stageGitPaths: stageGitPathsIpc,

  unstageGitPaths: unstageGitPathsIpc,

  discardGitPaths: discardGitPathsIpc,

  commitGitIndex: commitGitIndexIpc,

  ensureTerminalSession: ensureTerminalSessionIpc,

  dispatchScriptToTerminal: dispatchScriptToTerminalIpc,

  writeTerminalInput: writeTerminalInputIpc,

  resizeTerminalSession: resizeTerminalSessionIpc,

  closeTerminalSession: closeTerminalSessionIpc,

  cancelTerminalRun: cancelTerminalRunIpc,

  testSshConnection: testSshConnectionIpc,

  listSshConfigHosts: () => listSshConfigHostsIpc(undefined),

  listSshDirectory: listSshDirectoryIpc,

  downloadSshFile: downloadSshFileIpc,

  uploadSshFile: uploadSshFileIpc,

  deleteSshPath: deleteSshPathIpc,

  renameSshPath: renameSshPathIpc,

  createSshDirectory: createSshDirectoryIpc,

  aiGetConfig: () => aiGetConfigIpc(undefined),

  aiSaveConfig: aiSaveConfigIpc,

  aiSaveCredentials: aiSaveCredentialsIpc,

  aiClearCredentials: () => aiClearCredentialsIpc(undefined),

  aiTestProvider: () => aiTestProviderIpc(undefined),

  aiChat: aiChatIpc,

  aiChatStream: aiChatStreamIpc,

  aiCancel: aiCancelIpc,

  async onAiChatStream(handler) {
    await assertDesktopRuntime('?? AI ????');
    const { listen } = await loadTauriEvent();
    return listen('ai:chat-stream', (event) => {
      const parsed = aiChatStreamEventPayloadSchema.safeParse(event.payload);
      if (!parsed.success) {
        return;
      }
      handler(parsed.data);
    });
  },

  aiInlineComplete: aiInlineCompleteIpc,

  aiCodeAction: aiCodeActionIpc,

  aiPlanTask: aiPlanTaskIpc,

  aiBuildIndex: aiBuildIndexIpc,

  aiQueryIndex: aiQueryIndexIpc,

  aiProposePatch: aiProposePatchIpc,

  aiApplyPatch: aiApplyPatchIpc,

  aiListTools: () => aiListToolsIpc(undefined),
};
