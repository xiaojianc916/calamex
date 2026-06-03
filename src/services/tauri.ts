import { z } from 'zod';
import { commands } from '@/bindings/tauri';
import { aiChatStreamEventPayloadSchema } from '@/types/ai/schema';
import { agentSidecarStreamEventPayloadSchema } from '@/types/ai/sidecar.schema';
import { AppError, isAppError } from '@/types/app-error';
import type { ITauriService } from '@/types/tauri';
import { assertDesktopRuntime } from '@/utils/desktop-runtime';
import { toErrorMessage } from '@/utils/error';
import { tauriContracts } from './tauri.contracts';
import { useDialog } from '@/composables/useDialog';

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
}

interface IPayloadMetrics {
  bytes: number;
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
  return crypto.randomUUID();
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
  const valueWithoutOmittedText: Record<string, unknown> = {};

  for (const [field, fieldValue] of Object.entries(value)) {
    if (omittedFieldSet.has(field) && typeof fieldValue === 'string') {
      omittedBytes += textEncoder ? textEncoder.encode(fieldValue).length : fieldValue.length;
      continue;
    }

    valueWithoutOmittedText[field] = fieldValue;
  }

  const baseMetrics = buildPayloadMetrics(valueWithoutOmittedText);
  return {
    bytes: baseMetrics.bytes + omittedBytes,
  };
};

const measureScriptContentInput = (value: Record<string, unknown>): IPayloadMetrics =>
  buildPayloadMetricsOmittingTextFields(value, ['content']);

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

interface ISpectaCommandOptions {
  command: string;
  guardHint: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  idempotent?: boolean;
  audit?: TIpcAuditLevel;
  input?: unknown;
  measureInput?: (input: Record<string, unknown>) => IPayloadMetrics;
  errorMap?: TErrorMap; // 新增
}

interface IIpcInstrumentationOptions {
  command: string;
  audit: TIpcAuditLevel;
  idempotent: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  errorMap: TErrorMap;
}

interface IIpcInstrumentationContext {
  traceId: string;
  timeoutMs: number;
  shouldAudit: boolean;
  reportInputBytes: (bytes: number) => void;
  reportOutputBytes: (bytes: number) => void;
}

/** IPC 调用统一插桩：集中处理 traceId、审计日志与错误归一化。 */
const runInstrumentedIpc = async <TResult>(
  options: IIpcInstrumentationOptions,
  run: (context: IIpcInstrumentationContext) => Promise<TResult>,
): Promise<TResult> => {
  const traceId = createTraceId();
  const startedAt = Date.now();
  const shouldAudit = options.audit !== 'none';
  let inputBytes = 0;
  let outputBytes = 0;

  const emit = (outcome: 'ok' | 'error', errorCode?: string): void => {
    if (!shouldAudit) {
      return;
    }

    emitIpcLog({
      timestamp: new Date().toISOString(),
      level: outcome === 'error' ? 'error' : 'info',
      scope: 'ipc',
      event: 'tauri.invoke',
      traceId,
      command: options.command,
      audit: options.audit,
      idempotent: options.idempotent,
      durationMs: Date.now() - startedAt,
      inputBytes,
      outputBytes,
      outcome,
      ...(errorCode ? { errorCode } : {}),
    });
  };

  const context: IIpcInstrumentationContext = {
    traceId,
    timeoutMs: options.timeoutMs,
    shouldAudit,
    reportInputBytes: (bytes) => {
      inputBytes = bytes;
    },
    reportOutputBytes: (bytes) => {
      outputBytes = bytes;
    },
  };

  try {
    const result = await run(context);
    emit('ok');
    return result;
  } catch (error) {
    const normalizedError = normalizeIpcError(error, { traceId, errorMap: options.errorMap });
    emit('error', normalizedError.code);
    throw normalizedError;
  }
};

