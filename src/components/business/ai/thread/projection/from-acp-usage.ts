import type { IAiLanguageModelUsage } from '@/types/ai';
import { aiLanguageModelUsageSchema } from '@/types/ai/schema';

/**
 * ACP 回合用量 ACL（ADR-20260617 · D7-⑦）。
 *
 * 把 ACP usage_update 的原始 usage 对象（逐字透传、形状 unknown）归一到共享
 * IAiLanguageModelUsage VM。直接复用 ai.schema 的 aiLanguageModelUsageSchema 做 safeParse
 * （与 done.usage 同一 SoT，杜绝双 SoT 与手搓字段映射）：成功返回 strip 掉未声明字段后的
 * 用量；失败（缺 inputTokens/outputTokens/totalTokens 或类型不符 / 非对象）一律返回 null，
 * 调用方据此忽略本次更新，不抛错、不伪造零值。
 */
export const parseAcpUsage = (raw: unknown): IAiLanguageModelUsage | null => {
  const result = aiLanguageModelUsageSchema.safeParse(raw);
  return result.success ? result.data : null;
};
