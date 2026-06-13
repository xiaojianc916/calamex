import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const targetPath = path.join(
  repoRoot,
  'src/components/business/ai/chat/AiChatThread.vue',
);
const backupPath = `${targetPath}.bak-before-round20-final`;

const fail = (message) => {
  throw new Error(message);
};

if (!fs.existsSync(targetPath)) {
  fail(`[missing] ${targetPath}`);
}

const current = fs.readFileSync(targetPath, 'utf8');

if (!current.includes('AiThreadTimeline') || !current.includes('ConversationContent')) {
  fail('[guard] 当前 AiChatThread.vue 结构异常，请先恢复文件或贴出当前内容。');
}

if (!fs.existsSync(backupPath)) {
  fs.writeFileSync(backupPath, current);
}

const component = String.raw`<script setup lang="ts">
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

const HISTORY_MESSAGE_INITIAL_COUNT = 80;
const HISTORY_MESSAGE_LOAD_STEP = 40;
const HISTORY_SCROLL_PRELOAD_THRESHOLD_PX = 96;
const RESTORED_SCROLL_FROM_BOTTOM_THRESHOLD_PX = 4;
const VIEWPORT_FILL_PADDING_PX = 32;

const AI_THREAD_VIRTUAL_WINDOW_MIN_MESSAGES = 140;
const AI_THREAD_VIRTUAL_WINDOW_MAX_RENDERED_MESSAGES = 240;
const AI_THREAD_VIRTUAL_WINDOW_RECENT_MESSAGES = 120;
const AI_THREAD_ESTIMATED_MESSAGE_HEIGHT_PX = 112;
const AI_THREAD_MIN_ESTIMATED_MESSAGE_HEIGHT_PX = 72;
const AI_THREAD_MAX_ESTIMATED_MESSAGE_HEIGHT_PX = 640;
const AI_THREAD_BOTTOM_FOLLOW_THRESHOLD_PX = 48;

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

const conversationRootRef = ref<{ $el?: Element } | null>(null);
const renderedTimelineRef = ref<HTMLElement | null>(null);

const loadedVisibleMessageCount = ref(HISTORY_MESSAGE_INITIAL_COUNT);
const virtualWindowStart = ref(0);
const virtualWindowEnd = ref(0);
const estimatedMessageHeightPx = ref(AI_THREAD_ESTIMATED_MESSAGE_HEIGHT_PX);

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const shouldPreserveRestoredViewport = (): boolean => {
  const scrollState = props.scrollState;

  return Boolean(
    scrollState && scrollState.distanceFromBottom > RESTORED_SCROLL_FROM_BOTTOM_THRESHOLD_PX,
  );
};

const shouldUseVirtualWindow = computed(
  () =>
    !shouldPreserveRestoredViewport() &&
    visibleMessages.value.length > AI_THREAD_VIRTUAL_WINDOW_MIN_MESSAGES,
);

const renderedMessages = computed<IAiChatMessage[]>(() => {
  const messages = visibleMessages.value;

  if (!shouldUseVirtualWindow.value) {
    const loadedCount = Math.min(loadedVisibleMessageCount.value, messages.length);

    if (loadedCount >= messages.length) {
      return messages;
    }

    return messages.slice(messages.length - loadedCount);
  }

  const start = clamp(virtualWindowStart.value, 0, messages.length);
  const end = clamp(virtualWindowEnd.value, start, messages.length);

  return messages.slice(start, end);
});

const virtualTopSpacerHeight = computed(() => {
  if (!shouldUseVirtualWindow.value) {
    return 0;
  }

  return Math.max(0, virtualWindowStart.value * estimatedMessageHeightPx.value);
});

const virtualBottomSpacerHeight = computed(() => {
  if (!shouldUseVirtualWindow.value) {
    return 0;
  }

  const hiddenAfter = Math.max(0, visibleMessages.value.length - virtualWindowEnd.value);
  return hiddenAfter * estimatedMessageHeightPx.value;
});

const getConversationScrollElement = (): HTMLElement | null => {
  const root = conversationRootRef.value?.$el;

  if (!(root instanceof Element)) {
    return null;
  }

  return root.querySelector(':scope > div > div');
};

const syncLoadedCountFromVirtualWindow = (): void => {
  loadedVisibleMessageCount.value = Math.max(0, virtualWindowEnd.value - virtualWindowStart.value);
};

const measureRenderedWindowHeight = async (): Promise<void> => {
  await nextTick();

  const element = renderedTimelineRef.value;
  const count = renderedMessages.value.length;

  if (!element || count <= 0) {
    return;
  }

  const average = element.offsetHeight / count;

  if (!Number.isFinite(average) || average <= 0) {
    return;
  }

  estimatedMessageHeightPx.value = clamp(
    Math.round(estimatedMessageHeightPx.value * 0.82 + average * 0.18),
    AI_THREAD_MIN_ESTIMATED_MESSAGE_HEIGHT_PX,
    AI_THREAD_MAX_ESTIMATED_MESSAGE_HEIGHT_PX,
  );
};

const resetRenderedHistoryWindow = (): void => {
  const count = visibleMessages.value.length;

  if (shouldPreserveRestoredViewport()) {
    virtualWindowStart.value = 0;
    virtualWindowEnd.value = count;
    loadedVisibleMessageCount.value = count;
    return;
  }

  if (count <= AI_THREAD_VIRTUAL_WINDOW_MIN_MESSAGES) {
    virtualWindowStart.value = 0;
    virtualWindowEnd.value = count;
    loadedVisibleMessageCount.value = Math.min(count, HISTORY_MESSAGE_INITIAL_COUNT);
    void ensureRenderedHistoryFillsViewport();
    return;
  }

  const initialCount = Math.min(count, HISTORY_MESSAGE_INITIAL_COUNT);
  virtualWindowEnd.value = count;
  virtualWindowStart.value = Math.max(0, count - initialCount);
  syncLoadedCountFromVirtualWindow();

  void ensureRenderedHistoryFillsViewport();
};

const ensureRenderedHistoryFillsViewport = async (): Promise<void> => {
  await nextTick();

  const scrollElement = getConversationScrollElement();

  if (!scrollElement || shouldPreserveRestoredViewport()) {
    return;
  }

  if (shouldUseVirtualWindow.value) {
    while (
      virtualWindowStart.value > 0 &&
      scrollElement.scrollHeight <= scrollElement.clientHeight + VIEWPORT_FILL_PADDING_PX
    ) {
      virtualWindowStart.value = Math.max(0, virtualWindowStart.value - HISTORY_MESSAGE_LOAD_STEP);
      syncLoadedCountFromVirtualWindow();
      await nextTick();
    }

    await measureRenderedWindowHeight();
    scrollElement.scrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
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

  scrollElement.scrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
};

const loadOlderVisibleMessages = async (): Promise<void> => {
  if (shouldUseVirtualWindow.value) {
    if (virtualWindowStart.value <= 0) {
      return;
    }

    const scrollElement = getConversationScrollElement();
    const previousScrollTop = scrollElement?.scrollTop ?? null;

    const previousStart = virtualWindowStart.value;
    const nextStart = Math.max(0, previousStart - HISTORY_MESSAGE_LOAD_STEP);
    const addedCount = previousStart - nextStart;

    virtualWindowStart.value = nextStart;

    if (
      virtualWindowEnd.value - virtualWindowStart.value >
      AI_THREAD_VIRTUAL_WINDOW_MAX_RENDERED_MESSAGES
    ) {
      virtualWindowEnd.value = Math.max(
        virtualWindowStart.value,
        virtualWindowEnd.value - addedCount,
      );
    }

    syncLoadedCountFromVirtualWindow();

    await nextTick();
    await measureRenderedWindowHeight();

    if (scrollElement && previousScrollTop !== null) {
      scrollElement.scrollTop = previousScrollTop;
    }

    return;
  }

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

const moveVirtualWindowToTail = async (): Promise<void> => {
  if (!shouldUseVirtualWindow.value || shouldPreserveRestoredViewport()) {
    return;
  }

  const count = visibleMessages.value.length;
  const size = Math.min(count, AI_THREAD_VIRTUAL_WINDOW_RECENT_MESSAGES);

  virtualWindowEnd.value = count;
  virtualWindowStart.value = Math.max(0, count - size);
  syncLoadedCountFromVirtualWindow();

  await nextTick();
  await measureRenderedWindowHeight();

  const scrollElement = getConversationScrollElement();

  if (scrollElement) {
    scrollElement.scrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
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
    if (!shouldPreserveRestoredViewport()) {
      return;
    }

    const count = visibleMessages.value.length;
    virtualWindowStart.value = 0;
    virtualWindowEnd.value = count;
    loadedVisibleMessageCount.value = count;
  },
  { immediate: true },
);

watch(
  () => visibleMessages.value.length,
  (nextLength, previousLength) => {
    if (shouldPreserveRestoredViewport()) {
      virtualWindowStart.value = 0;
      virtualWindowEnd.value = nextLength;
      loadedVisibleMessageCount.value = nextLength;
      return;
    }

    if (previousLength === 0) {
      resetRenderedHistoryWindow();
      return;
    }

    if (!shouldUseVirtualWindow.value) {
      if (nextLength <= loadedVisibleMessageCount.value) {
        loadedVisibleMessageCount.value = nextLength;
      } else {
        void ensureRenderedHistoryFillsViewport();
      }
      return;
    }

    const appended = nextLength > previousLength;
    const wasAtTail = virtualWindowEnd.value >= previousLength;

    if (appended && wasAtTail) {
      virtualWindowEnd.value = nextLength;

      if (
        virtualWindowEnd.value - virtualWindowStart.value >
        AI_THREAD_VIRTUAL_WINDOW_MAX_RENDERED_MESSAGES
      ) {
        virtualWindowStart.value = Math.max(
          0,
          virtualWindowEnd.value - AI_THREAD_VIRTUAL_WINDOW_RECENT_MESSAGES,
        );
      }

      syncLoadedCountFromVirtualWindow();
      void ensureRenderedHistoryFillsViewport();
      return;
    }

    virtualWindowStart.value = clamp(virtualWindowStart.value, 0, nextLength);
    virtualWindowEnd.value = clamp(virtualWindowEnd.value, virtualWindowStart.value, nextLength);
    syncLoadedCountFromVirtualWindow();
    void measureRenderedWindowHeight();
  },
);

watch(
  renderedMessages,
  () => {
    void measureRenderedWindowHeight();
  },
  { flush: 'post' },
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

const conversationInitialScroll = computed(() => !props.scrollState);
const conversationResizeMode = computed(() => (props.isTyping ? undefined : 'instant'));

const handleChangedFilesRollback = (messageId: string, summaryId: string): void => {
  emit('changedFilesRollback', messageId, summaryId);
};

const handleChangedFilesPin = (messageId: string, summaryId: string, pinned: boolean): void => {
  emit('changedFilesPin', messageId, summaryId, pinned);
};

const handleScrollStateChange = (state: IAiChatScrollState): void => {
  if (shouldUseVirtualWindow.value) {
    const preloadTop = virtualTopSpacerHeight.value + HISTORY_SCROLL_PRELOAD_THRESHOLD_PX;

    if (state.scrollTop <= preloadTop) {
      void loadOlderVisibleMessages();
    }

    if (state.distanceFromBottom <= AI_THREAD_BOTTOM_FOLLOW_THRESHOLD_PX) {
      void moveVirtualWindowToTail();
    }

    emit('scrollStateChange', state);
    return;
  }

  if (state.scrollTop <= HISTORY_SCROLL_PRELOAD_THRESHOLD_PX) {
    void loadOlderVisibleMessages();
  }

  emit('scrollStateChange', state);
};
</script>

<template>
  <Conversation
    ref="conversationRootRef"
    class="relative size-full overflow-x-hidden ai-chat-list"
    aria-label="AI 对话记录"
    :initial="conversationInitialScroll"
    :resize="conversationResizeMode"
    :restore-key="conversationId"
    :initial-scroll-top="scrollState?.scrollTop ?? null"
    :initial-distance-from-bottom="scrollState?.distanceFromBottom ?? null"
    @scroll-state-change="handleScrollStateChange"
  >
    <ConversationContent class="ai-chat-list__content" :class="{ 'is-empty': shouldRenderEmptyState }">
      <slot v-if="shouldRenderEmptyState" name="empty">
        <ConversationEmptyState class="ai-chat-empty-state" title="还没有对话" description="选择一个提示词，或直接输入你的问题。">
          <template #icon>
            <MessageSquare class="size-6" />
          </template>
        </ConversationEmptyState>
      </slot>

      <template v-else>
        <div class="ai-chat-list__virtual-stack">
          <div
            v-if="virtualTopSpacerHeight > 0"
            class="ai-chat-list__virtual-spacer"
            :style="{ height: virtualTopSpacerHeight + 'px' }"
            aria-hidden="true"
          />

          <div ref="renderedTimelineRef" class="ai-chat-list__virtual-window">
            <AiThreadTimeline
              :messages="renderedMessages"
              :workspace-root-path="workspaceRootPath"
              :plan-details="planDetails"
              :reverting-changed-files-summary-id="revertingChangedFilesSummaryId"
              :pinning-changed-files-summary-id="pinningChangedFilesSummaryId"
              @changed-files-rollback="handleChangedFilesRollback"
              @changed-files-pin="handleChangedFilesPin"
              @plan-approve="emit('planApprove')"
              @plan-reject="emit('planReject')"
              @plan-regenerate="emit('planRegenerate')"
              @plan-update-step-title="(stepId: string, title: string) => emit('planUpdateStepTitle', stepId, title)"
              @plan-remove-step="emit('planRemoveStep', $event)"
            >
              <template #after-message="{ message }">
                <slot name="after-message" :message="message" />
              </template>
            </AiThreadTimeline>
          </div>

          <div
            v-if="virtualBottomSpacerHeight > 0"
            class="ai-chat-list__virtual-spacer"
            :style="{ height: virtualBottomSpacerHeight + 'px' }"
            aria-hidden="true"
          />

          <slot name="after-messages" />
        </div>

        <Message
          v-if="shouldRenderStandaloneTyping"
          from="assistant"
          class="ai-message-typing"
          :aria-label="typingLabel"
        >
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

.ai-chat-list__virtual-stack {
  display: flex;
  width: 100%;
  min-width: 0;
  flex-direction: column;
}

.ai-chat-list__virtual-window {
  width: 100%;
  min-width: 0;
}

.ai-chat-list__virtual-spacer {
  flex: 0 0 auto;
  width: 100%;
  min-height: 0;
  pointer-events: none;
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
`;

fs.writeFileSync(targetPath, component);

console.log('✅ Fixed Round 20 AI thread windowing');
console.log(`🧷 Backup: ${path.relative(repoRoot, backupPath)}`);
console.log(`📝 Updated: ${path.relative(repoRoot, targetPath)}`);