<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import type { IAiChatMessage } from '@/types/ai';
import type { IAiCodeBlock, IAiCodePathTarget } from '@/types/ai-code';
import AiMessageItem from './AiMessageItem.vue';

const props = defineProps<{
  messages: IAiChatMessage[];
  isTyping: boolean;
  avatarUrl: string | null;
  avatarAlt: string;
}>();

const listRef = ref<HTMLElement | null>(null);

const emit = defineEmits<{
  applyCode: [block: IAiCodeBlock];
  openCodePath: [target: IAiCodePathTarget];
}>();

const scrollToBottom = async (): Promise<void> => {
  await nextTick();
  const list = listRef.value;
  if (!list) return;
  list.scrollTop = list.scrollHeight;
};

watch(
  () => [props.messages.length, props.isTyping],
  () => {
    void scrollToBottom();
  },
);

onMounted(() => {
  void scrollToBottom();
});
</script>

<template>
  <div ref="listRef" class="ai-chat-list" aria-label="AI 对话记录">
    <AiMessageItem
      v-for="message in messages"
      :key="message.id"
      :message="message"
      :avatar-url="avatarUrl"
      :avatar-alt="avatarAlt"
      @apply-code="emit('applyCode', $event)"
      @open-code-path="emit('openCodePath', $event)"
    />
    <article v-if="isTyping" class="ai-message-typing" aria-label="AI 正在输入">
      <svg
        v-if="!avatarUrl"
        class="ai-logo"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path d="M12 3l1.9 5.2L19 10l-5.1 1.8L12 17l-1.9-5.2L5 10l5.1-1.8L12 3z" />
        <path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8L18 15z" />
      </svg>
      <img
        v-else
        class="ai-logo"
        :src="avatarUrl"
        :alt="avatarAlt"
        loading="lazy"
        referrerpolicy="no-referrer"
      />
      <div class="typing-bubble">
        <span></span>
        <span></span>
        <span></span>
      </div>
    </article>
  </div>
</template>

<style scoped>
.ai-chat-list {
  display: flex;
  min-height: 0;
  flex: 1 1 0;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  padding: 14px 12px;
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
  align-items: flex-start;
  gap: 8px;
}

.ai-logo {
  width: 22px;
  height: 22px;
  flex: 0 0 auto;
  margin-top: 1px;
  border-radius: 5px;
  color: var(--accent-strong);
  object-fit: contain;
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.typing-bubble {
  display: flex;
  width: fit-content;
  align-items: center;
  gap: 4px;
  border-radius: 8px;
  border-top-left-radius: 4px;
  background: color-mix(in srgb, var(--surface-soft) 78%, transparent);
  padding: 9px 11px;
}

.typing-bubble span {
  width: 5px;
  height: 5px;
  border-radius: 999px;
  animation: ai-blink 1.2s infinite ease-in-out;
  background: var(--text-quaternary);
}

.typing-bubble span:nth-child(2) {
  animation-delay: 140ms;
}

.typing-bubble span:nth-child(3) {
  animation-delay: 280ms;
}

@keyframes ai-blink {
  0%,
  80%,
  100% {
    opacity: 0.28;
  }

  40% {
    opacity: 1;
  }
}
</style>
