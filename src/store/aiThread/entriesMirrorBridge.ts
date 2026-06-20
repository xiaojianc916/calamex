import type { IAiConversationThread } from '@/store/aiConversation';
import { projectConversationToThreadPersist } from '@/store/aiThread/project';
import { scheduleAiThreadEntriesPersist } from '@/store/plugins/aiThreadEntriesStorage';

/**
 * entries 双写桥接 (Step 7.4c)。
 *
 * 把 legacy 会话 store 与新 entries 镜像引擎/读 resolver 接起来, 但不在此处改变
 * 渲染 SoT (legacy 仍是显示来源)。所有外部副作用经 deps 注入, 默认指向真实单例,
 * 便于单测且与具体实现解耦。真实接线见 main.ts (Step 7.4d): 在 legacy hydrate 与读侧回退槽填充 (runStartupPersistedRead) 之后调用 installEntriesMirror, 故 entries 新 key当前处于双写 + 双读 soak 阶段 (legacy 持久化仍权威, 渲染 SoT 不变)。
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
}

const defaultDeps: IEntriesMirrorDeps = {
  schedulePersist: scheduleAiThreadEntriesPersist,
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
