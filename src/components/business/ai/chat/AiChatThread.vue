<script setup lang="ts">
import { MessageSquare } from '@lucide/vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import { useTimeoutFn } from '@vueuse/core';
import type { MarkstreamVirtualMetrics } from 'markstream-vue';
import {
  computed,
  type ComponentPublicInstance,
  nextTick,
  onBeforeUnmount,
  provide,
  ref,
  watch,
} from 'vue';
import { ConversationEmptyState } from '@/components/ai-elements/conversation';
import { Message } from '@/components/ai-elements/message';
import AiThreadEntryView from '@/components/business/ai/thread/AiThreadEntryView.vue';
import {
  type TAiThreadEntry,
  threadEntriesToTimeline,
} from '@/components/business/ai/thread/projection';
import type { IAiThreadPlanDetails } from '@/components/business/ai/thread/types';
import { useThreadEntryExpansion } from '@/components/business/ai/thread/useThreadEntryExpansion';
import type { TAiServicePlatformId } from '@/constants/ai/providers';
import type { IAiChatMessage } from '@/types/ai';
import type { IAiThreadEntry } from '@/types/ai/thread';
import AiThinkingStatus from './AiThinkingStatus.vue';
import { AI_MARKDOWN_VIRTUAL_SCROLL_KEY } from './markstream-virtual-scroll';

interface IAiChatScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distanceFromBottom: number;
}

type TAiThreadVirtualItem =
  | {
      type: 'entry';
      id: string;
      entry: TAiThreadEntry;
    }
  | {
      type: 'typing';
      id: string;
    };

const props = withDefaults(
  defineProps<{
    messages: IAiChatMessage[];
    isTyping: boolean;
    platformId: TAiServicePlatformId;
    providerLabel: string;
    typingLabel?: string;
    conversationId?: string | null;
    workspaceRootPath?: string | null;
    scrollState?: IAiChatScrollState | null;
    hasExtraContent?: boolean;
    planDetails?: IAiThreadPlanDetails;
    revertingChangedFilesSummaryId?: string | null;
    pinningChangedFilesSummaryId?: string | null;
    threadEntries?: readonly IAiThreadEntry[];
    streamingMessageId?: string | null;
  }>(),
  {
    typingLabel: '正在思考',
    conversationId: null,
    workspaceRootPath: null,
    scrollState: null,
    hasExtraContent: false,
    planDetails: undefined,
    revertingChangedFilesSummaryId: null,
    pinningChangedFilesSummaryId: null,
    threadEntries: () => [],
    streamingMessageId: null,
  },
);

const emit = defineEmits<{
  changedFilesRollback: [messageId: string, summaryId: string];
  changedFilesPin: [messageId: string, summaryId: string, pinned: boolean];
  scrollStateChange: [state: IAiChatScrollState];
  planApprove: [];
  planReject: [];
  planRegenerate: [];
  planUpdateStepTitle: [stepId: string, title: string];
  planRemoveStep: [stepId: string];
}>();

const VIRTUAL_SCROLLER_MIN_ITEM_SIZE = 96;
// 视口外预渲染条目数:约等于原 vue-virtual-scroller 的 1200px buffer(1200 / 96 ≈ 12)。
const VIRTUAL_SCROLLER_OVERSCAN = 12;
// 贴底判定阈值:同时作为 scrollEndThreshold 传给虚拟器,isAtEnd()/followOnAppend 均用它。
const BOTTOM_FOLLOW_THRESHOLD_PX = 56;
const SCROLL_STATE_EMIT_THROTTLE_MS = 100;
const SCROLLBAR_ACTIVE_MS = 900;
const AI_MARKDOWN_VIRTUAL_MEASUREMENT_KEY = 'calamex-ai-markdown:v1';

const scrollerRef = ref<HTMLElement | null>(null);
const isScrollbarActive = ref(false);
const showScrollButton = ref(false);

// 滚动条激活后 SCROLLBAR_ACTIVE_MS 自动隐藏;immediate: false 仅在 activateScrollbar 时 start。
const { start: scheduleScrollbarHide } = useTimeoutFn(
  () => {
    isScrollbarActive.value = false;
  },
  SCROLLBAR_ACTIVE_MS,
  { immediate: false },
);
let lastScrollStateEmitAt = 0;
let pendingMarkdownHeightReconcileFrame: number | null = null;

const entryTimeline = computed<TAiThreadEntry[]>(() =>
  threadEntriesToTimeline(props.threadEntries ?? [], {
    streamingMessageId: props.streamingMessageId,
  }),
);

const entryExpansion = useThreadEntryExpansion(entryTimeline);

