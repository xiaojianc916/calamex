<script setup lang="ts">
import { MessageSquare } from '@lucide/vue';
import { computed, nextTick, ref, watch } from 'vue';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message } from '@/components/ai-elements/message';
import AiThreadTimeline from '@/components/business/ai/thread/AiThreadTimeline.vue';
import type { IAiThreadPlanDetails } from '@/components/business/ai/thread/types';
import type { TAiServicePlatformId } from '@/constants/ai/providers';
import type { IAiChatMessage } from '@/types/ai';
import AiThinkingStatus from './AiThinkingStatus.vue';

interface IAiChatScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distanceFromBottom: number;
}

const props = withDefaults(
  defineProps<{
    messages: IAiChatMessage[];
    isTyping: boolean;
    // platformId / providerLabel 由面板传入,作为稳定的对外契约保留(平铺时间线本身
    // 不再渲染逐消息的 provider 标识),避免父级绑定退化成 DOM 透传属性。
    platformId: TAiServicePlatformId;
    providerLabel: string;
    typingLabel?: string;
    conversationId?: string | null;
    workspaceRootPath?: string | null;
    scrollState?: IAiChatScrollState | null;
    hasExtraContent?: boolean;
    // Plan 控制条目(等待批准)的运行态明细;由面板按当前计划注入,渲染层无状态。
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
// 报错只在输入框上方以一条居中提示线呈现,因此这些“把报错当回复”的助手占位消息
// 不再进入对话流,避免同一个错误出现两次。
const ERROR_REPLY_PREFIXES = ['Agent 执行失败：', 'AI 上下文收集失败：', '计划生成失败：'] as const;
// Plan 执行态的工具活动由真实运行时事件驱动平铺时间线;这个旧的 synthetic assistant
// message 仅保留给 token usage 估算,不能再混入会话时间线。
const PLAN_AGENT_FLOW_MESSAGE_ID_PREFIX = 'agent-flow:';

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

const HISTORY_MESSAGE_INITIAL_COUNT = 80;
const HISTORY_MESSAGE_LOAD_STEP = 40;
const HISTORY_SCROLL_PRELOAD_THRESHOLD_PX = 96;
const RESTORED_SCROLL_FROM_BOTTOM_THRESHOLD_PX = 4;
const VIEWPORT_FILL_PADDING_PX = 32;

const visibleMessages = computed<IAiChatMessage[]>(() =>
  props.messages.filter(
    (message) => !isErrorReplyMessage(message) && !isPlanAgentFlowMessage(message),
  ),
);

const conversationRootRef = ref<{ $el?: Element } | null>(null);
const loadedVisibleMessageCount = ref(HISTORY_MESSAGE_INITIAL_COUNT);

const shouldPreserveRestoredViewport = (): boolean => {
  const scrollState = props.scrollState;

  return Boolean(
    scrollState && scrollState.distanceFromBottom > RESTORED_SCROLL_FROM_BOTTOM_THRESHOLD_PX,
  );
};

const getInitialLoadedMessageCount = (messageCount: number): number => {
  if (shouldPreserveRestoredViewport()) {
    // 已恢复到历史中间位置时，当前第一眼可能是任意旧消息。
    // 由于当前滚动状态没有保存“首个可见 message id / 消息高度缓存”，这里优先保证视觉不变，
    // 不做窗口裁剪，避免打开后跳到底部或缺失首屏消息。
    return messageCount;
  }

  return Math.min(messageCount, HISTORY_MESSAGE_INITIAL_COUNT);
};

const renderedMessages = computed<IAiChatMessage[]>(() => {
  const messages = visibleMessages.value;
  const loadedCount = Math.min(loadedVisibleMessageCount.value, messages.length);

  if (loadedCount >= messages.length) {
    return messages;
  }

  return messages.slice(messages.length - loadedCount);
});

const getConversationScrollElement = (): HTMLElement | null => {
  const root = conversationRootRef.value?.$el;

  if (!(root instanceof Element)) {
    return null;
  }

  return root.querySelector(':scope > div > div');
};

const ensureRenderedHistoryFillsViewport = async (): Promise<void> => {
  await nextTick();

  const scrollElement = getConversationScrollElement();

  if (!scrollElement || shouldPreserveRestoredViewport()) {
    return;
  }

  let remainingMessages = visibleMessages.value.length - loadedVisibleMessageCount.value;

  while (
    remainingMessages > 0 &&
    scrollElement.scrollHeight <= scrollElement.clientHeight + VIEWPORT_FILL_PADDING_PX
  ) {
    loadedVisibleMessageCount.value = Math.min(
      visibleMessages.value.length,
      loadedVisibleMessageCount.value + HISTORY_MESSAGE_LOAD_STEP,
    );

    await nextTick();
    remainingMessages = visibleMessages.value.length - loadedVisibleMessageCount.value;
  }

  // 首屏是底部视角时，补足首屏高度后仍保持在底部，避免视觉位置变化。
  scrollElement.scrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
};

const resetRenderedHistoryWindow = (): void => {
  loadedVisibleMessageCount.value = getInitialLoadedMessageCount(visibleMessages.value.length);
  void ensureRenderedHistoryFillsViewport();
};

const loadOlderVisibleMessages = async (): Promise<void> => {
  if (loadedVisibleMessageCount.value >= visibleMessages.value.length) {
    return;
  }

  const scrollElement = getConversationScrollElement();
  const previousScrollHeight = scrollElement?.scrollHeight ?? null;
  const previousScrollTop = scrollElement?.scrollTop ?? null;

  loadedVisibleMessageCount.value = Math.min(
    visibleMessages.value.length,
    loadedVisibleMessageCount.value + HISTORY_MESSAGE_LOAD_STEP,
  );

  await nextTick();

  if (scrollElement && previousScrollHeight !== null && previousScrollTop !== null) {
    const scrollHeightDelta = scrollElement.scrollHeight - previousScrollHeight;
    scrollElement.scrollTop = previousScrollTop + scrollHeightDelta;
  }
};

watch(
  () => props.conversationId,
  () => {
    resetRenderedHistoryWindow();
  },
  { immediate: true },
);

watch(
  () => props.scrollState?.distanceFromBottom ?? null,
  () => {
    if (shouldPreserveRestoredViewport()) {
      loadedVisibleMessageCount.value = visibleMessages.value.length;
    }
  },
  { immediate: true },
);

watch(
  () => visibleMessages.value.length,
  (nextLength, previousLength) => {
    if (shouldPreserveRestoredViewport()) {
      loadedVisibleMessageCount.value = nextLength;
      return;
    }

    if (nextLength <= loadedVisibleMessageCount.value) {
      loadedVisibleMessageCount.value = nextLength;
      return;
    }

    if (previousLength === 0) {
      resetRenderedHistoryWindow();
      return;
    }

    void ensureRenderedHistoryFillsViewport();
  },
);

const hasInlineProgressMessage = computed(() => {
  const lastMessage = visibleMessages.value.at(-1);
  if (lastMessage?.role !== 'assistant') {
    return false;
  }

  const isEmptyAssistantPlaceholder =
    !lastMessage.content.trim() && !lastMessage.toolCalls?.length && !lastMessage.actions?.length;

  return (
    lastMessage.stream?.status === 'streaming' ||
    Boolean(lastMessage.toolCalls?.length) ||
    isEmptyAssistantPlaceholder ||
    TOOL_PROGRESS_PREFIXES.some((prefix) => lastMessage.content.trim().startsWith(prefix))
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

const conversationInitialScroll = computed(() => !props.scrollState);
const conversationResizeMode = computed(() => (props.isTyping ? undefined : 'instant'));

const handleChangedFilesRollback = (messageId: string, summaryId: string): void => {
  emit('changedFilesRollback', messageId, summaryId);
};

const handleChangedFilesPin = (messageId: string, summaryId: string, pinned: boolean): void => {
  emit('changedFilesPin', messageId, summaryId, pinned);
};

const handleScrollStateChange = (state: IAiChatScrollState): void => {
  if (state.scrollTop <= HISTORY_SCROLL_PRELOAD_THRESHOLD_PX) {
    void loadOlderVisibleMessages();
  }

  emit('scrollStateChange', state);
};
</script>

<template>
  <Conversation ref="conversationRootRef" class="relative size-full overflow-x-hidden ai-chat-list" aria-label="AI 对话记录"
    :initial="conversationInitialScroll" :resize="conversationResizeMode" :restore-key="conversationId"
    :initial-scroll-top="scrollState?.scrollTop ?? null"
    :initial-distance-from-bottom="scrollState?.distanceFromBottom ?? null"
    @scroll-state-change="handleScrollStateChange">
    <ConversationContent class="ai-chat-list__content" :class="{ 'is-empty': shouldRenderEmptyState }">
      <slot v-if="shouldRenderEmptyState" name="empty">
        <ConversationEmptyState class="ai-chat-empty-state" title="还没有对话" description="选择一个提示词，或直接输入你的问题。">
          <template #icon>
            <MessageSquare class="size-6" />
          </template>
        </ConversationEmptyState>
      </slot>
      <template v-else>
        <AiThreadTimeline :messages="renderedMessages" :workspace-root-path="workspaceRootPath"
          :plan-details="planDetails"
          :reverting-changed-files-summary-id="revertingChangedFilesSummaryId"
          :pinning-changed-files-summary-id="pinningChangedFilesSummaryId"
          @changed-files-rollback="handleChangedFilesRollback" @changed-files-pin="handleChangedFilesPin"
          @plan-approve="emit('planApprove')" @plan-reject="emit('planReject')"
          @plan-regenerate="emit('planRegenerate')"
          @plan-update-step-title="(stepId: string, title: string) => emit('planUpdateStepTitle', stepId, title)"
          @plan-remove-step="emit('planRemoveStep', $event)">
          <template #after-message="{ message }">
            <slot name="after-message" :message="message" />
          </template>
        </AiThreadTimeline>
        <slot name="after-messages" />
        <Message v-if="shouldRenderStandaloneTyping" from="assistant" class="ai-message-typing"
          :aria-label="typingLabel">
          <AiThinkingStatus :label="typingLabel" />
        </Message>
      </template>
    </ConversationContent>
    <ConversationScrollButton v-if="visibleMessages.length > 0" class="ai-chat-scroll-button" />
  </Conversation>
</template>

<style scoped>
.ai-chat-list {
  min-height: 0;
  flex: 1 1 0;
}

.ai-chat-list :deep(> div > div) {
  overscroll-behavior: contain;
  scroll-behavior: auto;
  overflow-anchor: none;
  scrollbar-color: transparent transparent;
  scrollbar-width: thin;
}

.ai-chat-list.is-scrollbar-active :deep(> div > div) {
  scrollbar-color: color-mix(in srgb, var(--text-primary) 18%, transparent) transparent;
}

.ai-chat-list :deep(> div > div)::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.ai-chat-list :deep(> div > div)::-webkit-scrollbar-track {
  background: transparent;
}

.ai-chat-list :deep(> div > div)::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 999px;
  background: transparent;
  background-clip: content-box;
  transition: background-color 180ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-chat-list.is-scrollbar-active :deep(> div > div)::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--text-primary) 18%, transparent);
}

.ai-chat-list :deep(> div > div)::-webkit-scrollbar-thumb:hover {
  background-color: color-mix(in srgb, var(--text-primary) 28%, transparent);
}

.ai-chat-list__content {
  box-sizing: border-box;
  width: min(100%, 710px);
  max-width: 860px;
  min-width: 0;
  gap: 32px;
  min-height: 100%;
  margin-inline: auto;
  overflow-x: hidden;
  padding: 18px 12px 28px;
}

.ai-chat-list__content.is-empty {
  justify-content: center;
}

.ai-chat-empty-state {
  color: var(--text-tertiary);
}

.ai-chat-scroll-button {
  bottom: 14px;
  left: 50%;
  z-index: 1;
  transform: translateX(-50%);
}

.ai-message-typing {
  display: flex;
  min-width: 0;
  align-items: flex-start;
}
</style>
