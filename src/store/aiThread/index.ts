/* ============================================================================
 * aiThread store（双轨期薄层，ADR-0013 / ADR-0014 Step 3）
 *
 * 双轨原则：旧 `aiConversation` store 始终权威（持久化/标题/活动线程），
 * 本 store 仅在其上提供面向渲染层的 `IAiThread`（entries 模型）投影。
 * 本步只读投影；Step 5 起，流式进行中改由 reduceThread 驱动 `liveThread`
 * 覆盖投影。本 store 不修改旧 store，未接线前零行为变化。
 * ========================================================================== */
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';

import { useAiConversationStore } from '@/store/aiConversation';
import { legacyThreadToThread } from '@/store/aiThread/legacy-adapter';
import { restoreAttachmentPreviewPointers } from '@/store/plugins/debouncedPersistStorage';
import type { IAiThread, IAiThreadEntry } from '@/types/ai/thread';

export const useAiThreadStore = defineStore('ai-thread', () => {
  const conversation = useAiConversationStore();

  /**
   * 双轨期开关：渲染层据此在「旧 messages 路径」与「新 entries 路径」之间切换。
   * Step 8 收敛后移除。
   */
  const renderFromEntries = ref(true);

  /**
   * 活动流式线程：Step 5 起由边车监听 -> reduceThread 写入。为 null 时回落
   * 到对旧 active thread 的只读投影。
   */
  const liveThread = ref<IAiThread | null>(null);

  /* ----- 7.5b 持久化/迁移读侧（Step 7 dual-read） --------------------------
   * 启动迁移把旧 key 投影/救援出的 entries 线程灌入这里（见 7.5c 接线），
   * 作为 legacy 投影之上、liveThread 之下的优先回退来源。
   * 附件预览指针按「活动线程切换」惰性恢复，复用 restoreAttachmentPreviewPointers。
   * ----------------------------------------------------------------------- */
  const persistedThreads = ref<IAiThread[]>([]);
  const persistedActiveThreadId = ref<string | null>(null);

  /** 已完成指针惰性恢复的线程 id（去重；换库时清空）。 */
  const restoredThreadIds = new Set<string>();

  const persistedActiveThread = computed<IAiThread | null>(() => {
    const id = persistedActiveThreadId.value;
    if (!id) return null;
    return persistedThreads.value.find((thread) => thread.id === id) ?? null;
  });

  /**
   * 惰性恢复指定持久化线程的附件预览指针（idb:// → base64）。
   * - 每线程每会话最多一次（restoredThreadIds 去重，同步登记防并发重入）。
   * - await 期间数组可能被替换：回写前按 id 重定位并校验对象身份未变，
   *   避免覆盖更新的快照（不可变 splice 回写，与 7.5a 一致）。
   */
  async function restorePersistedThreadPointers(threadId: string): Promise<void> {
    if (restoredThreadIds.has(threadId)) return;
    const target = persistedThreads.value.find((thread) => thread.id === threadId);
    if (!target) return;
    restoredThreadIds.add(threadId);
    try {
      const { changed, value } = await restoreAttachmentPreviewPointers(target);
      if (!changed) return;
      const current = persistedThreads.value;
      const at = current.findIndex((thread) => thread.id === threadId);
      if (at < 0 || current[at] !== target) return;
      const next = current.slice();
      next[at] = value;
      persistedThreads.value = next;
    } catch {
      // 恢复失败非致命：指针保持 idb://，下游按缺图处理；允许后续重试。
      restoredThreadIds.delete(threadId);
    }
  }

  /** 活动持久化线程切换时触发惰性指针恢复。 */
  watch(
    persistedActiveThreadId,
    (id) => {
      if (id) void restorePersistedThreadPointers(id);
    },
    { immediate: false },
  );

  /** 把 legacy active thread 适配为 entries 模型（只读派生）。 */
  const projectedActiveThread = computed<IAiThread | null>(() =>
    conversation.activeThread ? legacyThreadToThread(conversation.activeThread) : null,
  );

  const activeThread = computed<IAiThread | null>(
    () => liveThread.value ?? projectedActiveThread.value ?? persistedActiveThread.value,
  );

  const activeEntries = computed<IAiThreadEntry[]>(() => activeThread.value?.entries ?? []);

  function setLiveThread(thread: IAiThread | null): void {
    liveThread.value = thread;
  }

  function setRenderFromEntries(value: boolean): void {
    renderFromEntries.value = value;
  }

  /**
   * 灌入启动迁移得到的持久化线程快照（见 7.5c 接线）。
   * 换库语义：替换整组线程并重置去重集；activeThreadId 由调用方传入
   * （通常为 7.5a resolver 归一后的活动线程 id）。同步 kick 活动线程指针恢复，
   * 覆盖「同 id 换库」watch 不触发的情形（去重保证不与 watch 重复恢复）。
   */
  function setPersistedThreads(threads: IAiThread[], activeThreadId: string | null): void {
    restoredThreadIds.clear();
    persistedThreads.value = threads;
    persistedActiveThreadId.value = activeThreadId;
    if (activeThreadId) void restorePersistedThreadPointers(activeThreadId);
  }

  /** 切换活动持久化线程（触发指针惰性恢复 watch）。 */
  function setPersistedActiveThreadId(activeThreadId: string | null): void {
    persistedActiveThreadId.value = activeThreadId;
  }

  return {
    // state
    renderFromEntries,
    liveThread,
    persistedThreads,
    persistedActiveThreadId,
    // getters
    projectedActiveThread,
    persistedActiveThread,
    activeThread,
    activeEntries,
    // actions
    setLiveThread,
    setRenderFromEntries,
    setPersistedThreads,
    setPersistedActiveThreadId,
  };
});

export * from '@/store/aiThread/events';
export * from '@/store/aiThread/legacy-adapter';
export * from '@/store/aiThread/reduce';
