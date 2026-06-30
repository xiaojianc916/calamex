/* ============================================================================
 * 启动持久化读侧接线（ADR-0014 Step 7.5c）
 *
 * 启动后台读新 entries key 并经 7.5a 组合器归一，把结果灌入 aiThread store
 * （ADR-0014 Step 8 后直接灌权威 entries 线程，见 main.ts）。entries key 为唯一
 * 持久化真源（legacy aiConversation 迁移读侧已随 ADR-0014 Step 8 拆除）。
 *
 * 依赖注入：默认 deps 在调用时惰性取 store（需 pinia 已安装）；单测注入假 deps，
 * 无需 pinia / 真实存储。
 * ========================================================================== */
import { useAiThreadStore } from '@/store/aiThread';
import { hydrateAiThreadEntriesForRender } from '@/store/aiThread/entriesRenderHydrate';
import type { IResolvedPersistedThreads } from '@/store/aiThread/hydrate';
import type { IAiThread } from '@/types/ai/thread';

export interface IRunStartupPersistedReadDeps {
  /** 7.5a 组合器：读新 key 快照 -> 归一 -> 活动线程指针恢复。 */
  hydrateForRender: () => Promise<IResolvedPersistedThreads>;
  /** 把归一结果灌入 aiThread store 持久化回退槽。 */
  applyPersisted: (threads: IAiThread[], activeThreadId: string | null) => void;
}

export const defaultDeps: IRunStartupPersistedReadDeps = {
  hydrateForRender: hydrateAiThreadEntriesForRender,
  applyPersisted: (threads, activeThreadId) => {
    useAiThreadStore().setPersistedThreads(threads, activeThreadId);
  },
};

/**
 * 执行一次启动持久化读：entries 归一 -> 灌入回退槽。
 * 抛错交由调用方（main.ts 后台 hydrate 链）统一吞掉并告警，不阻断启动。
 */
export async function runStartupPersistedRead(
  deps: IRunStartupPersistedReadDeps = defaultDeps,
): Promise<void> {
  const resolved = await deps.hydrateForRender();
  deps.applyPersisted(resolved.threads, resolved.activeThreadId);
}
