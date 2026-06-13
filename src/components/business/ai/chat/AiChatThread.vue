<script setup lang="ts">
import { MessageSquare } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller';
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css';
import { ConversationEmptyState } from '@/components/ai-elements/conversation';
import { Message } from '@/components/ai-elements/message';
import type { IAiThreadPlanDetails } from '@/components/business/ai/thread/types';
import type { TAiServicePlatformId } from '@/constants/ai/providers';
import type { IAiChatMessage } from '@/types/ai';
import AiThinkingStatus from './AiThinkingStatus.vue';
import AiThreadVirtualMessageItem from './AiThreadVirtualMessageItem.vue';

interface IAiChatScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distanceFromBottom: number;
}

type TAiThreadVirtualItem =
  | {
      type: 'message';
      id: string;
      message: IAiChatMessage;
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

const TOOL_PROGRESS_PREFIXES = [
  'AI 正在自动分析并按需调用工具…',
  'AI 正在自动使用工具：',
  'Agent 正在调用工具…',
  'Agent 正在根据你的确认继续执行…',
] as const;

const ERROR_REPLY_PREFIXES = ['Agent 执行失败：', 'AI 上下文收集失败：', '计划生成失败：'] as const;
const PLAN_AGENT_FLOW_MESSAGE_ID_PREFIX = 'agent-flow:';

const VIRTUAL_SCROLLER_MIN_ITEM_SIZE = 96;
const VIRTUAL_SCROLLER_BUFFER_PX = 1200;
const BOTTOM_FOLLOW_THRESHOLD_PX = 56;
const SCROLL_STATE_EMIT_THROTTLE_MS = 40;
const SCROLLBAR_ACTIVE_MS = 900;

const virtualScrollerRef = ref<unknown>(null);
const isScrollbarActive = ref(false);
const showScrollButton = ref(false);

let pendingBottomScrollFrame: number | null = null;
let scrollbarTimer: ReturnType<typeof window.setTimeout> | null = null;
let lastScrollStateEmitAt = 0;
let shouldFollowBottomAfterResize = true;
let lastKnownDistanceFromBottom = 0;

const isErrorReplyMessage = (message: IAiChatMessage): boolean => {
  if (message.role !== 'assistant') {
    return false;
  }

  const content = message.content.trim();

  if (!content) {
    return false;
  }

  return ERROR_REPLY_PREFIXES.some((prefix) => content.startsWith(prefix));
};

const isPlanAgentFlowMessage = (message: IAiChatMessage): boolean =>
  message.role === 'assistant' && message.id.startsWith(PLAN_AGENT_FLOW_MESSAGE_ID_PREFIX);

const visibleMessages = computed<IAiChatMessage[]>(() =>
  props.messages.filter(
    (message) => !isErrorReplyMessage(message) && !isPlanAgentFlowMessage(message),
  ),
);

const hasInlineProgressMessage = computed(() => {
  const lastMessage = visibleMessages.value.at(-1);

  if (lastMessage?.role !== 'assistant') {
    return false;
  }

  const content = lastMessage.content.trim();
  const isEmptyAssistantPlaceholder =
    !content && !lastMessage.toolCalls?.length && !lastMessage.actions?.length;

  return (
    lastMessage.stream?.status === 'streaming' ||
    Boolean(lastMessage.toolCalls?.length) ||
    isEmptyAssistantPlaceholder ||
    TOOL_PROGRESS_PREFIXES.some((prefix) => content.startsWith(prefix))
  );
});

const shouldRenderStandaloneTyping = computed(
  () => props.isTyping && !hasInlineProgressMessage.value,
);

const shouldRenderEmptyState = computed(
  () =>
    visibleMessages.value.length === 0 &&
    !props.hasExtraContent &&
    !shouldRenderStandaloneTyping.value,
);

const virtualItems = computed<TAiThreadVirtualItem[]>(() => {
  const items: TAiThreadVirtualItem[] = visibleMessages.value.map((message) => ({
    type: 'message',
    id: message.id,
    message,
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

  if (scrollbarTimer !== null) {
    window.clearTimeout(scrollbarTimer);
  }

  scrollbarTimer = window.setTimeout(() => {
    isScrollbarActive.value = false;
    scrollbarTimer = null;
  }, SCROLLBAR_ACTIVE_MS);
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

const getMessageSizeDependencies = (message: IAiChatMessage): unknown[] => [
  message.content,
  message.stream?.status,
  message.toolCalls?.length ?? 0,
  message.toolCalls?.map((toolCall) => toolCall.status).join('|') ?? '',
  message.actions?.length ?? 0,
  message.attachments?.length ?? 0,
  props.planDetails?.status,
  props.planDetails?.steps?.length ?? 0,
  props.planDetails?.steps?.map((step) => `${step.id}:${step.status}:${step.title}`).join('|') ??
    '',
  props.revertingChangedFilesSummaryId,
  props.pinningChangedFilesSummaryId,
];

const handleDynamicItemResize = (): void => {
  if (!shouldFollowBottomAfterResize) {
    return;
  }

  void scrollToBottom('auto');
};

const bottomFollowSignature = computed(() => {
  const lastMessage = visibleMessages.value.at(-1);

  return [
    props.conversationId ?? '',
    visibleMessages.value.length,
    lastMessage?.id ?? '',
    lastMessage?.content.length ?? 0,
    lastMessage?.stream?.status ?? '',
    lastMessage?.toolCalls?.length ?? 0,
    lastMessage?.actions?.length ?? 0,
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

  if (scrollbarTimer !== null) {
    window.clearTimeout(scrollbarTimer);
    scrollbarTimer = null;
  }
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
          :data-index="index"
          :size-dependencies="
            item.type === 'message' ? getMessageSizeDependencies(item.message) : [props.isTyping]
          "
          emit-resize
          @resize="handleDynamicItemResize"
        >
          <div class="ai-chat-list__item">
            <AiThreadVirtualMessageItem
              v-if="item.type === 'message'"
              :message="item.message"
              :workspace-root-path="workspaceRootPath"
              :plan-details="planDetails"
              :reverting-changed-files-summary-id="revertingChangedFilesSummaryId"
              :pinning-changed-files-summary-id="pinningChangedFilesSummaryId"
              @changed-files-rollback="handleChangedFilesRollback"
              @changed-files-pin="handleChangedFilesPin"
              @plan-approve="emit('planApprove')"
              @plan-reject="emit('planReject')"
              @plan-regenerate="emit('planRegenerate')"
              @plan-update-step-title="handlePlanUpdateStepTitle"
              @plan-remove-step="handlePlanRemoveStep"
            >
              <template #after-message="{ message }">
                <slot name="after-message" :message="message" />
              </template>
            </AiThreadVirtualMessageItem>

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
  border-radius: 999px;
  background: transparent;
  background-clip: content-box;
  transition: background-color 180ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-chat-list.is-scrollbar-active .ai-chat-list__scroller::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--text-primary) 18%, transparent);
}

.ai-chat-list__scroller::-webkit-scrollbar-thumb:hover {
  background-color: color-mix(in srgb, var(--text-primary) 28%, transparent);
}

.ai-chat-list__item,
.ai-chat-list__after {
  box-sizing: border-box;
  width: min(100%, 710px);
  max-width: 860px;
  min-width: 0;
  margin-inline: auto;
  padding-inline: 12px;
}

.ai-chat-list__item {
  padding-block: 8px;
  contain: layout style;
}

.ai-chat-list__after {
  padding-block: 8px 28px;
}

.ai-chat-list :deep(.vue-recycle-scroller__item-wrapper) {
  overflow: visible;
}

.ai-chat-list :deep(.vue-recycle-scroller__item-view) {
  overflow: visible;
}

.ai-chat-empty-state {
  color: var(--text-tertiary);
}

.ai-chat-scroll-button {
  position: absolute;
  bottom: 14px;
  left: 50%;
  z-index: 2;
  display: inline-flex;
  width: 32px;
  height: 32px;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--border-primary) 82%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface-primary) 94%, transparent);
  box-shadow: 0 10px 28px color-mix(in srgb, #000 18%, transparent);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  transform: translateX(-50%);
  transition:
    border-color 160ms ease,
    background-color 160ms ease,
    color 160ms ease,
    transform 160ms ease;
}

.ai-chat-scroll-button:hover {
  border-color: color-mix(in srgb, var(--text-primary) 24%, transparent);
  background: var(--surface-primary);
  color: var(--text-primary);
  transform: translateX(-50%) translateY(-1px);
}

.ai-message-typing {
  display: flex;
  min-width: 0;
  align-items: flex-start;
}
</style>