const messagesById = computed(() => {
  const map = new Map<string, IAiChatMessage>();
  for (const message of props.messages) {
    map.set(message.id, message);
  }
  return map;
});

// entries 路径下,checkpoint 等 after-message 内容按“来源消息边界”挂载:取每个 messageId
// 在平铺时间线中最后一条 entry 作为边界;仅当该消息存在于 messages 时才产出(否则不渲染,
// 与收敛前 entries 模式行为一致,不臆造数据)。
const afterMessageByEntryId = computed(() => {
  const lastEntryIdByMessageId = new Map<string, string>();
  for (const entry of entryTimeline.value) {
    lastEntryIdByMessageId.set(entry.messageId, entry.id);
  }

  const resolved = new Map<string, IAiChatMessage>();
  lastEntryIdByMessageId.forEach((entryId, messageId) => {
    const message = messagesById.value.get(messageId);
    if (message) {
      resolved.set(entryId, message);
    }
  });

  return resolved;
});

const hasInlineProgressEntry = computed(() => {
  const lastEntry = entryTimeline.value.at(-1);

  if (!lastEntry) {
    return false;
  }

  return (
    (lastEntry.kind === 'assistant-text' && lastEntry.streaming) ||
    (lastEntry.kind === 'reasoning' && lastEntry.streaming)
  );
});

const shouldRenderStandaloneTyping = computed(() => {
  if (!props.isTyping) {
    return false;
  }

  return !hasInlineProgressEntry.value;
});

const isThreadEmpty = computed(() => entryTimeline.value.length === 0);

const shouldRenderEmptyState = computed(
  () => isThreadEmpty.value && !props.hasExtraContent && !shouldRenderStandaloneTyping.value,
);

const virtualItems = computed<TAiThreadVirtualItem[]>(() => {
  const items: TAiThreadVirtualItem[] = entryTimeline.value.map((entry) => ({
    type: 'entry' as const,
    id: entry.id,
    entry,
  }));

  if (shouldRenderStandaloneTyping.value) {
    items.push({
      type: 'typing',
      id: `typing:${props.conversationId ?? 'active'}`,
    });
  }

  return items;
});

// ── @tanstack/vue-virtual 接入（滚动/跟随完全交给库）────────────────────────────────
// 聊天场景的钉底与跟随逻辑全部交给虚拟器(参照 TanStack “Chat UIs Are Lists Until They Aren't”):
//   - anchorTo: 'end'       末端锚定:流式增高 / prepend 历史时保持视觉位置稳定
//   - followOnAppend: true  追加消息时,仅当用户已贴底(scrollEndThreshold 内)才自动跟随
//   - scrollEndThreshold    贴底判定阈值,isAtEnd()/followOnAppend 共用
//   - getItemKey            prepend 稳定性所必需:索引会变,需用稳定 id 找回同一条目
const virtualizerOptions = computed(() => ({
  count: virtualItems.value.length,
  getScrollElement: () => scrollerRef.value,
  estimateSize: () => VIRTUAL_SCROLLER_MIN_ITEM_SIZE,
  overscan: VIRTUAL_SCROLLER_OVERSCAN,
  getItemKey: (index: number) => virtualItems.value[index]?.id ?? index,
  anchorTo: 'end' as const,
  followOnAppend: true,
  scrollEndThreshold: BOTTOM_FOLLOW_THRESHOLD_PX,
}));

const chatVirtualizer = useVirtualizer<HTMLElement, HTMLElement>(virtualizerOptions);

const totalSize = computed(() => chatVirtualizer.value.getTotalSize());

const renderRows = computed(() => {
  const rows = chatVirtualizer.value.getVirtualItems();
  const resolved: Array<{ row: (typeof rows)[number]; item: TAiThreadVirtualItem }> = [];

  for (const row of rows) {
    const item = virtualItems.value[row.index];
    if (item) {
      resolved.push({ row, item });
    }
  }

  return resolved;
});

// TanStack 通过元素上的 data-index 关联测量结果,故每行都带 :data-index。
const measureVirtualRow = (el: Element | ComponentPublicInstance | null): void => {
  if (el instanceof HTMLElement) {
    chatVirtualizer.value.measureElement(el);
  }
};

const getScrollElement = (): HTMLElement | null => scrollerRef.value;

// 滚动遥测仍需上报给父级(跨会话持久化/恢复是应用级状态,库不管)。
// scrollTop/scrollHeight/clientHeight 本质是 DOM 读取;distanceFromBottom 交给 getDistanceFromEnd()。
const emitScrollState = (element: HTMLElement, force = false): void => {
  const now = performance.now();

  if (!force && now - lastScrollStateEmitAt < SCROLL_STATE_EMIT_THROTTLE_MS) {
    return;
  }

  lastScrollStateEmitAt = now;

  emit('scrollStateChange', {
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    distanceFromBottom: chatVirtualizer.value.getDistanceFromEnd(),
  });
};

