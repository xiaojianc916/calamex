<script setup lang="ts">
import { computed } from 'vue';
import AiMarkdown from '@/components/business/ai/chat/AiMarkdown.vue';
import type { IAiChatStreamRenderState } from '@/types/ai';
import type { IAiThreadAssistantTextEntry } from './projection';

const props = defineProps<{
  entry: IAiThreadAssistantTextEntry;
}>();

const streamStatus = computed<IAiChatStreamRenderState['status'] | undefined>(() =>
  props.entry.streaming ? 'streaming' : undefined,
);
</script>

<template>
  <div class="ai-thread-assistant-text">
    <AiMarkdown
      :message-id="entry.messageId"
      :content="entry.markdown"
      :stream-status="streamStatus"
    />
  </div>
</template>

<style scoped>
.ai-thread-assistant-text {
  min-width: 0;
  max-width: 100%;
  color: var(--text-primary);
  font-size: 14px;
  line-height: 22px;
  overflow-wrap: anywhere;
}
</style>
