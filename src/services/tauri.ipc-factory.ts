import { z } from 'zod';
import { AppError } from '@/types/app-error';
import { assertDesktopRuntime } from '@/utils/platform/desktop-runtime';
import { buildPayloadMetrics, formatZodIssueSummary } from './tauri.ipc-metrics';
import {
  createCanceledError,
  invokeTauriCommand,
  normalizeInvokeArgs,
  raceWithTimeoutAndAbort,
  runInstrumentedIpc,
  TAURI_IPC_DEFAULT_TIMEOUT_MS,
} from './tauri.ipc-runtime';
import type { IDefineIpcOptions, IIpcCallOptions } from './tauri.ipc-types';

/**
 * 定义一个带运行时契约校验的 Tauri IPC 调用。
 * 统一处理输入/输出校验、超时、取消、审计日志与错误归一。
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
          const outputMetrics = options.measureOutput
            ? options.measureOutput(parsedOutput.data)
            : buildPayloadMetrics(rawOutput);
          reportOutputBytes(outputMetrics.bytes);
        }

        return parsedOutput.data;
      },
    );
};
