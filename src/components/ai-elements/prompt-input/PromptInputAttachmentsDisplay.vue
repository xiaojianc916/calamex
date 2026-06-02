<script setup lang="ts">
import { computed } from 'vue';
import { ImageAttachmentPreviewGrid } from '@/components/ai-elements/image';
import type { IAiAttachedFile } from '@/types/ai';

const props = defineProps<{
  attachments: readonly IAiAttachedFile[];
}>();

const emit = defineEmits<{
  remove: [id: string];
}>();

const attachmentItems = computed(() =>
  props.attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    preview: attachment.preview,
    mediaType: attachment.preview?.mimeType ?? resolveAttachmentMediaType(attachment),
    detailLabel: attachment.detailLabel,
    status: attachment.status ?? 'ready',
    errorMessage: attachment.errorMessage,
  })),
);

const handleRemove = (id: string): void => {
  emit('remove', id);
};

const resolveAttachmentMediaType = (attachment: IAiAttachedFile): string =>
  attachment.kind === 'image' ? 'image/*' : 'text/plain';
</script>

<template>
  <div class="prompt-input-attachments-display" aria-label="已添加附件">
    <ImageAttachmentPreviewGrid
      v-if="attachmentItems.length"
      :items="attachmentItems"
      aria-label="已添加附件"
      removable
      variant="composer"
      @remove="handleRemove"
    />
  </div>
</template>

<style scoped>
.prompt-input-attachments-display {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
}
</style>