const callSpectaCommand = <T>(options: ISpectaCommandOptions, run: () => Promise<T>): Promise<T> =>
  runInstrumentedIpc<T>(
    {
      command: options.command,
      audit: options.audit ?? 'info',
      idempotent: options.idempotent ?? false,
      timeoutMs: options.timeoutMs ?? TAURI_IPC_DEFAULT_TIMEOUT_MS,
      signal: options.signal,
      errorMap: options.errorMap ?? {},
    },
    async ({ traceId, timeoutMs, shouldAudit, reportInputBytes, reportOutputBytes }) => {
      if (shouldAudit) {
        const input = options.input ?? {};
        const inputMetrics =
          options.measureInput && input && typeof input === 'object' && !Array.isArray(input)
            ? options.measureInput(input as Record<string, unknown>)
            : buildPayloadMetrics(input);
        reportInputBytes(inputMetrics.bytes);
      }

      if (options.signal?.aborted) {
        throw createCanceledError(traceId);
      }

      await assertDesktopRuntime(options.guardHint);
      const invocation = run();
      invocation.catch(() => undefined);
      const output = await raceWithTimeoutAndAbort(invocation, {
        timeoutMs,
        signal: options.signal,
        traceId,
      });

      if (shouldAudit) {
        reportOutputBytes(buildPayloadMetrics(output).bytes);
      }

      return output;
    },
  );

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
  const idempotent = options.idempotent ?? false;
  const errorMap = options.errorMap ?? {};

  return (
    input: z.input<TInSchema>,
    callOptions: IIpcCallOptions = {},
  ): Promise<z.output<TOutSchema>> =>
    runInstrumentedIpc<z.output<TOutSchema>>(
      {
        command: options.name,
        audit,
        idempotent,
        timeoutMs,
        signal: callOptions.signal,
        errorMap,
      },
      async ({
        traceId,
        timeoutMs: effectiveTimeoutMs,
        shouldAudit,
        reportInputBytes,
        reportOutputBytes,
      }) => {
        let normalizedInput: z.output<TInSchema>;
        try {
          normalizedInput = options.inSchema.parse(input);
        } catch (error) {
          if (error instanceof z.ZodError) {
            if (shouldAudit) {
              reportInputBytes(buildPayloadMetrics(input).bytes);
            }
            throw new AppError({
              code: 'ipc.input-validation',
              message: `IPC 请求参数无效，已记录 traceId=${traceId}。`,
              scope: 'validation',
              traceId,
              cause: {
                issues: error.issues,
              },
            });
          }
          throw error;
        }

        if (shouldAudit) {
          const inputMetrics = options.measureInput
            ? options.measureInput(normalizedInput)
            : buildPayloadMetrics(normalizedInput);
          reportInputBytes(inputMetrics.bytes);
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
          timeoutMs: effectiveTimeoutMs,
          signal: callOptions.signal,
          traceId,
        });

        const parsedOutput = options.outSchema.safeParse(rawOutput);
        if (!parsedOutput.success) {
          if (shouldAudit) {
            reportOutputBytes(buildPayloadMetrics(rawOutput).bytes);
          }
          const issueSummary = formatZodIssueSummary(parsedOutput.error.issues);
          throw new AppError({
            code: 'ipc.contract-violation',
            message: `IPC 契约不一致(${options.name})，traceId=${traceId}，${issueSummary}`,
            scope: 'validation',
            traceId,
            cause: {
              issues: parsedOutput.error.issues,
            },
          });
        }

        if (shouldAudit) {
          reportOutputBytes(buildPayloadMetrics(rawOutput).bytes);
        }

        return parsedOutput.data;
      },
    );
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

