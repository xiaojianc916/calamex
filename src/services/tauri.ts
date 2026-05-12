import { agentSidecarStreamEventPayloadSchema } from '@/types/agent-sidecar.schema';
import {
  aiChatStreamEventPayloadSchema,
  aiNarratorStreamEventPayloadSchema,
} from '@/types/ai.schema';
import { AppError, isAppError } from '@/types/app-error';
import type { ITauriService } from '@/types/tauri';
import { wslLinkStatusPayloadSchema } from '@/types/wsl-link.schema';
import { assertDesktopRuntime } from '@/utils/desktop-runtime';
import { toErrorMessage } from '@/utils/error';
import {
  createRedactedTextSummary,
  redactForLog,
  redactSensitiveText,
} from '@/utils/sensitive-redaction';
import { z } from 'zod';
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
const AGENT_SIDECAR_TASK_TIMEOUT_MS = 30 * 60 * 1000;
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
    return JSON.stringify(redactForLog(value));
  } catch {
    return String(redactForLog(value));
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

const formatZodIssueSummary = (issues: z.ZodIssue[]): string => {
  const issue = issues[0];

  if (!issue) {
    return '未返回具体字段错误。';
  }

  const path = issue.path.length ? issue.path.join('.') : '响应根节点';

  return `${path}: ${issue.message}`;
};

const buildPayloadMetricsOmittingTextFields = <T extends Record<string, unknown>>(
  value: T,
  omittedFields: readonly string[],
): IPayloadMetrics => {
  const omittedFieldSet = new Set(omittedFields);
  let omittedBytes = 0;
  const summaryValue: Record<string, unknown> = {};

  for (const [field, fieldValue] of Object.entries(value)) {
    if (omittedFieldSet.has(field) && typeof fieldValue === 'string') {
      const summary = createRedactedTextSummary(fieldValue);
      const bytes = summary.estimatedBytes;
      omittedBytes += bytes;
      summaryValue[field] = summary;
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

  const baseMessage = redactSensitiveText(toErrorMessage(error, 'IPC 调用失败'));

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
        const issueSummary = formatZodIssueSummary(parsedOutput.error.issues);
        throw new AppError({
          code: 'ipc.contract-violation',
          message: `IPC 契约不一致(${options.name})，traceId=${traceId}，${issueSummary}`,
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


const agentSidecarHealthIpc = defineContractIpc(
  'agent_sidecar_health',
  '读取 Agent sidecar 健康状态',
  tauriContracts.agentSidecarHealth,
  { idempotent: true, audit: 'sensitive', timeoutMs: 10_000 },
);

const agentSidecarRestartIpc = defineContractIpc(
  'agent_sidecar_restart',
  '重启 Agent sidecar 进程',
  tauriContracts.agentSidecarRestart,
  { audit: 'sensitive', timeoutMs: 30_000 },
);

const agentSidecarChatIpc = definePayloadIpc(
  'agent_sidecar_chat',
  '通过 Node sidecar 执行 Agent Ask',
  tauriContracts.agentSidecarChat,
  {
    audit: 'sensitive',
    timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
    measureInput: measureAiChatInput,
  },
);

const agentSidecarPlanIpc = definePayloadIpc(
  'agent_sidecar_plan',
  '通过 Node sidecar 生成 Agent 计划',
  tauriContracts.agentSidecarPlan,
  {
    audit: 'sensitive',
    timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
    measureInput: measureAiChatInput,
  },
);

const agentSidecarPlanApproveIpc = definePayloadIpc(
  'agent_sidecar_plan_approve',
  '批准 Agent sidecar 计划',
  tauriContracts.agentSidecarPlanApprove,
  { audit: 'sensitive', timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS },
);

const agentSidecarPlanQueryIpc = definePayloadIpc(
  'agent_sidecar_plan_query',
  '读取 Agent sidecar 计划记录',
  tauriContracts.agentSidecarPlanQuery,
  { idempotent: true, audit: 'sensitive', timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS },
);

const agentSidecarPlanRejectIpc = definePayloadIpc(
  'agent_sidecar_plan_reject',
  '拒绝 Agent sidecar 计划',
  tauriContracts.agentSidecarPlanReject,
  { audit: 'sensitive', timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS },
);

const agentSidecarPlanFinishIpc = definePayloadIpc(
  'agent_sidecar_plan_finish',
  '收口 Agent sidecar 计划状态',
  tauriContracts.agentSidecarPlanFinish,
  { audit: 'sensitive', timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS },
);

const agentSidecarPlanValidateIpc = definePayloadIpc(
  'agent_sidecar_plan_validate',
  '验证 Agent sidecar 计划执行结果',
  tauriContracts.agentSidecarPlanValidate,
  {
    audit: 'sensitive',
    timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
    measureInput: measureAiChatInput,
  },
);

const agentSidecarPlanReplanIpc = definePayloadIpc(
  'agent_sidecar_plan_replan',
  '根据验证结果重新生成 Agent sidecar 计划',
  tauriContracts.agentSidecarPlanReplan,
  {
    audit: 'sensitive',
    timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
    measureInput: measureAiChatInput,
  },
);

const agentSidecarExecuteIpc = definePayloadIpc(
  'agent_sidecar_execute',
  '通过 Node sidecar 执行 Agent 任务',
  tauriContracts.agentSidecarExecute,
  {
    audit: 'sensitive',
    timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS,
    measureInput: measureAiChatInput,
  },
);

const agentSidecarResolveApprovalIpc = definePayloadIpc(
  'agent_sidecar_resolve_approval',
  '处理 Agent sidecar 工具审批',
  tauriContracts.agentSidecarResolveApproval,
  { audit: 'sensitive', timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS },
);

const agentSidecarRestoreCheckpointIpc = definePayloadIpc(
  'agent_sidecar_restore_checkpoint',
  '通过 Node sidecar 恢复 Agent 回滚检查点',
  tauriContracts.agentSidecarRestoreCheckpoint,
  { audit: 'sensitive', timeoutMs: AGENT_SIDECAR_TASK_TIMEOUT_MS },
);

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

const getWslLinkStatusIpc = defineContractIpc(
  'get_wsl_link_status',
  '读取 WSL Link 状态',
  tauriContracts.getWslLinkStatus,
  { idempotent: true, timeoutMs: 5_000 },
);

const checkWslLinkEnvironmentIpc = defineContractIpc(
  'check_wsl_link_environment',
  '检测 WSL Link 运行环境',
  tauriContracts.checkWslLinkEnvironment,
  { idempotent: true, timeoutMs: 8_000 },
);

const getWslLinkAgentArtifactStatusIpc = defineContractIpc(
  'get_wsl_link_agent_artifact_status',
  '读取 WSL Link agent 构建产物状态',
  tauriContracts.getWslLinkAgentArtifactStatus,
  { idempotent: true, timeoutMs: 5_000 },
);

const installWslLinkAgentIpc = definePayloadIpc(
  'install_wsl_link_agent',
  '安装 WSL Link agent',
  tauriContracts.installWslLinkAgent,
  { idempotent: false, audit: 'sensitive', timeoutMs: 90_000 },
);

const startWslLinkAgentIpc = definePayloadIpc(
  'start_wsl_link_agent',
  '启动 WSL Link agent',
  tauriContracts.startWslLinkAgent,
  { idempotent: false, audit: 'sensitive', timeoutMs: 20_000 },
);

const startWslLinkSupervisorIpc = definePayloadIpc(
  'start_wsl_link_supervisor',
  '启动 WSL Link 常驻连接',
  tauriContracts.startWslLinkSupervisor,
  { idempotent: false, audit: 'sensitive', timeoutMs: 5_000 },
);

const stopWslLinkSupervisorIpc = defineContractIpc(
  'stop_wsl_link_supervisor',
  '停止 WSL Link 常驻连接',
  tauriContracts.stopWslLinkSupervisor,
  { idempotent: false, audit: 'sensitive', timeoutMs: 5_000 },
);

const probeWslLinkPrimaryIpc = defineContractIpc(
  'probe_wsl_link_primary',
  '探测 WSL Link 主通道',
  tauriContracts.probeWslLinkPrimary,
  { idempotent: false, audit: 'sensitive', timeoutMs: 8_000 },
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

const previewWorkspaceReplacementIpc = definePayloadIpc(
  'preview_workspace_replacement',
  '预览工作区替换',
  tauriContracts.previewWorkspaceReplacement,
  { idempotent: true, audit: 'sensitive', timeoutMs: 30_000 },
);

const applyWorkspaceReplacementIpc = definePayloadIpc(
  'apply_workspace_replacement',
  '应用工作区替换',
  tauriContracts.applyWorkspaceReplacement,
  { audit: 'sensitive', timeoutMs: 30_000 },
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

const listGitCommitHistoryIpc = definePayloadIpc(
  'list_git_commit_history',
  '读取 Git 提交历史',
  tauriContracts.listGitCommitHistory,
  { idempotent: true, timeoutMs: 20_000 },
);

const listGitBranchesIpc = definePayloadIpc(
  'list_git_branches',
  '读取 Git 分支列表',
  tauriContracts.listGitBranches,
  { idempotent: true },
);

const checkoutGitBranchIpc = definePayloadIpc(
  'checkout_git_branch',
  '切换 Git 分支',
  tauriContracts.checkoutGitBranch,
  { audit: 'sensitive', timeoutMs: 20_000 },
);

const createGitBranchIpc = definePayloadIpc(
  'create_git_branch',
  '创建 Git 分支',
  tauriContracts.createGitBranch,
  { audit: 'sensitive', timeoutMs: 20_000 },
);

const getGitFileBaselineIpc = defineContractIpc(
  'get_git_file_baseline',
  '读取 Git 文件基线',
  tauriContracts.getGitFileBaseline,
  { idempotent: true },
);

const getGitDiffPreviewIpc = definePayloadIpc(
  'get_git_diff_preview',
  '读取 Git Diff 预览',
  tauriContracts.getGitDiffPreview,
  { idempotent: true, timeoutMs: 20_000 },
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

const listGitStashesIpc = definePayloadIpc(
  'list_git_stashes',
  '读取 Git 贮藏列表',
  tauriContracts.listGitStashes,
  { idempotent: true },
);

const saveGitStashIpc = definePayloadIpc(
  'save_git_stash',
  '保存 Git 贮藏',
  tauriContracts.saveGitStash,
  { audit: 'sensitive', timeoutMs: 20_000 },
);

const applyGitStashIpc = definePayloadIpc(
  'apply_git_stash',
  '应用 Git 贮藏',
  tauriContracts.applyGitStash,
  { audit: 'sensitive', timeoutMs: 20_000 },
);

const dropGitStashIpc = definePayloadIpc(
  'drop_git_stash',
  '删除 Git 贮藏',
  tauriContracts.dropGitStash,
  { audit: 'sensitive', timeoutMs: 20_000 },
);

const getGitPullRequestSupportIpc = definePayloadIpc(
  'get_git_pull_request_support',
  '读取 Git 远程 Pull Request 支持信息',
  tauriContracts.getGitPullRequestSupport,
  { idempotent: true },
);

const testSshConnectionIpc = definePayloadIpc(
  'test_ssh_connection',
  '测试 SSH 连接',
  tauriContracts.testSshConnection,
  { idempotent: true, timeoutMs: 15_000, audit: 'sensitive' },
);

const saveSshPasswordIpc = definePayloadIpc(
  'save_ssh_password',
  '保存 SSH 密码',
  tauriContracts.saveSshPassword,
  { audit: 'sensitive' },
);

const getSshPasswordIpc = definePayloadIpc(
  'get_ssh_password',
  '读取 SSH 密码',
  tauriContracts.getSshPassword,
  { idempotent: true, audit: 'sensitive' },
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

const readSshFileIpc = definePayloadIpc(
  'read_ssh_file',
  '读取 SSH 远端文件',
  tauriContracts.readSshFile,
  { idempotent: true, audit: 'sensitive', timeoutMs: 60_000 },
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

const aiTestProviderConfigIpc = definePayloadIpc(
  'ai_test_provider_config',
  '使用草稿配置测试 AI Provider',
  tauriContracts.aiTestProviderConfig,
  {
    idempotent: true,
    audit: 'sensitive',
    measureInput: (value) => buildPayloadMetricsOmittingTextFields(value, ['apiKey']),
  },
);

const aiConnectProviderIpc = definePayloadIpc(
  'ai_connect_provider',
  '连接并保存 AI Provider',
  tauriContracts.aiConnectProvider,
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

const aiListProviderProfilesIpc = defineContractIpc(
  'ai_list_provider_profiles',
  '读取 AI 配置记录',
  tauriContracts.aiListProviderProfiles,
  { idempotent: true, audit: 'sensitive' },
);

const aiGetProviderProfileDetailIpc = definePayloadIpc(
  'ai_get_provider_profile_detail',
  '读取 AI 配置记录详情',
  tauriContracts.aiGetProviderProfileDetail,
  { idempotent: true, audit: 'none' },
);

const aiSwitchProviderProfileIpc = definePayloadIpc(
  'ai_switch_provider_profile',
  '切换 AI 配置记录',
  tauriContracts.aiSwitchProviderProfile,
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

const aiGenerateConversationTitleIpc = definePayloadIpc(
  'ai_generate_conversation_title',
  '生成 AI 对话标题',
  tauriContracts.aiGenerateConversationTitle,
  { audit: 'sensitive', timeoutMs: 30_000, measureInput: buildPayloadMetrics },
);

const aiGetSuggestionPoolCacheIpc = defineContractIpc(
  'ai_get_suggestion_pool_cache',
  '读取 AI 提示词池缓存',
  tauriContracts.aiGetSuggestionPoolCache,
  { idempotent: true, audit: 'none', timeoutMs: 5_000 },
);

const aiGenerateSuggestionPoolIpc = definePayloadIpc(
  'ai_generate_suggestion_pool',
  '生成 AI 提示词池',
  tauriContracts.aiGenerateSuggestionPool,
  { audit: 'info', timeoutMs: 30_000, measureInput: buildPayloadMetrics },
);

const aiNarrateActivityIpc = definePayloadIpc(
  'ai_narrate_activity',
  '生成 AI 活动旁白',
  tauriContracts.aiNarrateActivity,
  { audit: 'sensitive', timeoutMs: 20_000, measureInput: buildPayloadMetrics },
);

const aiNarrateActivityStreamIpc = definePayloadIpc(
  'ai_narrate_activity_stream',
  '发送 AI 活动旁白流式请求',
  tauriContracts.aiNarrateActivityStream,
  { audit: 'sensitive', timeoutMs: 20_000, measureInput: buildPayloadMetrics },
);

const aiChatStreamIpc = definePayloadIpc(
  'ai_chat_stream',
  '发送 AI 流式对话请求',
  tauriContracts.aiChatStream,
  { audit: 'sensitive', timeoutMs: 60_000, measureInput: measureAiChatInput },
);

const aiCancelIpc = definePayloadIpc(
  'ai_cancel',
  '取消 AI 流式请求',
  tauriContracts.aiCancel,
  { audit: 'sensitive', timeoutMs: 15_000, measureInput: buildPayloadMetrics },
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

const aiAgentClassifyTaskIpc = definePayloadIpc(
  'ai_agent_classify_task',
  '分类 AI Agent 任务复杂度',
  tauriContracts.aiAgentClassifyTask,
  { audit: 'sensitive', timeoutMs: 30_000, measureInput: measureAiChatInput },
);

const aiAgentSetNetworkPermissionIpc = definePayloadIpc(
  'ai_agent_set_network_permission',
  '设置 AI Agent 网络权限',
  tauriContracts.aiAgentSetNetworkPermission,
  { audit: 'sensitive', timeoutMs: 15_000 },
);

const aiWebSearchIpc = definePayloadIpc(
  'ai_web_search',
  '执行 AI Agent 网络搜索',
  tauriContracts.aiWebSearch,
  { idempotent: true, audit: 'sensitive', timeoutMs: 30_000 },
);

const aiWebFetchIpc = definePayloadIpc(
  'ai_web_fetch',
  '读取 AI Agent 网页来源',
  tauriContracts.aiWebFetch,
  { idempotent: true, audit: 'sensitive', timeoutMs: 30_000 },
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

const aiEditGetAuthLevelIpc = defineContractIpc(
  'ai_edit_get_auth_level',
  '读取 AED 授权等级',
  tauriContracts.aiEditGetAuthLevel,
  { audit: 'sensitive', idempotent: true },
);

const aiEditSetAuthLevelIpc = definePayloadIpc(
  'ai_edit_set_auth_level',
  '设置 AED 授权等级',
  tauriContracts.aiEditSetAuthLevel,
  { audit: 'sensitive', timeoutMs: 15_000 },
);

const aiEditListTimelineIpc = definePayloadIpc(
  'ai_edit_list_timeline',
  '读取 AED 时间线',
  tauriContracts.aiEditListTimeline,
  { audit: 'sensitive', timeoutMs: 15_000 },
);

const aiEditCreateSnapshotIpc = definePayloadIpc(
  'ai_edit_create_snapshot',
  '创建 AED 手动快照',
  tauriContracts.aiEditCreateSnapshot,
  { audit: 'sensitive', timeoutMs: 20_000 },
);

const aiEditGetDiffIpc = definePayloadIpc(
  'ai_edit_get_diff',
  '读取 AED 文件 diff',
  tauriContracts.aiEditGetDiff,
  { audit: 'sensitive', timeoutMs: 20_000 },
);

const aiEditRestoreSnapshotIpc = definePayloadIpc(
  'ai_edit_restore_snapshot',
  '恢复 AED 快照',
  tauriContracts.aiEditRestoreSnapshot,
  { audit: 'sensitive', timeoutMs: 30_000 },
);

const aiEditUndoOperationIpc = definePayloadIpc(
  'ai_edit_undo_operation',
  '撤销 AED 编辑',
  tauriContracts.aiEditUndoOperation,
  { audit: 'sensitive', timeoutMs: 30_000 },
);

const aiEditRevertFileIpc = definePayloadIpc(
  'ai_edit_revert_file',
  '回滚 AED 单文件',
  tauriContracts.aiEditRevertFile,
  { audit: 'sensitive', timeoutMs: 30_000 },
);

const aiEditRevertHunkIpc = definePayloadIpc(
  'ai_edit_revert_hunk',
  '回滚 AED 单个 hunk',
  tauriContracts.aiEditRevertHunk,
  { audit: 'sensitive', timeoutMs: 30_000 },
);

const aiEditRevertTaskIpc = definePayloadIpc(
  'ai_edit_revert_task',
  '回滚 AED 当前任务',
  tauriContracts.aiEditRevertTask,
  { audit: 'sensitive', timeoutMs: 30_000 },
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
  agentSidecarHealth: () => agentSidecarHealthIpc(undefined),

  agentSidecarRestart: () => agentSidecarRestartIpc(undefined),

  agentSidecarChat: agentSidecarChatIpc,

  agentSidecarPlan: agentSidecarPlanIpc,

  agentSidecarPlanApprove: agentSidecarPlanApproveIpc,

  agentSidecarPlanQuery: agentSidecarPlanQueryIpc,

  agentSidecarPlanReject: agentSidecarPlanRejectIpc,

  agentSidecarPlanFinish: agentSidecarPlanFinishIpc,

  agentSidecarPlanValidate: agentSidecarPlanValidateIpc,

  agentSidecarPlanReplan: agentSidecarPlanReplanIpc,

  agentSidecarExecute: agentSidecarExecuteIpc,

  agentSidecarResolveApproval: agentSidecarResolveApprovalIpc,

  agentSidecarRestoreCheckpoint: agentSidecarRestoreCheckpointIpc,

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

  getWslLinkStatus: () => getWslLinkStatusIpc(undefined),

  checkWslLinkEnvironment: () => checkWslLinkEnvironmentIpc(undefined),

  getWslLinkAgentArtifactStatus: () => getWslLinkAgentArtifactStatusIpc(undefined),

  installWslLinkAgent: (payload) => installWslLinkAgentIpc(payload),

  startWslLinkAgent: (payload) => startWslLinkAgentIpc(payload),

  startWslLinkSupervisor: (payload) => startWslLinkSupervisorIpc(payload),

  stopWslLinkSupervisor: () => stopWslLinkSupervisorIpc(undefined),

  probeWslLinkPrimary: () => probeWslLinkPrimaryIpc(undefined),

  listWorkspaceEntries(path, rootPath) {
    return listWorkspaceEntriesIpc({ path, rootPath });
  },

  createWorkspacePath: createWorkspacePathIpc,

  renameWorkspacePath: renameWorkspacePathIpc,

  deleteWorkspacePath: deleteWorkspacePathIpc,

  searchWorkspace: searchWorkspaceIpc,

  previewWorkspaceReplacement: previewWorkspaceReplacementIpc,

  applyWorkspaceReplacement: applyWorkspaceReplacementIpc,

  getGitRepositoryStatus(workspaceRootPath) {
    return getGitRepositoryStatusIpc({ workspaceRootPath });
  },

  initGitRepository(workspaceRootPath) {
    return initGitRepositoryIpc({ workspaceRootPath });
  },

  listGitCommitHistory: listGitCommitHistoryIpc,

  listGitBranches: listGitBranchesIpc,

  checkoutGitBranch: checkoutGitBranchIpc,

  createGitBranch: createGitBranchIpc,

  getGitFileBaseline(path) {
    return getGitFileBaselineIpc({ path });
  },

  getGitDiffPreview: getGitDiffPreviewIpc,

  stageGitPaths: stageGitPathsIpc,

  unstageGitPaths: unstageGitPathsIpc,

  discardGitPaths: discardGitPathsIpc,

  commitGitIndex: commitGitIndexIpc,

  listGitStashes: listGitStashesIpc,

  saveGitStash: saveGitStashIpc,

  applyGitStash: applyGitStashIpc,

  dropGitStash: dropGitStashIpc,

  getGitPullRequestSupport: getGitPullRequestSupportIpc,

  ensureTerminalSession: ensureTerminalSessionIpc,

  dispatchScriptToTerminal: dispatchScriptToTerminalIpc,

  writeTerminalInput: writeTerminalInputIpc,

  resizeTerminalSession: resizeTerminalSessionIpc,

  closeTerminalSession: closeTerminalSessionIpc,

  cancelTerminalRun: cancelTerminalRunIpc,

  testSshConnection: testSshConnectionIpc,

  saveSshPassword: saveSshPasswordIpc,

  getSshPassword: getSshPasswordIpc,

  listSshConfigHosts: () => listSshConfigHostsIpc(undefined),

  listSshDirectory: listSshDirectoryIpc,

  downloadSshFile: downloadSshFileIpc,

  uploadSshFile: uploadSshFileIpc,

  readSshFile: readSshFileIpc,

  deleteSshPath: deleteSshPathIpc,

  renameSshPath: renameSshPathIpc,

  createSshDirectory: createSshDirectoryIpc,

  aiGetConfig: () => aiGetConfigIpc(undefined),

  aiSaveConfig: aiSaveConfigIpc,

  aiSaveCredentials: aiSaveCredentialsIpc,

  aiClearCredentials: () => aiClearCredentialsIpc(undefined),

  aiListProviderProfiles: () => aiListProviderProfilesIpc(undefined),

  aiGetProviderProfileDetail: aiGetProviderProfileDetailIpc,

  aiSwitchProviderProfile: aiSwitchProviderProfileIpc,

  aiTestProvider: () => aiTestProviderIpc(undefined),

  aiTestProviderConfig: aiTestProviderConfigIpc,

  aiConnectProvider: aiConnectProviderIpc,

  aiChat(payload, options) {
    return aiChatIpc(payload, options) as ReturnType<ITauriService['aiChat']>;
  },

  aiGenerateConversationTitle: aiGenerateConversationTitleIpc,

  aiGetSuggestionPoolCache: () => aiGetSuggestionPoolCacheIpc(undefined),

  aiGenerateSuggestionPool: aiGenerateSuggestionPoolIpc,

  aiNarrateActivity: aiNarrateActivityIpc,

  aiNarrateActivityStream: aiNarrateActivityStreamIpc,

  aiChatStream: aiChatStreamIpc,

  aiCancel: aiCancelIpc,

  async onAiChatStream(handler) {
    await assertDesktopRuntime('监听 AI 流式响应');
    const { listen } = await loadTauriEvent();
    return listen('ai:chat-stream', (event) => {
      const parsed = aiChatStreamEventPayloadSchema.safeParse(event.payload);
      if (!parsed.success) {
        return;
      }
      handler(parsed.data);
    });
  },

  async onAiNarratorStream(handler) {
    await assertDesktopRuntime('监听 AI 活动旁白流式响应');
    const { listen } = await loadTauriEvent();
    return listen('ai:narrator-stream', (event) => {
      const parsed = aiNarratorStreamEventPayloadSchema.safeParse(event.payload);
      if (!parsed.success) {
        return;
      }
      handler(parsed.data);
    });
  },

  async onAgentSidecarStream(handler) {
    await assertDesktopRuntime('监听 Agent sidecar 流式事件');
    const { listen } = await loadTauriEvent();
    return listen('ai:sidecar-stream', (event) => {
      const parsed = agentSidecarStreamEventPayloadSchema.safeParse(event.payload);
      if (!parsed.success) {
        return;
      }
      handler(parsed.data);
    });
  },

  async onWslLinkStatus(handler) {
    await assertDesktopRuntime('监听 WSL Link 状态事件');
    const { listen } = await loadTauriEvent();
    return listen('wsl-link:state-changed', (event) => {
      const parsed = wslLinkStatusPayloadSchema.safeParse(event.payload);
      if (!parsed.success) {
        return;
      }
      handler(parsed.data);
    });
  },

  aiInlineComplete: aiInlineCompleteIpc,

  aiCodeAction: aiCodeActionIpc,

  aiAgentClassifyTask: aiAgentClassifyTaskIpc,

  aiAgentSetNetworkPermission: aiAgentSetNetworkPermissionIpc,

  aiWebSearch: aiWebSearchIpc,

  aiWebFetch: aiWebFetchIpc,

  aiBuildIndex: aiBuildIndexIpc,

  aiQueryIndex: aiQueryIndexIpc,

  aiProposePatch: aiProposePatchIpc,

  aiApplyPatch: aiApplyPatchIpc,

  aiEditGetAuthLevel: () => aiEditGetAuthLevelIpc(undefined),

  aiEditSetAuthLevel: aiEditSetAuthLevelIpc,

  aiEditListTimeline: aiEditListTimelineIpc,

  aiEditCreateSnapshot: aiEditCreateSnapshotIpc,

  aiEditGetDiff: aiEditGetDiffIpc,

  aiEditRestoreSnapshot: aiEditRestoreSnapshotIpc,

  aiEditUndoOperation: aiEditUndoOperationIpc,

  aiEditRevertFile: aiEditRevertFileIpc,

  aiEditRevertHunk: aiEditRevertHunkIpc,

  aiEditRevertTask: aiEditRevertTaskIpc,

  aiListTools: () => aiListToolsIpc(undefined),
};
