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
import type { TAiThreadReduceEvent } from '@/store/aiThread/events';
import { legacyThreadToThread } from '@/store/aiThread/legacy-adapter';
import { selectRenderThread } from '@/store/aiThread/render-authority';
import * as threadMutations from '@/store/aiThread/thread-mutations';
import { restoreAttachmentPreviewPointers } from '@/store/plugins/debouncedPersistStorage';
import type { IAiThread, IAiThreadEntry } from '@/types/ai/thread';

export const useAiThreadStore = defineStore('ai-thread', () => {
  const conversation = useAiConversationStore();

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

  /**
   * Step 8 砖3③：流式写真源 → 权威 entries 覆盖。
   * 把本回合 reduce 回放得到的 IAiThread（buildLiveThreadFromSidecarEvents =
   * reduceThreadAll 纯回放）作为权威活动线程覆盖，使 renderActiveThread 优先渲染
   * 权威 entries。thread 为 null 表示本回合收尾：复位为单空线程，渲染回落到响应式
   * legacy 投影（activeThread）。与既有 liveThread 覆盖机制按构造等价
   * （selectRenderThread：非空权威胜出，否则回退），故零行为变化。
   */
  function setStreamingActiveThread(thread: IAiThread | null): void {
    if (!thread) {
      commitAuthoritativeState(threadMutations.ensureActiveThread(null, []));
      return;
    }
    commitAuthoritativeState(
      threadMutations.commitThreadsState({ threads: [thread], activeThreadId: thread.id }),
    );
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

  /* ====================================================================
   * Step 8 砖2b：entries 权威读写真源（thread-mutations 纯函数核之上的薄壳）
   *
   * 在既有「只读投影」之外，新增一组以 entries 为真源的权威线程状态 + 读写
   * actions，全部委托 thread-mutations 纯函数核。本步「只落地、未接线」：
   *   - 不改 activeThread / activeEntries 渲染权威（仍 liveThread ?? 投影 ?? 持久化）；
   *   - 不接管持久化（仍由 aiConversation + entriesMirror 负责）；
   *   - 无任何上层调用以下新 state / actions。
   * 故本步零行为变化；写路径 / 渲染权威 / 持久化归属切换统一在砖3 完成。
   *
   * 滚动节流（pendingScrollStates + timer）按 legacy aiConversation 的 store 层
   * 语义等价搬运到本层，使砖3 接线为纯连线、无行为漂移。
   * ================================================================== */

  // 初始权威状态：与 legacy 一致，启动即持有一个空线程（ensureActiveThread 兜底）。
  const initialAuthoritativeState = threadMutations.ensureActiveThread(null, []);
  const authoritativeThreads = ref<IAiThread[]>(initialAuthoritativeState.threads);
  const authoritativeActiveThreadId = ref<string | null>(initialAuthoritativeState.activeThreadId);

  const authoritativeActiveThread = computed<IAiThread | null>(
    () =>
      authoritativeThreads.value.find(
        (thread) => thread.id === authoritativeActiveThreadId.value,
      ) ?? null,
  );
  const authoritativeActiveEntries = computed<IAiThreadEntry[]>(
    () => authoritativeActiveThread.value?.entries ?? [],
  );
  const authoritativeHistoryThreads = computed<IAiThread[]>(() =>
    authoritativeThreads.value.filter((thread) => thread.entries.length > 0),
  );
  const authoritativeHasEntries = computed<boolean>(
    () => authoritativeActiveEntries.value.length > 0,
  );

  /* ----- Step 8 砖3①：渲染权威（authoritative 优先，legacy 投影回退，未接线）-----
   * 渲染层当前仍读 activeThread / activeEntries；砖3② 才把 Panel 渲染来源切到此。
   * authoritative 持有 entries 时以其为渲染真源，否则回退既有 liveThread ?? 投影
   * ?? 持久化 链路，保证写路径接管前逐线程零行为变化。
   */
  const renderActiveThread = computed<IAiThread | null>(() =>
    selectRenderThread(authoritativeActiveThread.value, activeThread.value),
  );
  const renderActiveEntries = computed<IAiThreadEntry[]>(
    () => renderActiveThread.value?.entries ?? [],
  );

  const readAuthoritativeState = (): threadMutations.IAiThreadState => ({
    threads: authoritativeThreads.value,
    activeThreadId: authoritativeActiveThreadId.value,
  });

  const commitAuthoritativeState = (next: threadMutations.IAiThreadState): void => {
    authoritativeThreads.value = next.threads;
    authoritativeActiveThreadId.value = next.activeThreadId;
  };

  /* ----- 滚动状态节流（等价搬运自 legacy aiConversation 的 store 层实现）----- */
  const pendingScrollStates = new Map<string, threadMutations.IAiThreadScrollState>();
  let scrollStateSaveTimer: ReturnType<typeof setTimeout> | null = null;

  const clearScrollStateSaveTimer = (): void => {
    if (scrollStateSaveTimer !== null) {
      clearTimeout(scrollStateSaveTimer);
      scrollStateSaveTimer = null;
    }
  };

  /**
   * flush 缓冲的滚动状态：纯核 setThreadScrollState 已内置归一化 + 等值短路，
   * 逐条折叠即得与 legacy 批量提交等价的最终状态。
   */
  function flushPendingScrollStateUpdates(): void {
    clearScrollStateSaveTimer();
    if (pendingScrollStates.size === 0) {
      return;
    }
    const updates = Array.from(pendingScrollStates.entries());
    pendingScrollStates.clear();
    const nextState = updates.reduce<threadMutations.IAiThreadState>(
      (state, [threadId, scrollState]) =>
        threadMutations.setThreadScrollState(state, threadId, scrollState),
      readAuthoritativeState(),
    );
    commitAuthoritativeState(nextState);
  }

  const scheduleScrollStateSave = (): void => {
    if (scrollStateSaveTimer !== null) {
      return;
    }
    scrollStateSaveTimer = setTimeout(() => {
      scrollStateSaveTimer = null;
      flushPendingScrollStateUpdates();
    }, threadMutations.SCROLL_STATE_SAVE_THROTTLE_MS);
  };

  /* ----- reduce 驱动写入（流式写真源）----- */
  function applyReduceEvent(event: TAiThreadReduceEvent): void {
    commitAuthoritativeState(threadMutations.applyReduceEvent(readAuthoritativeState(), event));
  }

  function applyReduceEvents(events: readonly TAiThreadReduceEvent[]): void {
    commitAuthoritativeState(threadMutations.applyReduceEvents(readAuthoritativeState(), events));
  }

  /* ----- 线程生命周期（切换/新建/清空/删除前 flush 滚动，与 legacy 一致）----- */
  function switchThread(threadId: string): void {
    if (!authoritativeThreads.value.some((thread) => thread.id === threadId)) {
      return;
    }
    flushPendingScrollStateUpdates();
    commitAuthoritativeState(threadMutations.switchThread(readAuthoritativeState(), threadId));
  }

  function startNewThread(): void {
    flushPendingScrollStateUpdates();
    commitAuthoritativeState(threadMutations.startNewThread(readAuthoritativeState()));
  }

  function clearActiveThread(): void {
    flushPendingScrollStateUpdates();
    commitAuthoritativeState(threadMutations.clearActiveThread(readAuthoritativeState()));
  }

  function deleteThread(threadId: string): boolean {
    if (!authoritativeThreads.value.some((thread) => thread.id === threadId)) {
      return false;
    }
    flushPendingScrollStateUpdates();
    commitAuthoritativeState(threadMutations.deleteThread(readAuthoritativeState(), threadId));
    return true;
  }

  function updateThreadScrollState(
    threadId: string,
    scrollState: threadMutations.IAiThreadScrollState,
  ): void {
    const thread = authoritativeThreads.value.find((item) => item.id === threadId);
    if (!thread) {
      return;
    }
    const normalizedScrollState = threadMutations.normalizeScrollStateForPersist(scrollState);
    const currentScrollState = pendingScrollStates.get(threadId) ?? thread.scrollState;
    if (threadMutations.isSamePersistedScrollState(currentScrollState, normalizedScrollState)) {
      return;
    }
    pendingScrollStates.set(threadId, normalizedScrollState);
    scheduleScrollStateSave();
  }

  /* ----- 标题生成 ----- */
  function getThreadTitleStatus(threadId: string): threadMutations.TAiThreadTitleStatus {
    return threadMutations.getThreadTitleStatus(readAuthoritativeState(), threadId);
  }

  function getFirstRoundForTitle(threadId: string): threadMutations.IAiThreadFirstRound | null {
    return threadMutations.getFirstRoundForTitle(readAuthoritativeState(), threadId);
  }

  function markThreadTitleGenerating(threadId: string): void {
    commitAuthoritativeState(
      threadMutations.markThreadTitleGenerating(readAuthoritativeState(), threadId),
    );
  }

  function completeThreadTitleGeneration(threadId: string, title: string): void {
    commitAuthoritativeState(
      threadMutations.completeThreadTitleGeneration(readAuthoritativeState(), threadId, title),
    );
  }

  function failThreadTitleGeneration(threadId: string): void {
    commitAuthoritativeState(
      threadMutations.failThreadTitleGeneration(readAuthoritativeState(), threadId),
    );
  }

  /**
   * 灌入权威线程快照（砖3 持久化归属切换时由读侧调用）。
   * 经 commitThreadsState 归一（trim + ensureActiveThread 兜底），空库自动建空线程。
   */
  function setAuthoritativeThreads(threads: IAiThread[], activeThreadId: string | null): void {
    flushPendingScrollStateUpdates();
    commitAuthoritativeState(threadMutations.commitThreadsState({ threads, activeThreadId }));
  }

  return {
    // state
    liveThread,
    persistedThreads,
    persistedActiveThreadId,
    // Step 8 砖2b：entries 权威状态（未接线）
    authoritativeThreads,
    authoritativeActiveThreadId,
    // getters
    projectedActiveThread,
    persistedActiveThread,
    activeThread,
    activeEntries,
    // Step 8 砖2b：entries 权威读派生（未接线）
    authoritativeActiveThread,
    authoritativeActiveEntries,
    authoritativeHistoryThreads,
    authoritativeHasEntries,
    // Step 8 砖3①：渲染权威 getter（未接线）
    renderActiveThread,
    renderActiveEntries,
    // actions
    setLiveThread,
    setStreamingActiveThread,
    setPersistedThreads,
    setPersistedActiveThreadId,
    // Step 8 砖2b：entries 权威写 actions（未接线）
    applyReduceEvent,
    applyReduceEvents,
    switchThread,
    startNewThread,
    clearActiveThread,
    deleteThread,
    updateThreadScrollState,
    getThreadTitleStatus,
    getFirstRoundForTitle,
    markThreadTitleGenerating,
    completeThreadTitleGeneration,
    failThreadTitleGeneration,
    setAuthoritativeThreads,
    flushPendingScrollStateUpdates,
  };
});

export * from '@/store/aiThread/events';
export * from '@/store/aiThread/legacy-adapter';
export * from '@/store/aiThread/reduce';
export * from '@/store/aiThread/render-authority';
