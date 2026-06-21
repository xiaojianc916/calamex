/* ============================================================================
 * 启动持久化读侧接线（ADR-0014 Step 7.5c）
 *
 * 启动后台读新 entries key 并经 7.5a 组合器归一，把结果灌入 aiThread store
 * （ADR-0014 Step 8 后直接灌权威 entries 线程，见 main.ts）。
 *
 * 历史顺序约束（已解除）：legacy aiConversation hydrate 随 ADR-0014 Step 8 删除，
 * 生产 readLegacy 返回空，entries key 为唯一持久化真源；DI 缝仍保留 legacy 回退形状
 * 供单测注入（entries key 为空/损坏时回退到注入的 legacy 线程，验证「迁移失败不致空白」）。
 *
 * 依赖注入：默认 deps 在调用时惰性取 store（需 pinia 已安装）；单测注入假 deps，
 * 无需 pinia / 真实存储。
 * ========================================================================== */
import { useAiThreadStore } from '@/store/aiThread';
import {
  hydrateAiThreadEntriesForRender,
  type IHydrateAiThreadEntriesForRenderInput,
} from '@/store/aiThread/entriesRenderHydrate';
import type { IResolvedPersistedThreads } from '@/store/aiThread/hydrate';
import type { IAiThread } from '@/types/ai/thread';

export interface IRunStartupPersistedReadDeps {
  /** 取旧 key 已 hydrate 的活动线程 id 与线程列表（entries 缺失时的回退源）。 */
  readLegacy: () => IHydrateAiThreadEntriesForRenderInput;
  /** 7.5a 组合器：读新 key 快照 -> 归一 -> 活动线程指针恢复。 */
  hydrateForRender: (
    input: IHydrateAiThreadEntriesForRenderInput,
  ) => Promise<IResolvedPersistedThreads>;
  /** 把归一结果灌入 aiThread store 持久化回退槽。 */
  applyPersisted: (threads: IAiThread[], activeThreadId: string | null) => void;
}

export const defaultDeps: IRunStartupPersistedReadDeps = {
  // legacy aiConversation store 已退役：迁移已完成，新 entries key 为唯一持久化真源。
  // 保留 readLegacy 形状（DI 缝与单测仍可注入 legacy 回退），生产默认不再提供 legacy 源。
  readLegacy: () => ({ legacyActiveThreadId: null, legacyThreads: [] }),
  hydrateForRender: hydrateAiThreadEntriesForRender,
  applyPersisted: (threads, activeThreadId) => {
    useAiThreadStore().setPersistedThreads(threads, activeThreadId);
  },
};

/**
 * 执行一次启动持久化读：legacy 快照 -> entries 归一 -> 灌入回退槽。
 * 抛错交由调用方（main.ts 后台 hydrate 链）统一吞掉并告警，不阻断启动。
 */
export async function runStartupPersistedRead(
  deps: IRunStartupPersistedReadDeps = defaultDeps,
): Promise<void> {
  const { legacyActiveThreadId, legacyThreads } = deps.readLegacy();
  const resolved = await deps.hydrateForRender({ legacyActiveThreadId, legacyThreads });
  deps.applyPersisted(resolved.threads, resolved.activeThreadId);
}
