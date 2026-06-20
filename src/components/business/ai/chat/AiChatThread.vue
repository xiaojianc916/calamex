<script setup lang="ts">
import { MessageSquare } from '@lucide/vue';
import { useTimeoutFn } from '@vueuse/core';
import type { MarkstreamVirtualMetrics } from 'markstream-vue';
import { computed, nextTick, onBeforeUnmount, provide, ref, watch } from 'vue';
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller';
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css';
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
const VIRTUAL_SCROLLER_BUFFER_PX = 1200;
const BOTTOM_FOLLOW_THRESHOLD_PX = 56;
const SCROLL_STATE_EMIT_THROTTLE_MS = 100;
const SCROLLBAR_ACTIVE_MS = 900;
const ENTRY_SIZE_DEPENDENCY_CACHE_LIMIT = 300;
const AI_MARKDOWN_VIRTUAL_MEASUREMENT_KEY = 'calamex-ai-markdown:v1';

type TDynamicScrollerExpose = {
  $el?: unknown;
  forceUpdate?: (clear?: boolean) => void;
};

const virtualScrollerRef = ref<unknown>(null);
const isScrollbarActive = ref(false);
const showScrollButton = ref(false);

let pendingBottomScrollFrame: number | null = null;
// 滚动条激活后 SCROLLBAR_ACTIVE_MS 自动隐藏；immediate: false 仅在 activateScrollbar 时 start。
const { start: scheduleScrollbarHide } = useTimeoutFn(
  () => {
    isScrollbarActive.value = false;
  },
  SCROLLBAR_ACTIVE_MS,
  { immediate: false },
);
let lastScrollStateEmitAt = 0;
let shouldFollowBottomAfterResize = true;
let lastKnownDistanceFromBottom = 0;
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

const getScrollerElement = (): HTMLElement | null => {
  const candidate = virtualScrollerRef.value;

  if (candidate instanceof HTMLElement) {
    return candidate;
  }

  if (
    candidate &&
    typeof candidate === 'object' &&
    '$el' in candidate &&
    candidate.$el instanceof HTMLElement
  ) {
    return candidate.$el;
  }

  return null;
};

const isDynamicScrollerExpose = (value: unknown): value is TDynamicScrollerExpose =>
  typeof value === 'object' &&
  value !== null &&
  (!('forceUpdate' in value) || typeof value.forceUpdate === 'function');

const getDynamicScrollerExpose = (): TDynamicScrollerExpose | null => {
  const candidate = virtualScrollerRef.value;
  return isDynamicScrollerExpose(candidate) ? candidate : null;
};

const virtualScrollRoot = computed<HTMLElement | null>(() => getScrollerElement());
const virtualThreadKey = computed(() => props.conversationId ?? 'active');
const virtualMeasurementKey = computed(() => AI_MARKDOWN_VIRTUAL_MEASUREMENT_KEY);

const scheduleMarkdownHeightReconcile = (metrics: MarkstreamVirtualMetrics): void => {
  if (!Number.isFinite(metrics.totalHeight) || metrics.totalHeight <= 0) {
    return;
  }

  if (pendingMarkdownHeightReconcileFrame !== null) {
    return;
  }

  pendingMarkdownHeightReconcileFrame = window.requestAnimationFrame(() => {
    pendingMarkdownHeightReconcileFrame = null;

    getDynamicScrollerExpose()?.forceUpdate?.(false);

    if (shouldFollowBottomAfterResize) {
      void scrollToBottom('auto');
    }
  });
};

provide(AI_MARKDOWN_VIRTUAL_SCROLL_KEY, {
  scrollRoot: virtualScrollRoot,
  threadKey: virtualThreadKey,
  measurementKey: virtualMeasurementKey,
  onHeightChange: scheduleMarkdownHeightReconcile,
});

const getDistanceFromBottom = (element: HTMLElement): number =>
  Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight);

const isNearBottom = (): boolean => {
  const element = getScrollerElement();

  if (!element) {
    return true;
  }

  return getDistanceFromBottom(element) <= BOTTOM_FOLLOW_THRESHOLD_PX;
};

