import type { IAiConversationThread } from '@/store/aiConversation';
import { type IResolvedPersistedThreads, resolvePersistedThreads } from '@/store/aiThread/hydrate';
import { projectConversationToThreadPersist } from '@/store/aiThread/project';
import {
  hydrateAiThreadEntriesSnapshot,
  scheduleAiThreadEntriesPersist,
} from '@/store/plugins/aiThreadEntriesStorage';

/**
 * entries 双写桥接 (Step 7.4c)。
 *
 * 把 legacy 会话 store 与新 entries 镜像引擎/读 resolver 接起来, 但不在此处改变
 * 渲染 SoT (legacy 仍是显示来源)。所有外部副作用经 deps 注入, 默认指向真实单例,
 * 便于单测且与具体实现解耦。真实接线 (main.ts) 留待 7.4d; 本模块当前未被引用。
 */

/** 桥所需的会话 store 最小形状 (便于注入假 store 测试)。 */
export interface IConversationStoreLike {
  activeThreadId: string | null;
  threads: IAiConversationThread[];
  $subscribe: (callback: () => void) => unknown;
}

/** 可注入副作用 (默认绑定真实镜像引擎)。 */
export interface IEntriesMirrorDeps {
  schedulePersist: (value: string) => void;
  hydrateSnapshot: () => Promise<{ raw: string | null }>;
}

const defaultDeps: IEntriesMirrorDeps = {
  schedulePersist: scheduleAiThreadEntriesPersist,
  hydrateSnapshot: hydrateAiThreadEntriesSnapshot,
};

const parseRawEntriesSnapshot = (raw: string | null): unknown => {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};

/** 投影当前 store 状态为 entries 快照并入双写队列。 */
export const mirrorConversationToEntries = (
  store: IConversationStoreLike,
  deps: IEntriesMirrorDeps = defaultDeps,
): void => {
  const snapshot = projectConversationToThreadPersist({
    activeThreadId: store.activeThreadId,
    threads: store.threads,
  });
  deps.schedulePersist(JSON.stringify(snapshot));
};

/**
 * 读取新 key 快照并经 7.3 resolver 解析 (读路径自检)。
 * 新 key 有效 → source 'entries'; 否则回退到 legacy 投影。结果供 7.4d/7.5 接入,
 * 当前不改变渲染 SoT。
 */
export const resolveMirrorOnHydrate = async (
  store: IConversationStoreLike,
  deps: IEntriesMirrorDeps = defaultDeps,
): Promise<IResolvedPersistedThreads> => {
  const { raw } = await deps.hydrateSnapshot();
  return resolvePersistedThreads({
    rawEntriesSnapshot: parseRawEntriesSnapshot(raw),
    legacyActiveThreadId: store.activeThreadId,
    legacyThreads: store.threads,
  });
};

/**
 * 安装双写镜像: 立即镜像一次当前状态, 并订阅后续 store 变更继续镜像。
 * 返回取消订阅句柄 (供卸载/回退)。
 */
export const installEntriesMirror = (
  store: IConversationStoreLike,
  deps: IEntriesMirrorDeps = defaultDeps,
): (() => void) => {
  mirrorConversationToEntries(store, deps);
  const stop = store.$subscribe(() => {
    mirrorConversationToEntries(store, deps);
  });
  return typeof stop === 'function' ? (stop as () => void) : () => {};
};
