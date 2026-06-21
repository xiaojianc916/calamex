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

import type { TAiThreadReduceEvent } from '@/store/aiThread/events';
import {
  legacyMessageToEntries,
  threadEntriesToMessages,
  threadToLegacyThread,
} from '@/store/aiThread/legacy-adapter';
import { selectRenderThread } from '@/store/aiThread/render-authority';
import * as threadMutations from '@/store/aiThread/thread-mutations';
import { restoreAttachmentPreviewPointers } from '@/store/plugins/attachmentPreviewStorage';
import type { IAiChatMessage } from '@/types/ai';
import type { IAiThread, IAiThreadEntry } from '@/types/ai/thread';

export const useAiThreadStore = defineStore('ai-thread', () => {
  /**
   * 活动流式线程：Step 5 起由边车监听 -> reduceThread 写入。为 null 时回落
   * 到对旧 active thread 的只读投影。
   */
  const liveThread = ref<IAiThread | null>(null);

  /* ----- 7.5b 持久化/迁移读侧（Step 7 dual-read） --------------------------
   * 启动迁移把旧 key 投影/救援出的 entries 线程灌入这里（见 7.5c 接线），
   * 作为 legacy 投影之上、liveThread 之下的优先回退来源。
   * 附件预览指针按「活动线程切换」惰性恢复，复用 restoreAttachmentPreviewPointers。
   * ----------------------------------------