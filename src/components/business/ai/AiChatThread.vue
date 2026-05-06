<script setup lang="ts">
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Loader } from '@/components/ai-elements/loader';
import type { TAiServicePlatformId } from '@/constants/ai-providers';
import type { IAiChatMessage, TAiChatMessageActionId } from '@/types/ai';
import { computed } from 'vue';
import AiMessageItem from './AiMessageItem.vue';

const props = defineProps<{
  messages: IAiChatMessage[];
  isTyping: boolean;
  platformId: TAiServicePlatformId;
  providerLabel: string;
}>();

const emit = defineEmits<{
  messageAction: [messageId: string, actionId: TAiChatMessageActionId];
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

const lastAssistantMessageId = computed(() => {
  for (let index = props.messages.length - 1; index >= 0; index -= 1) {
    const message = props.messages[index];

    if (message?.role === 'assistant') {
      return message.id;
    }
  }

  return null;
});

const handleMessageAction = (messageId: string, actionId: TAiChatMessageActionId): void => {
  emit('messageAction', messageId, actionId);
};
</script>

<template>
  <Conversation class="ai-chat-list overflow-x-hidden" aria-label="AI 对话记录">
    <ConversationContent v-if="messages.length > 0 || shouldRenderStandaloneTyping" class="ai-chat-list__content">
      <slot name="before-messages" />
      <template v-for="message in messages" :key="message.id">
        <slot v-if="message.id === lastAssistantMessageId" name="before-last-assistant" :message="message" />
        <AiMessageItem :message="message" :platform-id="platformId" :provider-label="providerLabel"
          @message-action="handleMessageAction" />
        <slot name="after-message" :message="message" />
      </template>
      <slot name="after-messages" />
      <article v-if="shouldRenderStandaloneTyping" class="ai-message-typing" aria-label="AI 正在准备回复">
        <div class="typing-status" role="status" aria-live="polite">
          <Loader class="typing-status-icon" :size="13" />
          <span>AI 正在准备回复</span>
        </div>
      </article>
    </ConversationContent>
    
  </Conversation>
</template>

<style scoped>
.ai-chat-list {
  min-height: 0;
  flex: 1 1 0;
}

.ai-chat-list__content {
  min-width: 0;
  gap: 14px;
  overflow-x: hidden;
  padding: 14px 0;
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
  align-items: center;
  padding-inline: 30px;
}

.typing-status {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  color: var(--text-quaternary);
  font-size: 12px;
  line-height: 18px;
  min-height: 22px;
}

.typing-status-icon {
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
  color: var(--text-tertiary);
}
</style>