const agentSidecarWarmupIpc = defineContractIpc(
  'agent_sidecar_warmup',
  '预热 Agent sidecar 模型连接',
  tauriContracts.agentSidecarWarmup,
  { audit: 'sensitive', timeoutMs: 8_000 },
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

const writeSshFileIpc = definePayloadIpc(
  'write_ssh_file',
  '写入 SSH 远端文件',
  tauriContracts.writeSshFile,
  {
    audit: 'sensitive',
    timeoutMs: 60_000,
    measureInput: (value) => buildPayloadMetricsOmittingTextFields(value, ['content']),
  },
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

/**
 * SSH 主机密钥变更处理。
 *
 * 后端在检测到 known_hosts 中已记录的主机密钥发生变化时，不再直接拒绝，而是返回
 * 携带 `ssh/host-key-changed::<fingerprint>` 标记的错误（文件类操作）或在
 * `test_ssh_connection` 的结构化返回中以 `code` 体现。前端在此弹出危险确认弹窗，
 * 用户确认后调用 `trust_ssh_host_key` 记录新密钥为信任并无感重试原操作。
 */
const SSH_HOST_KEY_CHANGED_CODE = 'ssh/host-key-changed';

const trustSshHostKeyIpc = defineIpc({
  name: 'trust_ssh_host_key',
  guardHint: '信任变更后的 SSH 主机密钥',
  inSchema: z.object({ host: z.string(), port: z.number() }),
  outSchema: z.object({ trusted: z.boolean() }),
  audit: 'sensitive',
  timeoutMs: 15_000,
});

interface ISshHostKeyEndpoint {
  host: string;
  port: number;
}

const extractChangedHostKeyFingerprint = (message: string): string | null => {
  const marker = `${SSH_HOST_KEY_CHANGED_CODE}::`;
  const markerIndex = message.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  const rawFingerprint = message.slice(markerIndex + marker.length).trim();
  if (!rawFingerprint) {
    return null;
  }

  const [fingerprint] = rawFingerprint.split(/\s+/);
  return fingerprint || null;
};

const isHostKeyChangedError = (error: unknown): error is AppError =>
  isAppError(error) && error.message.includes(SSH_HOST_KEY_CHANGED_CODE);

const confirmTrustChangedHostKey = async (
  endpoint: ISshHostKeyEndpoint,
  fingerprint: string | null,
): Promise<boolean> => {
  const target = `${endpoint.host}:${endpoint.port}`;
  const fingerprintLine = fingerprint ? `新的密钥指纹：${fingerprint}。` : '';
  const action = await useDialog().confirm({
    title: '主机密钥已变更',
    description: `服务器 ${target} 的主机密钥与本地记录不一致。${fingerprintLine}这可能是服务器重装，也可能是中间人攻击。确认信任后将记录新密钥并继续。`,
    variant: 'danger',
    confirmText: '信任并继续',
    cancelText: '取消',
  });
  return action === 'confirm';
};

const withChangedHostKeyPrompt = <TInput extends ISshHostKeyEndpoint, TOutput>(
  operation: (input: TInput, options?: IIpcCallOptions) => Promise<TOutput>,
) => {
  return async (input: TInput, options?: IIpcCallOptions): Promise<TOutput> => {
    try {
      return await operation(input, options);
    } catch (error) {
      if (!isHostKeyChangedError(error)) {
        throw error;
      }

      const fingerprint = extractChangedHostKeyFingerprint(error.message);
      const trusted = await confirmTrustChangedHostKey(input, fingerprint);
      if (!trusted) {
        throw error;
      }

      await trustSshHostKeyIpc({ host: input.host, port: input.port });
      return operation(input, options);
    }
  };
};

const testSshConnectionWithHostKeyPrompt: typeof testSshConnectionIpc = async (input, options) => {
  const result = await testSshConnectionIpc(input, options);
  if (result.code !== SSH_HOST_KEY_CHANGED_CODE) {
    return result;
  }

  const fingerprint = extractChangedHostKeyFingerprint(result.message);
  const endpoint: ISshHostKeyEndpoint = { host: input.host, port: input.port };
  const trusted = await confirmTrustChangedHostKey(endpoint, fingerprint);
  if (!trusted) {
    return result;
  }

  await trustSshHostKeyIpc({ host: endpoint.host, port: endpoint.port });
  return testSshConnectionIpc(input, options);
};

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

const aiTestProviderIpc = defineContractIpc(
  'ai_test_provider',
  '测试 AI Provider',
  tauriContracts.aiTestProvider,
  { idempotent: true, audit: 'sensitive' },
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

const aiChatStreamIpc = definePayloadIpc(
  'ai_chat_stream',
  '发送 AI 流式对话请求',
  tauriContracts.aiChatStream,
  { audit: 'sensitive', timeoutMs: 60_000, measureInput: measureAiChatInput },
);

const aiCancelIpc = definePayloadIpc('ai_cancel', '取消 AI 流式请求', tauriContracts.aiCancel, {
  audit: 'sensitive',
  timeoutMs: 15_000,
  measureInput: buildPayloadMetrics,
});

const aiInlineCompleteIpc = definePayloadIpc(
  'ai_inline_complete',
  '请求 AI 内联补全',
  tauriContracts.aiInlineComplete,
  { audit: 'sensitive', timeoutMs: 15_000, measureInput: measureAiInlineCompletionInput },
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

const aiEditSetPinIpc = definePayloadIpc(
  'ai_edit_set_pin',
  '更新 AED Pin 状态',
  tauriContracts.aiEditSetPin,
  { audit: 'sensitive', timeoutMs: 15_000 },
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

export const tauriService: ITauriService & {
  pickOpenPath(): Promise<string | null>;
  pickAnyOpenPath(): Promise<string | null>;
  pickOpenFolderPath(): Promise<string | null>;
  pickSavePath(defaultPath: string): Promise<string | null>;
  pickAnySavePath(defaultPath: string): Promise<string | null>;
} = {
  agentSidecarHealth: () => agentSidecarHealthIpc(undefined),

  agentSidecarRestart: () => agentSidecarRestartIpc(undefined),

  agentSidecarWarmup: () => agentSidecarWarmupIpc(undefined),

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

  analyzeScript(payload) {
    return callSpectaCommand(
      {
        command: 'analyze_script',
        guardHint: '执行 ShellCheck 实时诊断',
        idempotent: true,
        input: payload,
      },
      () => commands.analyzeScript(payload),
    );
  },

  formatScript(payload) {
    return callSpectaCommand(
      {
        command: 'format_script',
        guardHint: '使用 shfmt 格式化脚本',
        input: payload,
        measureInput: measureScriptContentInput,
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

  loadScript(path) {
    return callSpectaCommand(
      { command: 'load_script', guardHint: '读取脚本文件', idempotent: true, input: { path } },
      () => commands.loadScript(path),
    );
  },

  loadImageAsset(path) {
    return callSpectaCommand(
      {
        command: 'load_image_asset',
        guardHint: '读取图片资源',
        idempotent: true,
        input: { path },
      },
      () => commands.loadImageAsset(path),
    );
  },

  saveScript(payload) {
    return callSpectaCommand(
      {
        command: 'save_script',
        guardHint: '写入脚本文件',
        input: payload,
        measureInput: measureScriptContentInput,
      },
      () => commands.saveScript(payload),
    );
  },

  detectEnvironment() {
    return callSpectaCommand(
      {
        command: 'detect_execution_environment',
        guardHint: '检测执行环境',
        idempotent: true,
        input: undefined,
      },
      () => commands.detectExecutionEnvironment(),
    );
  },

  listWorkspaceEntries(path, rootPath) {
    return callSpectaCommand(
      {
        command: 'list_workspace_entries',
        guardHint: '读取工作区目录',
        idempotent: true,
        input: { path, rootPath },
      },
      () => commands.listWorkspaceEntries(path ?? null, rootPath ?? null),
    );
  },

  createWorkspacePath(payload) {
    return callSpectaCommand(
      {
        command: 'create_workspace_path',
        guardHint: '创建工作区资源',
        audit: 'sensitive',
        input: payload,
      },
      () => commands.createWorkspacePath(payload),
    );
  },

  renameWorkspacePath(payload) {
    return callSpectaCommand(
      {
        command: 'rename_workspace_path',
        guardHint: '重命名工作区资源',
        audit: 'sensitive',
        input: payload,
      },
      () => commands.renameWorkspacePath(payload),
    );
  },

  deleteWorkspacePath(payload) {
    return callSpectaCommand(
      {
        command: 'delete_workspace_path',
        guardHint: '删除工作区资源',
        audit: 'sensitive',
        input: payload,
      },
      () => commands.deleteWorkspacePath(payload),
    );
  },

  startWorkspaceWatching(rootPath: string) {
    return callSpectaCommand<void>(
      {
        command: 'start_workspace_watching',
        guardHint: '启动文件监听',
        audit: 'info',
        input: rootPath,
      },
      async () => {
        await commands.startWorkspaceWatching(rootPath);
      },
    );
  },

  stopWorkspaceWatching() {
    return callSpectaCommand<void>(
      {
        command: 'stop_workspace_watching',
        guardHint: '停止文件监听',
        audit: 'info',
        input: undefined,
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

  previewWorkspaceReplacement(payload) {
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
        input: commandPayload,
      },
      () => commands.previewWorkspaceReplacement(commandPayload),
    );
  },

  applyWorkspaceReplacement(payload) {
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
      },
      () => commands.applyWorkspaceReplacement(commandPayload),
    );
  },

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

  ensureTerminalSession(payload) {
    return callSpectaCommand(
      {
        command: 'ensure_terminal_session',
        guardHint: '连接 WSL2 终端',
        input: payload,
      },
      () => commands.ensureTerminalSession(payload),
    );
  },

  dispatchScriptToTerminal(payload) {
    return callSpectaCommand(
      {
        command: 'dispatch_script_to_terminal',
        guardHint: '在终端中执行脚本',
        input: payload,
        measureInput: measureScriptContentInput,
      },
      () => commands.dispatchScriptToTerminal(payload),
    );
  },

  writeTerminalInput(payload) {
    return callSpectaCommand<void>(
      {
        command: 'write_terminal_input',
        guardHint: '写入终端输入',
        audit: 'none',
        input: payload,
      },
      async () => {
        await commands.writeTerminalInput(payload);
      },
    );
  },

  resizeTerminalSession(payload) {
    return callSpectaCommand<void>(
      {
        command: 'resize_terminal_session',
        guardHint: '同步终端尺寸',
        audit: 'none',
        input: payload,
      },
      async () => {
        await commands.resizeTerminalSession(payload);
      },
    );
  },

  closeTerminalSession(payload) {
    return callSpectaCommand<void>(
      {
        command: 'close_terminal_session',
        guardHint: '关闭终端会话',
        audit: 'sensitive',
        input: payload,
      },
      async () => {
        await commands.closeTerminalSession(payload);
      },
    );
  },

  cancelTerminalRun(payload) {
    return callSpectaCommand<void>(
      {
        command: 'cancel_terminal_run',
        guardHint: '取消终端脚本运行',
        audit: 'sensitive',
        input: payload,
      },
      async () => {
        await commands.cancelTerminalRun({ runId: payload.runId, mode: payload.mode ?? null });
      },
    );
  },

  testSshConnection: testSshConnectionWithHostKeyPrompt,

  saveSshPassword: saveSshPasswordIpc,

  getSshPassword: getSshPasswordIpc,

  listSshConfigHosts: () => listSshConfigHostsIpc(undefined),

  listSshDirectory: withChangedHostKeyPrompt(listSshDirectoryIpc),

  downloadSshFile: withChangedHostKeyPrompt(downloadSshFileIpc),

  uploadSshFile: withChangedHostKeyPrompt(uploadSshFileIpc),

  readSshFile: withChangedHostKeyPrompt(readSshFileIpc),

  writeSshFile: withChangedHostKeyPrompt(writeSshFileIpc),

  deleteSshPath: withChangedHostKeyPrompt(deleteSshPathIpc),

  renameSshPath: withChangedHostKeyPrompt(renameSshPathIpc),

  createSshDirectory: withChangedHostKeyPrompt(createSshDirectoryIpc),

  aiGetConfig: () => aiGetConfigIpc(undefined),

  aiSaveConfig: aiSaveConfigIpc,

  aiSaveCredentials: aiSaveCredentialsIpc,

  aiClearCredentials: () => aiClearCredentialsIpc(undefined),

  aiTestProvider: () => aiTestProviderIpc(undefined),

  aiTestProviderConfig: aiTestProviderConfigIpc,

  aiConnectProvider: aiConnectProviderIpc,

  aiGenerateConversationTitle: aiGenerateConversationTitleIpc,

  aiGetSuggestionPoolCache: () => aiGetSuggestionPoolCacheIpc(undefined),

  aiGenerateSuggestionPool: aiGenerateSuggestionPoolIpc,

  aiChatStream: aiChatStreamIpc,

  aiCancel: aiCancelIpc,

  async onAiChatStream(handler) {
    await assertDesktopRuntime('监听 AI 流式响应');
    const { listen } = await loadTauriEvent();
    return listen('ai:chat-stream', (event) => {