const cancelPendingMarkdownHeightReconcile = (): void => {
  if (pendingMarkdownHeightReconcileFrame === null) {
    return;
  }

  window.cancelAnimationFrame(pendingMarkdownHeightReconcileFrame);
  pendingMarkdownHeightReconcileFrame = null;
};

// “跳到最新”按钮:直接用虚拟器的 scrollToEnd,与 anchorTo/isAtEnd 共用同一套末端语义。
const handleJumpToLatest = (): void => {
  chatVirtualizer.value.scrollToEnd({ behavior: 'smooth' });
  showScrollButton.value = false;
};

const restoreScrollState = async (): Promise<void> => {
  await nextTick();

  const element = getScrollElement();

  if (!element) {
    return;
  }

  const scrollState = props.scrollState;

  // 无保存位置(如新会话):直接跳到末端。
  if (!scrollState) {
    chatVirtualizer.value.scrollToEnd({ behavior: 'auto' });
    showScrollButton.value = false;
    return;
  }

  // 跨会话恢复是应用级持久化,库不提供;恢复原始 scrollTop 后,用 isAtEnd() 决定按钮显隐。
  element.scrollTop = Math.max(
    0,
    Math.min(scrollState.scrollTop, element.scrollHeight - element.clientHeight),
  );

  showScrollButton.value = !chatVirtualizer.value.isAtEnd();
  emitScrollState(element, true);
};

const activateScrollbar = (): void => {
  isScrollbarActive.value = true;
  scheduleScrollbarHide();
};

const handleScrollerScroll = (event: Event): void => {
  const element = event.currentTarget;

  if (!(element instanceof HTMLElement)) {
    return;
  }

  activateScrollbar();

  // 贴底判定交给库:isAtEnd() 内部用 scrollEndThreshold,与 followOnAppend 一致。
  showScrollButton.value = !chatVirtualizer.value.isAtEnd();

  emitScrollState(element);
};

// markstream 报告流式高度变化时,只需让虚拟器重测;anchorTo: 'end' 会在已贴底时自动保持钉底。
const scheduleMarkdownHeightReconcile = (metrics: MarkstreamVirtualMetrics): void => {
  if (!Number.isFinite(metrics.totalHeight) || metrics.totalHeight <= 0) {
    return;
  }

  if (pendingMarkdownHeightReconcileFrame !== null) {
    return;
  }

  pendingMarkdownHeightReconcileFrame = window.requestAnimationFrame(() => {
    pendingMarkdownHeightReconcileFrame = null;
    chatVirtualizer.value.measure();
  });
};

const virtualThreadKey = computed(() => props.conversationId ?? 'active');
const virtualMeasurementKey = computed(() => AI_MARKDOWN_VIRTUAL_MEASUREMENT_KEY);

provide(AI_MARKDOWN_VIRTUAL_SCROLL_KEY, {
  scrollRoot: scrollerRef,
  threadKey: virtualThreadKey,
  measurementKey: virtualMeasurementKey,
  onHeightChange: scheduleMarkdownHeightReconcile,
});

const handleChangedFilesRollback = (messageId: string, summaryId: string): void => {
  emit('changedFilesRollback', messageId, summaryId);
};

const handleChangedFilesPin = (messageId: string, summaryId: string, pinned: boolean): void => {
  emit('changedFilesPin', messageId, summaryId, pinned);
};

const handlePlanUpdateStepTitle = (stepId: string, title: string): void => {
  emit('planUpdateStepTitle', stepId, title);
};

const handlePlanRemoveStep = (stepId: string): void => {
  emit('planRemoveStep', stepId);
};

watch(
  () => props.conversationId,
  () => {
    void restoreScrollState();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  cancelPendingMarkdownHeightReconcile();
});
</script>

