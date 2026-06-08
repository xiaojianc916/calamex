<script setup lang="ts">
import { computed } from 'vue';
import { ImageAttachmentPreviewGrid } from '@/components/ai-elements/image';
import AiMarkdown from '@/components/business/ai/chat/AiMarkdown.vue';
import type { IAiContextReference } from '@/types/ai';
import type { IAiThreadUserMessageEntry } from './projection';

const props = defineProps<{
  entry: IAiThreadUserMessageEntry;
}>();

const isAttachmentReference = (reference: IAiContextReference): boolean =>
  reference.id.startsWith('attachment:');

const resolveAttachmentLabel = (reference: IAiContextReference): string => {
  const path = reference.path?.trim() ?? '';

  if (path.length > 0) {
    return path;
  }

  return reference.label
    .replace(/^图片附件\s*·\s*/u, '')
    .replace(/^附件\s*·\s*/u, '')
    .trim();
};

const resolveAttachmentMediaType = (reference: IAiContextReference): string =>
  reference.kind === 'image-attachment' ? 'image/*' : 'text/plain';

const attachmentItems = computed(() =>
  props.entry.references.filter(isAttachmentReference).map((reference) => ({
    id: reference.id,
    name: resolveAttachmentLabel(reference),
    preview: reference.attachmentPreview,
    mediaType: reference.attachmentPreview?.mimeType ?? resolveAttachmentMediaType(reference),
  })),
);
</script>

<template>
  <div class="ai-thread-user-message">
    <ImageAttachmentPreviewGrid
      v-if="attachmentItems.length > 0"
      class="ai-thread-user-message__attachments"
      :items="attachmentItems"
      aria-label="已发送附件"
      variant="message"
    />
    <div class="ai-thread-user-message__body">
      <AiMarkdown :message-id="entry.messageId" :content="entry.markdown" />
    </div>
  </div>
</template>

<style scoped>
.ai-thread-user-message {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  min-width: 0;
}

.ai-thread-user-message__attachments {
  max-width: min(520px, 100%);
}

.ai-thread-user-message__body {
  align-self: flex-start;
  min-width: 0;
  max-width: 100%;
  border-radius: 10px;
  background: color-mix(in srgb, var(--shell-divider) 30%, transparent);
  padding: 8px 12px;
  color: var(--text-primary);
  font-size: 14px;
  line-height: 22px;
  overflow-wrap: anywhere;
}
</style>
