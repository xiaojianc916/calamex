import type { IAiConversationThread } from '@/store/aiConversation';
import { legacyThreadToThread } from '@/store/aiThread/legacy-adapter';
import { salvageHydratedThreadEntries } from '@/store/aiThread/persist';
import type { IAiThread } from '@/types/ai/thread';
import { aiThreadPersistSchema } from '@/types/ai/thread/persist.schema';

/* ============================================================================
 * Entries 持久化「读路径」解析器（ADR-0014 Step 7.3）
 *
 * 统一编码 hydrate 时「该用哪份数据」的优先级决策，纯函数、无 I/O、无 store 依赖：
 *   1) 新 key（entries 信封）严格 aiThreadPersistSchema 解析成功 → 直接采用（权威）；
 *   2) 新 key 存在但严格解析失败 → salvageHydratedThreadEntries 逐条救援；
 *   3) 新 key 缺失 / 不可救援 → 回退旧 key（legacy messages），按线程 legacyThreadToThread
 *      懒投影为 entries（迁移期旧 key 仍作非破坏式备份保留）；
 *   4) 都没有 → 空态。
 *
 * activeThreadId 一律经 normalize 校正：指向不存在的线程时落到首个线程，空库则为 null。
 *
 * 注意：本模块尚未被任何地方 import（接线在 Step 7.4 的异步预热 hydrate + 双写完成），
 * 故对运行时行为零影响。旧 aiConversation store 仍是唯一权威，渲染仍走既有投影。
 * ========================================================================== */

/** 命中的数据来源，便于接线层打点 / 灰度观测。 */
export type TPersistedThreadsSource = 'entries' | 'entries-salvaged' | 'legacy' | 'empty';

export interface IResolvedPersistedThreads {
  source: TPersistedThreadsSource;
  activeThreadId: string | null;
  threads: IAiThread[];
}

export interface IResolvePersistedThreadsInput {
  /** 新 key（entries 信封）原始快照；缺失传 null / undefined。 */
  rawEntriesSnapshot: unknown;
  /** 旧 key 已 hydrate 的 activeThreadId（回退用）。 */
  legacyActiveThreadId: string | null;
  /** 旧 key 已 hydrate / 已救援的 legacy 线程（回退用）。 */
  legacyThreads: IAiConversationThread[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** activeThreadId 必须指向现存线程；否则落到首个线程（空库为 null）。 */
export function normalizeActiveThreadId(
  activeThreadId: string | null,
  threads: IAiThread[],
): string | null {
  if (threads.length === 0) {
    return null;
  }
  if (activeThreadId && threads.some((thread) => thread.id === activeThreadId)) {
    return activeThreadId;
  }
  return threads[0].id;
}

export function resolvePersistedThreads(
  input: IResolvePersistedThreadsInput,
): IResolvedPersistedThreads {
  const { rawEntriesSnapshot, legacyActiveThreadId, legacyThreads } = input;

  // 1) + 2) 新 key 存在才尝试 entries 路径（区分「不存在」与「存在但空/坏」）。
  if (rawEntriesSnapshot != null) {
    const strict = aiThreadPersistSchema.safeParse(rawEntriesSnapshot);
    if (strict.success) {
      // 严格成功即权威，即使 threads 为空也尊重（用户已清空，不复活 legacy）。
      return {
        source: 'entries',
        activeThreadId: normalizeActiveThreadId(strict.data.activeThreadId, strict.data.threads),
        threads: strict.data.threads,
      };
    }
    if (isRecord(rawEntriesSnapshot)) {
      const salvaged = salvageHydratedThreadEntries(
        rawEntriesSnapshot.threads,
        rawEntriesSnapshot.activeThreadId,
      );
      if (salvaged) {
        return {
          source: 'entries-salvaged',
          activeThreadId: normalizeActiveThreadId(salvaged.activeThreadId, salvaged.threads),
          threads: salvaged.threads,
        };
      }
    }
    // 新 key 存在但无法解析 / 救援：落到 legacy 兜底（非破坏式，旧 key 仍在）。
  }

  // 3) 回退 legacy messages → entries 投影（懒迁移）。
  if (legacyThreads.length > 0) {
    const threads = legacyThreads.map(legacyThreadToThread);
    return {
      source: 'legacy',
      activeThreadId: normalizeActiveThreadId(legacyActiveThreadId, threads),
      threads,
    };
  }

  // 4) 空态。
  return { source: 'empty', activeThreadId: null, threads: [] };
}