const rememberBottomFollowState = (): void => {
  const element = getScrollerElement();

  if (!element) {
    shouldFollowBottomAfterResize = true;
    lastKnownDistanceFromBottom = 0;
    return;
  }

  lastKnownDistanceFromBottom = getDistanceFromBottom(element);
  shouldFollowBottomAfterResize = lastKnownDistanceFromBottom <= BOTTOM_FOLLOW_THRESHOLD_PX;
};

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
    distanceFromBottom: getDistanceFromBottom(element),
  });
};

const cancelPendingBottomScroll = (): void => {
  if (pendingBottomScrollFrame === null) {
    return;
  }

  window.cancelAnimationFrame(pendingBottomScrollFrame);
  pendingBottomScrollFrame = null;
};

const cancelPendingMarkdownHeightReconcile = (): void => {
  if (pendingMarkdownHeightReconcileFrame === null) {
    return;
  }

  window.cancelAnimationFrame(pendingMarkdownHeightReconcileFrame);
  pendingMarkdownHeightReconcileFrame = null;
};

const scrollToBottom = async (behavior: ScrollBehavior = 'auto'): Promise<void> => {
  cancelPendingBottomScroll();

  await nextTick();

  pendingBottomScrollFrame = window.requestAnimationFrame(() => {
    pendingBottomScrollFrame = null;

    const element = getScrollerElement();

    if (!element) {
      return;
    }

    element.scrollTo({
      top: Math.max(0, element.scrollHeight - element.clientHeight),
      behavior,
    });

    showScrollButton.value = false;
    emitScrollState(element, true);
  });
};

const restoreScrollState = async (): Promise<void> => {
  await nextTick();

  const element = getScrollerElement();

  if (!element) {
    return;
  }

  const scrollState = props.scrollState;

  if (!scrollState) {
    await scrollToBottom('auto');
    return;
  }

  element.scrollTop = Math.max(
    0,
    Math.min(scrollState.scrollTop, element.scrollHeight - element.clientHeight),
  );

  showScrollButton.value = getDistanceFromBottom(element) > BOTTOM_FOLLOW_THRESHOLD_PX;
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

  const distanceFromBottom = getDistanceFromBottom(element);
  lastKnownDistanceFromBottom = distanceFromBottom;
  shouldFollowBottomAfterResize = distanceFromBottom <= BOTTOM_FOLLOW_THRESHOLD_PX;
  showScrollButton.value = distanceFromBottom > BOTTOM_FOLLOW_THRESHOLD_PX;

  emitScrollState(element);
};

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

const planSizeSignature = computed(() =>
  [
    props.planDetails?.status ?? '',
    props.planDetails?.steps
      ?.map((step) => `${step.id}:${step.status}:${step.title.length}`)
      .join('|') ?? '',
  ].join('|'),
);

type TEntrySizeDependencyCacheEntry = {
  signature: string;
  dependencies: unknown[];
};

const entrySizeDependencyCache = new Map<string, TEntrySizeDependencyCacheEntry>();

const trimEntrySizeDependencyCache = (currentEntryId: string): void => {
  if (
    entrySizeDependencyCache.size < ENTRY_SIZE_DEPENDENCY_CACHE_LIMIT ||
    entrySizeDependencyCache.has(currentEntryId)
  ) {
    return;
  }

  const firstKey = entrySizeDependencyCache.keys().next().value;
  if (typeof firstKey === 'string') {
    entrySizeDependencyCache.delete(firstKey);
  }
};

