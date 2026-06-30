/* ============================================================================
 * 权威 entries → 持久化镜像（ADR-0014 Step 8 ④.1 / §A）
 *
 * entriesMirrorBridge 的「权威版」：当持久化 SoT 从 legacy aiConversation 切换到
 * aiThread store 的权威 entries 状态后，由本模块把权威线程投影为 IAiThreadPersist
 * 并写入 entries 新 key。与 entriesMirrorBridge 对称：副作用经 deps 注入，默认绑定
 * 真实镜像引擎，便于单测且与实现解耦。
 *
 * 与读路径 resolver 的对称：authoritative 状态已是 entries 模型（IAiThread[]），无需
 * legacy→entries 投影，仅做信封封装 + activeThreadId 归一（复用 normalizeActiveThreadId，
 * 与读路径 resolver 对称，保证 project→parse→resolve 往返一致）。
 *
 * 接线见 main.ts（§C）：在 runStartupPersistedRead 灌入权威线程之后安装，避免首帧
 * 空态镜像覆盖磁盘历史。
 * ========================================================================== */
import { normalizeActiveThreadId } from '@/store/aiThread/hydrate';
import { scheduleAiThreadEntriesPersist } from '@/store/plugins/aiThreadEntriesStorage';
import type { IAiThread } from '@/types/ai/thread';
import { AI_THREAD_PERSIST_VERSION, type IAiThreadPersist } from '@/types/ai/thread/persist.schema';

/** 镜像所需的 aiThread store 最小形状（便于注入假 store 测试）。 */
export interface IAuthoritativeStoreLike {
  authoritativeThreads: IAiThread[];
  authoritativeActiveThreadId: string | null;
  $subscribe: (callback: () => void) => unknown;
}

/** 可注入副作用（默认绑定真实镜像引擎）。 */
export interface IAuthoritativeEntriesMirrorDeps {
  schedulePersist: (value: string) => void;
}

const defaultDeps: IAuthoritativeEntriesMirrorDeps = {
  schedulePersist: scheduleAiThreadEntriesPersist,
};

/** 权威状态（已是 entries 模型）→ 持久化信封；version 取当前版本，activeThreadId 归一。 */
export const projectAuthoritativeToThreadPersist = (input: {
  activeThreadId: string | null;
  threads: IAiThread[];
}): IAiThreadPersist => ({
  version: AI_THREAD_PERSIST_VERSION,
  activeThreadId: normalizeActiveThreadId(input.activeThreadId, input.threads),
  threads: input.threads,
});

/** 投影当前权威状态为 entries 快照并入双写队列。 */
export const mirrorAuthoritativeToEntries = (
  store: IAuthoritativeStoreLike,
  deps: IAuthoritativeEntriesMirrorDeps = defaultDeps,
): void => {
  const snapshot = projectAuthoritativeToThreadPersist({
    activeThreadId: store.authoritativeActiveThreadId,
    threads: store.authoritativeThreads,
  });
  deps.schedulePersist(JSON.stringify(snapshot));
};

/**
 * 安装权威镜像：立即镜像一次当前状态，并订阅后续变更继续镜像。
 * 返回取消订阅句柄（供卸载/回退）。
 */
export const installAuthoritativeEntriesMirror = (
  store: IAuthoritativeStoreLike,
  deps: IAuthoritativeEntriesMirrorDeps = defaultDeps,
): (() => void) => {
  mirrorAuthoritativeToEntries(store, deps);
  const stop = store.$subscribe(() => {
    mirrorAuthoritativeToEntries(store, deps);
  });
  return typeof stop === 'function' ? (stop as () => void) : () => {};
};
