/* ============================================================================
 * 启动持久化读侧接线（ADR-0014 Step 7.5c）
 *
 * 在启动后台 hydrate（旧 aiConversation key）完成后，再读新 entries key 并经
 * 7.5a 组合器归一，把结果灌入 aiThread store 的持久化回退槽（7.5b）。
 *
 * 顺序约束：必须在 hydrateAiConversationStorage() 之后调用，确保 legacy 回退源
 * （conversation.threads / activeThreadId）已就位；entries key 为空/损坏时，
 * 7.5a 会回退到这些 legacy 线程，保证「迁移失败不致空白」。
 *
 * 依赖注入：默认 deps 在调用时惰性取 store（需 pinia 已安装）；单测注入假 deps，
 * 无需 pinia / 真实存储。
 * ========================================================================== */
import { useAiConversationStore } from '@/store/aiConversation';
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
  readLegacy: () => {
    const conversation = useAiConversationStore();
    return {
      legacyActiveThreadId: conversation.activeThreadId,
      legacyThreads: conversation.threads,
    };
  },
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