const buildEntrySizeSignature = (entry: TAiThreadEntry): string => {
  switch (entry.kind) {
    case 'user-message':
      return ['user-message', entry.markdown.length, entry.references.length].join(':');
    case 'assistant-text':
      return ['assistant-text', entry.markdown.length, entry.streaming ? 1 : 0].join(':');
    case 'reasoning':
      return [
        'reasoning',
        entry.segments.length,
        entry.segments.reduce((total, segment) => total + segment.length, 0),
        entry.isLong ? 1 : 0,
        entry.streaming ? 1 : 0,
        entryExpansion.isExpanded(entry) ? 1 : 0,
      ].join(':');
    case 'tool-call':
      return [
        'tool-call',
        entry.toolCall.status,
        entry.awaiting ? 1 : 0,
        Object.keys(entry.terminals).length,
        entryExpansion.isExpanded(entry) ? 1 : 0,
      ].join(':');
    case 'plan-control':
      return ['plan-control', entry.phase, entry.goal.length, planSizeSignature.value].join(':');
    case 'context-compaction':
      return ['context-compaction', entry.text.length].join(':');
    case 'changed-files-summary':
      return [
        'changed-files-summary',
        entry.summary.id,
        entry.summary.files.length,
        entry.summary.totalAdditions,
        entry.summary.totalDeletions,
        props.revertingChangedFilesSummaryId === entry.summary.id ? 1 : 0,
        props.pinningChangedFilesSummaryId === entry.summary.id ? 1 : 0,
      ].join(':');
    default: {
      const exhaustive: never = entry;
      return String(exhaustive);
    }
  }
};

const getEntrySizeDependencies = (entry: TAiThreadEntry): unknown[] => {
  const signature = buildEntrySizeSignature(entry);
  const cached = entrySizeDependencyCache.get(entry.id);

  if (cached?.signature === signature) {
    return cached.dependencies;
  }

  const dependencies: unknown[] = [entry.id, signature];
  trimEntrySizeDependencyCache(entry.id);
  entrySizeDependencyCache.set(entry.id, { signature, dependencies });
  return dependencies;
};

const handleDynamicItemResize = (): void => {
  if (!shouldFollowBottomAfterResize) {
    return;
  }

  void scrollToBottom('auto');
};

const bottomFollowSignature = computed(() => {
  const lastEntry = entryTimeline.value.at(-1);
  const lastEntryStreaming =
    lastEntry &&
    ((lastEntry.kind === 'assistant-text' && lastEntry.streaming) ||
      (lastEntry.kind === 'reasoning' && lastEntry.streaming))
      ? 'streaming'
      : 'idle';

  return [
    'entries',
    props.conversationId ?? '',
    entryTimeline.value.length,
    lastEntry?.id ?? '',
    lastEntryStreaming,
    props.isTyping ? 'typing' : 'idle',
  ].join(':');
});

watch(
  () => props.conversationId,
  () => {
    void restoreScrollState();
  },
  { immediate: true },
);

watch(
  bottomFollowSignature,
  async () => {
    rememberBottomFollowState();

    await nextTick();

    if (shouldFollowBottomAfterResize) {
      await scrollToBottom('auto');
    }
  },
  { flush: 'pre' },
);

onBeforeUnmount(() => {
  cancelPendingBottomScroll();
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

    <DynamicScroller
      v-else
      ref="virtualScrollerRef"
      class="ai-chat-list__scroller"
      :items="virtualItems"
      key-field="id"
      :min-item-size="VIRTUAL_SCROLLER_MIN_ITEM_SIZE"
      :buffer="VIRTUAL_SCROLLER_BUFFER_PX"
      @scroll.passive="handleScrollerScroll"
    >
      <template #default="{ item, index, active }">
        <DynamicScrollerItem
          :item="item"
          :active="active"
          :index="index"
          :data-index="index"
          :size-dependencies="
            item.type === 'entry' ? getEntrySizeDependencies(item.entry) : [props.isTyping]
          "
          emit-resize
          @resize="handleDynamicItemResize"
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
                v-if="afterMessageByEntryId.get(item.entry.id)"
                name="after-message"
                :message="afterMessageByEntryId.get(item.entry.id)"
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
        </DynamicScrollerItem>
      </template>

      <template #after>
        <div class="ai-chat-list__after">
          <slot name="after-messages" />
        </div>
      </template>
    </DynamicScroller>

    <button
      v-if="showScrollButton && virtualItems.length > 0"
      class="ai-chat-scroll-button"
      type="button"
      aria-label="滚动到底部"
      @click="scrollToBottom('smooth')"
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

.ai-chat-list__item {
  width: min(100%, 710px);
  margin-inline: auto;
  padding-inline: 12px;
}

.ai-chat-list__after {
  width: min(100%, 710px);
  margin-inline: auto;
  padding: 0 12px 12px;
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
