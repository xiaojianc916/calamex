/* ============================================================================
 * Entries 渲染 hydrate 组合器（ADR-0014 Step 7.5a）
 *
 * 把「读取新 key 原始快照 -> resolvePersistedThreads 归一 -> 活动线程附件预览
 * 指针即时恢复」编排为纯组合、可注入依赖的异步函数。
 *
 * 关键点：
 * - aiThreadEntriesStorage 的 hydrate 仅返回「原始 JSON 字符串」，不还原图片指针，
 *   故本层先 JSON.parse（坏 JSON 容错为 null，交由 resolver 回退空态），再交给
 *   纯函数 resolver 决策来源（entries / entries-salvaged / empty）。
 * - 仅对「活动线程」即时恢复附件预览指针（idb:// -> base64），保证首屏图片可见；
 *   其余线程留待 store 侧按活动线程切换惰性恢复（见 7.5b）。
 * - 恢复失败非致命：保留 idb:// 指针并返回未替换结果，下游按缺图处理。
 * ========================================================================== */

import {
  type IResolvedPersistedThreads,
  type IResolvePersistedThreadsInput,
  resolvePersistedThreads,
} from '@/store/aiThread/hydrate';
import {
  hydrateAiThreadEntriesSnapshot,
  type IAiThreadEntriesHydrateResult,
} from '@/store/plugins/aiThreadEntriesStorage';
import { restoreAttachmentPreviewPointers } from '@/store/plugins/attachmentPreviewStorage';
import type { IAiThread } from '@/types/ai/thread';

export interface IEntriesRenderHydrateDeps {
  loadSnapshot: () => Promise<IAiThreadEntriesHydrateResult>;
  resolve: (input: IResolvePersistedThreadsInput) => IResolvedPersistedThreads;
  restorePointers: (thread: IAiThread) => Promise<{ changed: boolean; value: IAiThread }>;
}

const defaultDeps: IEntriesRenderHydrateDeps = {
  loadSnapshot: hydrateAiThreadEntriesSnapshot,
  resolve: resolvePersistedThreads,
  restorePointers: restoreAttachmentPreviewPointers,
};

/** 原始快照是 JSON 字符串：解析失败容错为 null（resolver 据此回退空态）。 */
function parseEntriesSnapshot(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** 仅对活动线程即时恢复指针；不可变替换，失败非致命。 */
async function restoreActiveThreadPointers(
  resolved: IResolvedPersistedThreads,
  restorePointers: IEntriesRenderHydrateDeps['restorePointers'],
): Promise<IResolvedPersistedThreads> {
  const { activeThreadId, threads } = resolved;
  if (!activeThreadId) return resolved;
  const at = threads.findIndex((thread) => thread.id === activeThreadId);
  if (at < 0) return resolved;
  try {
    const { changed, value } = await restorePointers(threads[at]);
    if (!changed) return resolved;
    const nextThreads = threads.slice();
    nextThreads[at] = value;
    return { ...resolved, threads: nextThreads };
  } catch {
    return resolved;
  }
}

export async function hydrateAiThreadEntriesForRender(
  deps: IEntriesRenderHydrateDeps = defaultDeps,
): Promise<IResolvedPersistedThreads> {
  const snapshot = await deps.loadSnapshot();
  const resolved = deps.resolve({
    rawEntriesSnapshot: parseEntriesSnapshot(snapshot.raw),
  });
  return restoreActiveThreadPointers(resolved, deps.restorePointers);
}
