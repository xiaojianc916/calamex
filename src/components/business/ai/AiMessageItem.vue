<script setup lang="ts">
import { computed } from 'vue';
import AiMarkdown from '@/components/business/ai/AiMarkdown.vue';
import type { IAiChatMessage } from '@/types/ai';
import type { IAiCodeBlock, IAiCodePathTarget } from '@/types/ai-code';

const props = defineProps<{
  message: IAiChatMessage;
  avatarUrl: string | null;
  avatarAlt: string;
}>();

const emit = defineEmits<{
  applyCode: [block: IAiCodeBlock];
  openCodePath: [target: IAiCodePathTarget];
}>();

const metaLabel = computed(() => {
  if (props.message.role === 'user') return timeLabel.value;
  if (props.message.role === 'tool') return '工具';
  if (props.message.role === 'system') return '系统';
  return 'AI';
});

const timeLabel = computed(() => {
  const timestamp = Date.parse(props.message.createdAt);
  if (!Number.isFinite(timestamp)) return '刚刚';
  const deltaSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (deltaSeconds < 60) return '刚刚';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
});
</script>

<template>
  <article class="ai-message" :class="`is-${message.role}`">
    <svg
      v-if="message.role !== 'user' && !avatarUrl"
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
      v-else-if="message.role !== 'user'"
      class="ai-logo"
      :src="avatarUrl"
      :alt="avatarAlt"
      loading="lazy"
      referrerpolicy="no-referrer"
    />
    <div class="ai-message-main">
      <div class="ai-message-bubble">
        <AiMarkdown
          :message-id="message.id"
          :content="message.content"
          :stable-content="message.stream?.stableContent"
          :open-block="message.stream?.openBlock"
          :can-apply-code="message.role === 'assistant'"
          @apply-code="emit('applyCode', $event)"
          @open-code-path="emit('openCodePath', $event)"
        />
      </div>
      <div class="ai-message-meta">
        <template v-if="message.role === 'user'">{{ metaLabel }}</template>
        <template v-else>{{ metaLabel }} · {{ timeLabel }}</template>
      </div>
    </div>
  </article>
</template>

<style scoped>
.ai-message {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.ai-message.is-user {
  justify-content: flex-end;
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

.ai-message-main {
  min-width: 0;
  max-width: 310px;
}

.ai-message-bubble {
  border-radius: 8px;
  padding: 9px 11px;
  background: color-mix(in srgb, var(--surface-soft) 78%, transparent);
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
}

.ai-message:not(.is-user) .ai-message-bubble {
  border-top-left-radius: 4px;
}

.ai-message.is-user .ai-message-bubble {
  border-top-right-radius: 4px;
  background: var(--accent-strong);
  color: var(--accent-foreground, white);
}

.ai-message-meta {
  margin-top: 4px;
  color: var(--text-quaternary);
  font-size: 11px;
  line-height: 14px;
  letter-spacing: 0.02em;
}

.ai-message.is-user .ai-message-meta {
  text-align: right;
}
</style>
