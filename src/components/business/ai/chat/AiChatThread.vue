<script setup lang="ts">
import { computed } from 'vue';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message } from '@/components/ai-elements/message';
import type { TAiServicePlatformId } from '@/constants/ai/providers';
import type { IAiChatMessage, TAiChatMessageActionId } from '@/types/ai';
import AiMessageItem from './AiMessageItem.vue';
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
    revertingChangedFilesSummaryId?: string | null;
    pinningChangedFilesSummaryId?: string | null;
  }>(),
  {
    typingLabel: '正在思考',
    conversationId: null,
    workspaceRootPath: null,
    scrollState: null,
    hasExtraContent: false,
    revertingChangedFilesSummaryId: null,
    pinningChangedFilesSummaryId: null,
  },
);

const emit = defineEmits<{
  messageAction: [messageId: string, actionId: TAiChatMessageActionId];
  changedFilesRollback: [messageId: string, summaryId: string];
  changedFilesPin: [messageId: string, summaryId: string, pinned: boolean];
  scrollStateChange: [state: IAiChatScrollState];
}>();

const TOOL_PROGRESS_PREFIXES = [
  'AI 正在自动分析并按需调用工具…',
  'AI 正在自动使用工具：',
  'Agent 正在调用工具…',
  'Agent 正在根据你的确认继续执行…',
] as const;
// 报错只在输入框上方以一条居中提示线呈现，因此这些“把报错当回复”的助手占位消息
// 不再进入对话流，避免同一个错误出现两次。
const ERROR_REPLY_PREFIXES = ['Agent 执行失败：', 'AI 上下文收集失败：', '计划生成失败：'] as const;
const CONTEXT_COMPRESSION_EVENT_TYPE = 'acontext.memory.compressed';

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

const visibleMessages = computed<IAiChatMessage[]>(() =>
  props.messages.filter((message) => !isErrorReplyMessage(message)),
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

const lastAssistantMessageId = computed(() => {
  for (let index = visibleMessages.value.length - 1; index >= 0; index -= 1) {
    const message = visibleMessages.value[index];

    if (message?.role === 'assistant') {
      return message.id;
    }
  }

  return null;
});
const conversationInitialScroll = computed(() => !props.scrollState);
const conversationResizeMode = computed(() => (props.isTyping ? undefined : 'instant'));

const handleMessageAction = (messageId: string, actionId: TAiChatMessageActionId): void => {
  emit('messageAction', messageId, actionId);
};

const handleChangedFilesRollback = (messageId: string, summaryId: string): void => {
  emit('changedFilesRollback', messageId, summaryId);
};

const handleChangedFilesPin = (messageId: string, summaryId: string, pinned: boolean): void => {
  emit('changedFilesPin', messageId, summaryId, pinned);
};

const handleScrollStateChange = (state: IAiChatScrollState): void => {
  emit('scrollStateChange', state);
};

const hasContextCompressionMarker = (message: IAiChatMessage): boolean =>
  Boolean(
    message.stream?.runtimeEvents?.some((event) => event.type === CONTEXT_COMPRESSION_EVENT_TYPE),
  );
</script>

<template>
  <Conversation class="relative size-full overflow-x-hidden ai-chat-list" aria-label="AI 对话记录"
    :initial="conversationInitialScroll" :resize="conversationResizeMode" :restore-key="conversationId"
    :initial-scroll-top="scrollState?.scrollTop ?? null"
    :initial-distance-from-bottom="scrollState?.distanceFromBottom ?? null"
    @scroll-state-change="handleScrollStateChange">
    <ConversationContent class="ai-chat-list__content" :class="{ 'is-empty': shouldRenderEmptyState }">
      <slot v-if="shouldRenderEmptyState" name="empty">
        <ConversationEmptyState class="ai-chat-empty-state" title="还没有对话" description="选择一个提示词，或直接输入你的问题。">
          <template #icon>
            <span class="icon-[lucide--message-square] size-6"  />
          </template>
        </ConversationEmptyState>
      </slot>
      <template v-else>
        <slot name="before-messages" />
        <template v-for="message in visibleMessages" :key="message.id">
          <slot v-if="message.id === lastAssistantMessageId" name="before-last-assistant" :message="message" />
          <AiMessageItem :message="message" :platform-id="platformId" :provider-label="providerLabel"
            :workspace-root-path="workspaceRootPath"
            :reverting-changed-files-summary-id="revertingChangedFilesSummaryId"
            :pinning-changed-files-summary-id="pinningChangedFilesSummaryId" @message-action="handleMessageAction"
            @changed-files-rollback="handleChangedFilesRollback" @changed-files-pin="handleChangedFilesPin" />
          <div v-if="hasContextCompressionMarker(message)" class="ai-context-compression-divider" role="status"
            aria-label="上下文已自动压缩">
            <span class="ai-context-compression-divider__label">
              <span class="icon-[lucide--archive] ai-context-compression-divider__icon" aria-hidden="true"  />
              <span>上下文已自动压缩</span>
            </span>
          </div>
          <slot name="after-message" :message="message" />
        </template>
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

.ai-chat-list.is-scrollbar-active :deep(> div > div),
.ai-chat-list:focus-within :deep(> div > div) {
  scrollbar-color: color-mix(in srgb, var(--text-primary) 18%, transparent) transparent;
}

@media (hover: hover) {
  .ai-chat-list:hover :deep(> div > div) {
    scrollbar-color: color-mix(in srgb, var(--text-primary) 18%, transparent) transparent;
  }
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
}

.ai-chat-list.is-scrollbar-active :deep(> div > div)::-webkit-scrollbar-thumb,
.ai-chat-list:focus-within :deep(> div > div)::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--text-primary) 18%, transparent);
}

@media (hover: hover) {
  .ai-chat-list:hover :deep(> div > div)::-webkit-scrollbar-thumb {
    background-color: color-mix(in srgb, var(--text-primary) 18%, transparent);
  }
}

.ai-chat-list :deep(> div > div)::-webkit-scrollbar-thumb:hover {
  background-color: color-mix(in srgb, var(--text-primary) 28%, transparent);
}

.ai-chat-list__content {
  min-width: 0;
  gap: 32px;
  min-height: 100%;
  overflow-x: hidden;
  padding: 16px 16px 24px;
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

.ai-context-compression-divider {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
  color: var(--text-tertiary);
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
}

.ai-context-compression-divider::before,
.ai-context-compression-divider::after {
  height: 1px;
  min-width: 24px;
  flex: 1 1 0;
  background: color-mix(in srgb, var(--shell-divider) 86%, transparent);
  content: '';
}

.ai-context-compression-divider__label {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.ai-context-compression-divider__icon {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  stroke-width: 1.8;
}
</style>
