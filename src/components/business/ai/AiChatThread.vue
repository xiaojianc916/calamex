<script setup lang="ts">
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Loader } from '@/components/ai-elements/loader';
import { Message } from '@/components/ai-elements/message';
import type { TAiServicePlatformId } from '@/constants/ai-providers';
import type { IAiChatMessage, TAiChatMessageActionId } from '@/types/ai';
import { MessageSquareIcon } from 'lucide-vue-next';
import { computed } from 'vue';
import AiMessageItem from './AiMessageItem.vue';

interface IAiChatScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distanceFromBottom: number;
}

const props = defineProps<{
  messages: IAiChatMessage[];
  isTyping: boolean;
  platformId: TAiServicePlatformId;
  providerLabel: string;
  conversationId: string | null;
  scrollState: IAiChatScrollState | null;
}>();

const emit = defineEmits<{
  messageAction: [messageId: string, actionId: TAiChatMessageActionId];
  scrollStateChange: [state: IAiChatScrollState];
}>();

const TOOL_PROGRESS_PREFIXES = [
  'AI 正在自动分析并按需调用工具…',
  'AI 正在自动使用工具：',
  'Agent 正在调用工具…',
  'Agent 正在根据你的确认继续执行…',
] as const;

const hasInlineProgressMessage = computed(() => {
  const lastMessage = props.messages.at(-1);
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
  () => props.messages.length === 0 && !shouldRenderStandaloneTyping.value,
);

const lastAssistantMessageId = computed(() => {
  for (let index = props.messages.length - 1; index >= 0; index -= 1) {
    const message = props.messages[index];

    if (message?.role === 'assistant') {
      return message.id;
    }
  }

  return null;
});
const conversationInitialScroll = computed(() => props.scrollState ? false : 'instant');

const handleMessageAction = (messageId: string, actionId: TAiChatMessageActionId): void => {
  emit('messageAction', messageId, actionId);
};

const handleScrollStateChange = (state: IAiChatScrollState): void => {
  emit('scrollStateChange', state);
};
</script>

<template>
  <Conversation class="relative size-full overflow-x-hidden ai-chat-list" aria-label="AI 对话记录"
    :initial="conversationInitialScroll" :restore-key="conversationId"
    :initial-scroll-top="scrollState?.scrollTop ?? null"
    :initial-distance-from-bottom="scrollState?.distanceFromBottom ?? null"
    @scroll-state-change="handleScrollStateChange">
    <ConversationContent class="ai-chat-list__content" :class="{ 'is-empty': shouldRenderEmptyState }">
      <slot v-if="shouldRenderEmptyState" name="empty">
        <ConversationEmptyState class="ai-chat-empty-state" title="还没有对话" description="选择一个提示词，或直接输入你的问题。">
          <template #icon>
            <MessageSquareIcon class="size-6" />
          </template>
        </ConversationEmptyState>
      </slot>
      <template v-else>
        <slot name="before-messages" />
        <template v-for="message in messages" :key="message.id">
          <slot v-if="message.id === lastAssistantMessageId" name="before-last-assistant" :message="message" />
          <AiMessageItem
:message="message" :platform-id="platformId" :provider-label="providerLabel"
            @message-action="handleMessageAction" />
          <slot name="after-message" :message="message" />
        </template>
        <slot name="after-messages" />
        <Message v-if="shouldRenderStandaloneTyping" from="assistant" class="ai-message-typing" aria-label="AI 正在准备回复">
          <div class="typing-status" role="status" aria-live="polite">
            <Loader class="typing-status-icon" :size="13" />
            <span>AI 正在准备回复</span>
          </div>
        </Message>
      </template>
    </ConversationContent>
    <ConversationScrollButton v-if="messages.length > 0" class="ai-chat-scroll-button" />
  </Conversation>
</template>

<style scoped>
.ai-chat-list {
  min-height: 0;
  flex: 1 1 0;
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

.ai-chat-list {
  scrollbar-color: color-mix(in srgb, var(--text-primary) 10%, transparent) transparent;
  scrollbar-width: thin;
}

.ai-chat-list::-webkit-scrollbar {
  width: 8px;
}

.ai-chat-list::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-primary) 10%, transparent);
  background-clip: content-box;
}

.ai-message-typing {
  display: flex;
  min-width: 0;
  align-items: flex-start;
}

.typing-status {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  color: var(--text-quaternary);
  font-size: 14px;
  line-height: 22px;
  min-height: 24px;
}

.typing-status-icon {
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
  color: var(--text-tertiary);
}
</style>
