import { callSpectaCommand } from './ipc-runtime';
import type { IIpcCallOptions, IPayloadMetrics, TErrorMap, TIpcAuditLevel } from './ipc-types';

/**
 * 单条 Tauri 命令的声明式包装元数据：把 command / guardHint / timeout / audit /
 * measureInput / measureOutput / errorMap 等固定字段集中为「可审计的常量表」，
 * 供 runCommand 统一驱动 callSpectaCommand。
 */
export interface ICommandMeta {
  /** 后端 tauri 命令名，用于审计日志。 */
  command: string;
  /** 非桌面运行时下抛错用的提示文案。 */
  guardHint: string;
  /** 是否幂等（影响审计日志标记）。 */
  idempotent?: boolean;
  /** 前端调用预算超时；缺省走 TAURI_IPC_DEFAULT_TIMEOUT_MS。 */
  timeoutMs?: number;
  /** 审计级别；缺省 'info'。 */
  audit?: TIpcAuditLevel;
  /** 自定义入参字节度量（用于审计），缺省按 JSON 估算。 */
  measureInput?: (input: Record<string, unknown>) => IPayloadMetrics;
  /** 自定义出参字节度量（用于审计），缺省按 JSON 估算。 */
  measureOutput?: (output: unknown) => IPayloadMetrics;
  /** 错误信息到 AppError code 的映射。 */
  errorMap?: TErrorMap;
}

/**
 * 以声明式 metadata 驱动单次 IPC 调用。
 *
 * - `meta`：命令的固定包装语义（见 {@link ICommandMeta}）。
 * - `input`：仅用于审计时的入参字节度量，通常即命令入参对象。
 * - `options`：调用方透传的 AbortSignal 等。
 * - `invoke`：具体的 tauri-specta 绑定闭包。命令名与位置参数各命令不同，无法泛化，
 *   故由调用方提供（这也是本文件不做成「一行 define 自动生成」的原因）。
 *   闭包会收到本次调用的插桩上下文 `{ traceId }`，供需要把 traceId 透传给后端绑定
 *   （如 webview/window 命令的第二个位置参数）的命令使用；无需该参数的命令可忽略。
 */
export const runCommand = <T>(
  meta: ICommandMeta,
  input: unknown,
  options: IIpcCallOptions | undefined,
  invoke: (context: { traceId: string }) => Promise<T>,
): Promise<T> =>
  callSpectaCommand<T>(
    {
      command: meta.command,
      guardHint: meta.guardHint,
      idempotent: meta.idempotent,
      timeoutMs: meta.timeoutMs,
      audit: meta.audit,
      measureInput: meta.measureInput,
      measureOutput: meta.measureOutput,
      errorMap: meta.errorMap,
      input,
      signal: options?.signal,
    },
    invoke,
  );
