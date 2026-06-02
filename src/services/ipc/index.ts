import type { z } from 'zod';
import { defineIpc, type IIpcCallOptions, type TIpcAuditLevel } from '@/services/tauri';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * 仅保留对象中值不为 `undefined` 的键。
 *
 * 用于兼容 tsconfig 的 `exactOptionalPropertyTypes: true`——避免把
 * `{ timeoutMs: undefined }` 显式向下游 spread,误盖下游(此处是
 * `defineIpc`)自身的默认值。
 */
const pickDefined = <T extends Record<string, unknown>>(obj: T): Partial<T> => {
  const result: Partial<T> = {};
  for (const key of Object.keys(obj) as Array<keyof T>) {
    const value = obj[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * `ipc()` 的配置项。
 *
 * 复用 `IIpcCallOptions` 暴露的运行时选项(`signal` 等),并在此扩展
 * 用于构造 `defineIpc` 描述符的 schema / 超时 / 审计 / mapArgs 字段。
 * 命名上未拆分两类是为了调用方使用方便——一个对象传完即可。
 */
export interface IIpcOptions<TInSchema extends z.ZodTypeAny> extends IIpcCallOptions {
  timeoutMs?: number;
  guardHint?: string;
  idempotent?: boolean;
  audit?: TIpcAuditLevel;
  mapArgs?: (
    input: z.output<TInSchema>,
    context: { traceId: string },
  ) => Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * IPC 模块化服务入口——给"一次性 / 低频调用"场景的便捷封装。
 *
 * 新增领域服务优先通过本函数复用 `services/tauri.ts` 的契约校验、超时、
 * 取消、traceId 与错误归一化能力,避免在模块内重新拼装裸 `invoke`。
 *
 * ## ⚠️ 性能注意
 *
 * 本函数每次调用都会重新执行 `defineIpc(...)`,重新构建描述符 /
 * closure / 内部校验状态。**不要在热路径中调用本函数**(终端输出推流、
 * 文件树遍历、高频轮询等)。
 *
 * 热路径正确写法:在模块顶层用 `defineIpc` 定义一次稳定的 call,然后
 * 反复调用 call 本身。
 *
 * ```ts
 * // ✅ 模块顶层
 * const callListWorkspaceFiles = defineIpc({
 *     name: 'list_workspace_files',
 *     inSchema: ListFilesInputSchema,
 *     outSchema: ListFilesOutputSchema,
 *     timeoutMs: 5_000,
 * });
 *
 * // ✅ 调用点
 * const files = await callListWorkspaceFiles(input, { signal });
 *
 * // ❌ 不要这样,每次都重新跑 defineIpc
 * const files = await ipc(
 *     'list_workspace_files',
 *     input,
 *     ListFilesInputSchema,
 *     ListFilesOutputSchema,
 *     { signal, timeoutMs: 5_000 },
 * );
 * ```
 */
export const ipc = async <TInSchema extends z.ZodTypeAny, TOutSchema extends z.ZodTypeAny>(
  command: string,
  input: z.input<TInSchema>,
  inputSchema: TInSchema,
  outputSchema: TOutSchema,
  options: IIpcOptions<TInSchema> = {},
): Promise<z.output<TOutSchema>> => {
  const call = defineIpc({
    name: command,
    guardHint: options.guardHint ?? command,
    inSchema: inputSchema,
    outSchema: outputSchema,
    ...pickDefined({
      timeoutMs: options.timeoutMs,
      idempotent: options.idempotent,
      audit: options.audit,
      mapArgs: options.mapArgs,
    }),
  });
  return call(input, pickDefined({ signal: options.signal }));
};
