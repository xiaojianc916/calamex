import { AppError, isAppError } from '@/types/app-error';
import { createUniqueId } from '@/utils/core/id';
import { toErrorMessage } from '@/utils/error/error';
import {
  assertDesktopRuntime,
  DesktopRuntimeUnavailableError,
} from '@/utils/platform/desktop-runtime';
import { logger } from '@/utils/platform/logger';
import { buildPayloadMetrics } from './tauri.ipc-metrics';
import type {
  IIpcErrorMapping,
  IIpcInstrumentationContext,
  IIpcInstrumentationOptions,
  IIpcLogRecord,
  ISpectaCommandOptions,
  TErrorMap,
} from './tauri.ipc-types';

type TauriCoreModule = typeof import('@tauri-apps/api/core');
type TauriDialogModule = typeof import('@tauri-apps/plugin-dialog');
type TauriEventModule = typeof import('@tauri-apps/api/event');

export const TAURI_IPC_DEFAULT_TIMEOUT_MS = 10_000;

/** IPC 专用日志通道：统一走项目 logger 门面（受 VITE_LOG_LEVEL 与统一 formatOptions 约束），避免与全局 consola 形成双轨日志。 */
const ipcLogger = logger.child({ scope: 'ipc' });

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

export const loadTauriEvent = (): Promise<TauriEventModule> => {
  if (!tauriEventPromise) {
    tauriEventPromise = import('@tauri-apps/api/event');
  }

  return tauriEventPromise;
};

const createTraceId = (): string => createUniqueId();

const emitIpcLog = (record: IIpcLogRecord): void => {
  // 错误始终通过 consola 上报（即使 audit 关闭也会输出）；常规 info 审计日志仅在
  // 开发环境打印，避免生产环境每次 IPC 调用都写一条日志。consola 负责对象序列化。
  if (record.outcome === 'error') {
    ipcLogger.error(record);
    return;
  }

  if (import.meta.env.DEV) {
    ipcLogger.info(record);
  }
};

const normalizeDialogResult = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

export const pickDialogPath = async (
  guardHint: string,
  pick: (dialogModule: TauriDialogModule) => Promise<unknown>,
): Promise<string | null> => {
  await assertDesktopRuntime(guardHint);
  const dialogModule = await loadTauriDialog();
  return normalizeDialogResult(await pick(dialogModule));
};

export const normalizeInvokeArgs = (value: unknown): Record<string, unknown> | undefined => {
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

// 按键长度降序匹配：优先命中更具体的长键，避免短键抢先遮蔽。
const resolveMappedError = (message: string, errorMap: TErrorMap): IIpcErrorMapping | null => {
  const entries = Object.entries(errorMap).sort(([a], [b]) => b.length - a.length);
  for (const [needle, mapped] of entries) {
    if (message.includes(needle)) {
      return mapped;
    }
  }

  return null;
};

/**
 * 临时兼容层（#2 后端错误码灰度）：已迁移为 typed error 的命令经 tauri-specta
 *（ErrorHandlingMode::Throw）抛出结构化 `{ code, message }`（见后端
 * src-tauri/src/commands/error.rs 的 CommandError）。据此优先归一为带稳定 code 的
 * AppError，置于旧 substring errorMap 匹配之前。待所有命令完成迁移、统一返回
 * CommandError 后，连同 resolveMappedError / errorMap 一并删除。
 */
interface IStructuredCommandError {
  code: string;
  message: string;
}

const asStructuredCommandError = (error: unknown): IStructuredCommandError | null => {
  if (typeof error !== 'object' || error === null) {
    return null;
  }

  const candidate = error as Record<string, unknown>;
  if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
    return { code: candidate.code, message: candidate.message };
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

export const createCanceledError = (traceId: string): AppError =>
  new AppError({
    code: 'ipc.canceled',
    message: `IPC 调用已取消，已记录 traceId=${traceId}。`,
    scope: 'ipc',
    traceId,
  });

export const raceWithTimeoutAndAbort = async <T>(
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

/** IPC 调用统一插桩：集中处理 traceId、审计日志与错误归一。 */
export const runInstrumentedIpc = async <TResult>(
  options: IIpcInstrumentationOptions,
  run: (context: IIpcInstrumentationContext) => Promise<TResult>,
): Promise<TResult> => {
  const traceId = createTraceId();
  const startedAt = Date.now();
  const shouldAudit = options.audit !== 'none';
  let inputBytes = 0;
  let outputBytes = 0;

  const emit = (outcome: 'ok' | 'error', errorCode?: string): void => {
    // 成功路径遵循 audit 配置；错误始终上报，便于排查 audit:'none' 命令的失败。
    if (outcome === 'ok' && !shouldAudit) {
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

export const callSpectaCommand = <T>(
  options: ISpectaCommandOptions,
  run: (context: { traceId: string }) => Promise<T>,
): Promise<T> =>
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
      const invocation = run({ traceId });
      invocation.catch(() => undefined);
      const output = await raceWithTimeoutAndAbort(invoc