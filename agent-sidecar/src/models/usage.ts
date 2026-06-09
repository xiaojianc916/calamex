import { z } from 'zod';

/**
 * 语言模型 token 用量契约（canonical / 单一真相源）。
 *
 * 这是「模型侧 token 计量」的唯一定义来源：
 * - 运行时用量快照 `IAgentTokenUsageSnapshot`（engines/contracts/runtime-contracts.ts）
 *   以 `usage?: TLanguageModelUsage | null` 引用它；
 * - 流式聚合 `aggregateDoneTokenSnapshot` / `parseDoneTokenSnapshot`
 *   （engines/stream/stream-utils.ts）按此形状装配；
 * - ACP egress 将其投影为 `session/update` 的 `usage_update`（acp/usage.ts）。
 *
 * 历史：此契约此前内联在 `schemas/events.ts`（sidecar → UI 的 wire schema）。随着
 * ACP 原生重写淘汰该 wire schema，用量契约作为「幸存类型」上移到 `models/`，与模型
 * 配置 / 能力（config.ts / capabilities.ts）同域，避免被即将删除的事件 schema 文件
 * 挟持，也让 token 计量在领域上归位到「模型」而非「UI 事件」。
 *
 * 严格模式：未知字段不 passthrough；任何未来扩展一律走 `raw` 信封。
 */
export const languageModelUsageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  inputTokenDetails: z
    .object({
      noCacheTokens: z.number().nonnegative(),
      cacheReadTokens: z.number().nonnegative(),
      cacheWriteTokens: z.number().nonnegative(),
    })
    .strict()
    .optional(),
  outputTokens: z.number().nonnegative(),
  outputTokenDetails: z
    .object({
      textTokens: z.number().nonnegative(),
      reasoningTokens: z.number().nonnegative(),
    })
    .strict()
    .optional(),
  totalTokens: z.number().nonnegative(),
  // 与 inputTokenDetails.cacheReadTokens 等价 —— 优先用 inputTokenDetails。
  // 兼容旧 caller。
  cachedInputTokens: z.number().nonnegative().optional(),
  reasoningTokens: z.number().nonnegative().optional(),
  raw: z.unknown().optional(),
}).strict();

export type TLanguageModelUsage = z.infer<typeof languageModelUsageSchema>;
