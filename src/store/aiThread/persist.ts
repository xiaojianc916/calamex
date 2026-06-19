import type { IAiThread } from '@/types/ai/thread';
import { aiThreadEntrySchema, aiThreadSchema } from '@/types/ai/thread';

/* ============================================================================
 * Entries 持久化逐条救援（ADR-0014 Step 7.1）
 *
 * 等价搬运 aiConversation 的 salvageHydratedThreads 容错思路到 entries 模型：
 * 严格 parse 失败后，逐线程 / 逐 entry safeParse —
 * - 单条 entry 不合法 → 仅丢弃该 entry，保留同线程其余 entries；
 * - 线程元信息(id/title/时间戳)不合法 → 丢弃该线程，保留其余线程；
 * - 至少救回一个线程即返回；全部不可救援才返回 null（交回 legacy / 兜底）。
 * 绝不因单条坏数据清空整库。
 *
 * 纯函数、无 I/O、无 Vue/store 依赖，可在 Node 单测中独立运行。
 * 仅供 Step 7.3 在严格 parse 失败后作为兜底调用；本步未接线，故零行为变化。
 * ========================================================================== */

/** 救援结果运行时形状（不含 version；版本戳由调用方在归一化阶段补齐）。 */
export interface IAiThreadPersistShape {
  activeThreadId: string | null;
  threads: IAiThread[];
}

/**
 * 逐线程 / 逐 entry 救援一份 entries 持久化快照。
 *
 * 仅在严格 aiThreadPersistSchema parse 失败后作为兜底调用；parse 成功路径不变。
 */
export function salvageHydratedThreadEntries(
  rawThreads: unknown,
  rawActiveThreadId: unknown,
): IAiThreadPersistShape | null {
  if (!Array.isArray(rawThreads)) {
    return null;
  }
  const threads = rawThreads.flatMap((rawThread): IAiThread[] => {
    if (typeof rawThread !== 'object' || rawThread === null) {
      return [];
    }
    const candidate = rawThread as Record<string, unknown>;
    const rawEntries = Array.isArray(candidate.entries) ? candidate.entries : [];
    // 逐条救援: 保留可通过校验的 entry, 丢弃异常单条, 避免一条坏数据牵连整线程。
    const entries = rawEntries.flatMap((rawEntry) => {
      const parsed = aiThreadEntrySchema.safeParse(rawEntry);
      return parsed.success ? [parsed.data] : [];
    });
    // 用线程 schema 校验元信息; entries 已替换为救援后的合法集合。
    const parsedThread = aiThreadSchema.safeParse({ ...candidate, entries });
    return parsedThread.success ? [parsedThread.data] : [];
  });
  if (threads.length === 0) {
    return null;
  }
  const activeThreadId =
    typeof rawActiveThreadId === 'string' && rawActiveThreadId.trim().length > 0
      ? rawActiveThreadId
      : null;
  return { activeThreadId, threads };
}
