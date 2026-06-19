import type { IAiConversationThread } from '@/store/aiConversation';
import { normalizeActiveThreadId } from '@/store/aiThread/hydrate';
import { legacyThreadToThread } from '@/store/aiThread/legacy-adapter';
import type { IAiThread } from '@/types/ai/thread';
import { AI_THREAD_PERSIST_VERSION, type IAiThreadPersist } from '@/types/ai/thread/persist.schema';

// ---------------------------------------------------------------------------
// 写侧投影 (7.3 读 resolver 的对称砖)
//
// 把 legacy 会话状态 (activeThreadId + IAiConversationThread[]) 投影成新 entries
// 持久化形状 IAiThreadPersist。供后续 7.4b 双写新 key 时序列化使用。
//
// 设计取舍 (质量优先):
// - 忠实 1:1 镜像: 不在此处做 history-limit / 空线程过滤, 避免与读路径 (resolver)
//   产生不对称, 保证 project → parse → resolvePersistedThreads 往返一致。
// - 复用既有单一来源: 线程映射走 legacyThreadToThread, active 归一走 7.3 的
//   normalizeActiveThreadId, 不重复实现。
// - 纯函数: 无 idb / 无 async / 无 store 依赖, 完全可单测。
// ---------------------------------------------------------------------------

export interface IProjectConversationInput {
  activeThreadId: string | null;
  threads: IAiConversationThread[];
}

/** 逐线程把 legacy 会话线程投影为 entries 线程, 保持顺序。 */
export const projectConversationThreadsToEntries = (
  threads: IAiConversationThread[],
): IAiThread[] => threads.map(legacyThreadToThread);

/**
 * 把 legacy 会话状态投影成 IAiThreadPersist。
 * 产出对 aiThreadPersistSchema 恒为合法 (version 取当前版本, activeThreadId 归一)。
 */
export const projectConversationToThreadPersist = (
  input: IProjectConversationInput,
): IAiThreadPersist => {
  const threads = projectConversationThreadsToEntries(input.threads);
  return {
    version: AI_THREAD_PERSIST_VERSION,
    activeThreadId: normalizeActiveThreadId(input.activeThreadId, threads),
    threads,
  };
};
