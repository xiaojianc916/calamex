<script setup lang="ts">
import { Brain, BrainCircuit } from '@lucide/vue';
import { computed } from 'vue';
import { ThreadEntryDisclosure } from '@/components/ai-elements/thread-entry';
import AiMarkdown from '@/components/business/ai/chat/AiMarkdown.vue';
import type { IAiChatStreamRenderState } from '@/types/ai';
import type { IAiThreadReasoningEntry } from './projection';

const props = defineProps<{
  entry: IAiThreadReasoningEntry;
  open: boolean;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
}>();

const title = computed(() => (props.entry.streaming ? '正在推理…' : '推理'));

const reasoningText = computed(() =>
  props.entry.segments
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join('\n\n'),
);

const streamStatus = computed<IAiChatStreamRenderState['status'] | undefined>(() =>
  props.entry.streaming ? 'streaming' : undefined,
);
</script>

<template>
  <ThreadEntryDisclosure
    class="ai-thread-reasoning"
    :open="open"
    :title="title"
    @update:open="emit('update:open', $event)"
  >
    <template #leading>
      <BrainCircuit class="size-4 text-blue-500" v-if="entry.streaming" aria-hidden="true" />
      <Brain class="size-4 text-muted-foreground" v-else aria-hidden="true" />
    </template>
    <template #content>
      <AiMarkdown
        class="ai-thread-reasoning__text"
        :message-id="`${entry.messageId}:reasoning`"
        :content="reasoningText"
        :stream-status="streamStatus"
      />
    </template>
  </ThreadEntryDisclosure>
</template>

<style scoped>
.ai-thread-reasoning__text {
  color: var(--text-tertiary, #6b7280);
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
}
</style>