<template>
  <section
    class="ai-chat-list overflow-x-hidden"
    :class="{ 'is-scrollbar-active': isScrollbarActive }"
    aria-label="AI 对话记录"
  >
    <div v-if="shouldRenderEmptyState" class="ai-chat-list__empty">
      <slot name="empty">
        <ConversationEmptyState
          class="ai-chat-empty-state"
          title="还没有对话"
          description="选择一个提示词，或直接输入你的问题。"
        >
          <template #icon>
            <MessageSquare class="size-6" />
          </template>
        </ConversationEmptyState>
      </slot>
    </div>

    <div
      v-else
      ref="scrollerRef"
      class="ai-chat-list__scroller"
      @scroll.passive="handleScrollerScroll"
    >
      <div class="ai-chat-list__sizer" :style="{ height: `${totalSize}px` }">
        <div
          v-for="{ row, item } in renderRows"
          :key="row.key"
          :ref="measureVirtualRow"
          :data-index="row.index"
          class="ai-chat-list__row"
          :style="{ transform: `translateY(${row.start}px)` }"
        >
          <div class="ai-chat-list__item">
            <template v-if="item.type === 'entry'">
              <AiThreadEntryView
                :entry="item.entry"
                :open="entryExpansion.isExpanded(item.entry)"
                :workspace-root-path="workspaceRootPath"
                :plan-details="planDetails"
                :reverting-changed-files-summary-id="revertingChangedFilesSummaryId"
                :pinning-changed-files-summary-id="pinningChangedFilesSummaryId"
                @update:open="entryExpansion.setExpanded(item.entry, $event)"
                @changed-files-rollback="handleChangedFilesRollback"
                @changed-files-pin="handleChangedFilesPin"
                @plan-approve="emit('planApprove')"
                @plan-reject="emit('planReject')"
                @plan-regenerate="emit('planRegenerate')"
                @plan-update-step-title="handlePlanUpdateStepTitle"
                @plan-remove-step="handlePlanRemoveStep"
              />

              <slot
                v-if="afterMessageByEntryId.get(item.id)"
                name="after-message"
                :message="afterMessageByEntryId.get(item.id)"
              />
            </template>

            <Message
              v-else
              from="assistant"
              class="ai-message-typing"
              :aria-label="typingLabel"
            >
              <AiThinkingStatus :label="typingLabel" />
            </Message>
          </div>
        </div>
      </div>

      <div class="ai-chat-list__after">
        <slot name="after-messages" />
      </div>
    </div>

    <button
      v-if="showScrollButton && virtualItems.length > 0"
      class="ai-chat-scroll-button"
      type="button"
      aria-label="滚动到底部"
      @click="handleJumpToLatest"
    >
      ↓
    </button>
  </section>
</template>

<style scoped>
.ai-chat-list {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1 1 0;
  flex-direction: column;
  overflow: hidden;
}

.ai-chat-list__empty {
  display: flex;
  width: min(100%, 710px);
  max-width: 860px;
  min-height: 100%;
  margin-inline: auto;
  align-items: center;
  justify-content: center;
  padding: 18px 12px 28px;
}

.ai-chat-list__scroller {
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scroll-behavior: auto;
  scrollbar-color: transparent transparent;
  scrollbar-width: thin;
}

.ai-chat-list.is-scrollbar-active .ai-chat-list__scroller {
  scrollbar-color: color-mix(in srgb, var(--text-primary) 18%, transparent) transparent;
}

.ai-chat-list__scroller::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.ai-chat-list__scroller::-webkit-scrollbar-track {
  background: transparent;
}

.ai-chat-list__scroller::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
    background-clip: padding-box;
  background-color: transparent;
  border-radius: 9999px;
}

.ai-chat-list.is-scrollbar-active .ai-chat-list__scroller::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--text-primary) 18%, transparent);
}

.ai-chat-list__sizer {
  position: relative;
  width: 100%;
}

.ai-chat-list__row {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
}

/* 消息行间距：虚拟列表行为绝对定位且按 offsetHeight 测量，margin 不计入测量高度（迁移后旧的
   margin 间距因此失效）。这里用 padding-block-end 把行间距放进会被测量的盒子里，保证条目之间
   有稳定间隔，且不会与虚拟器的高度测量冲突。 */
.ai-chat-list__item {
  width: min(100%, 710px);
  margin-inline: auto;
  padding-inline: 12px;
  padding-block-end: 20px;
}

/* 滚动内容尾部留白：加大底部 padding，让最后一条 AI 回复与下方输入框之间留出更舒展的空白。 */
.ai-chat-list__after {
  width: min(100%, 710px);
  margin-inline: auto;
  padding: 0 12px 32px;
}

.ai-message-typing {
  width: 100%;
}

.ai-chat-scroll-button {
  position: absolute;
  right: 18px;
  bottom: 18px;
  z-index: 2;
  display: inline-flex;
  width: 32px;
  height: 32px;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-subtle);
  border-radius: 9999px;
  background-color: var(--bg-elevated);
  box-shadow: 0 6px 18px rgb(0 0 0 / 18%);
  color: var(--text-primary);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    transform 0.15s ease;
}

.ai-chat-scroll-button:hover {
  background-color: var(--bg-elevated-hover);
  transform: translateY(-1px);
}
</style>
