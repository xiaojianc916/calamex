/* ============================================================================
 * aiThread store（双轨期薄层，ADR-0013 / ADR-0014 Step 3）
 *
 * 双轨原则：旧 `aiConversation` store 始终权威（持久化/标题/活动线程），
 * 本 store 仅在其上提供面向渲染层的 `IAiThread`（entries 模型）投影。
 * 本步只读投影；Step 5 起，流式进行中改由 reduceThread 驱动 `liveThread`
 * 覆盖投影。本 store 不修改旧 store，未接线前零行为变化。
 * ========================================================================== */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { useAiConversationStore } from '@/store/aiConversation';
import { legacyThreadToThread } from '@/store/aiThread/legacy-adapter';
import type { IAiThread, IAiThreadEntry } from '@/types/ai/thread';

export const useAiThreadStore = defineStore('ai-thread', () => {
  const conversation = useAiConversationStore();

  /**
   * 双轨期开关：渲染层据此在「旧 messages 路径」与「新 entries 路径」之间切换。
   * Step 8 收敛后移除。
   */
  const renderFromEntries = ref(false);

  /**
   * 活动流式线程：Step 5 起由边车监听 -> reduceThread 写入。为 null 时回落
   * 到对旧 active thread 的只读投影。
   */
  const liveThread = ref<IAiThread | null>(null);

  /** 把 legacy active thread 适配为 entries 模型（只读派生）。 */
  const projectedActiveThread = computed<IAiThread | null>(() =>
    conversation.activeThread ? legacyThreadToThread(conversation.activeThread) : null,
  );

  const activeThread = computed<IAiThread | null>(
    () => liveThread.value ?? projectedActiveThread.value,
  );

  const activeEntries = computed<IAiThreadEntry[]>(() => activeThread.value?.entries ?? []);

  function setLiveThread(thread: IAiThread | null): void {
    liveThread.value = thread;
  }

  function setRenderFromEntries(value: boolean): void {
    renderFromEntries.value = value;
  }

  return {
    // state
    renderFromEntries,
    liveThread,
    // getters
    projectedActiveThread,
    activeThread,
    activeEntries,
    // actions
    setLiveThread,
    setRenderFromEntries,
  };
});

export * from '@/store/aiThread/events';
export * from '@/store/aiThread/reduce';
export * from '@/store/aiThread/legacy-adapter';
