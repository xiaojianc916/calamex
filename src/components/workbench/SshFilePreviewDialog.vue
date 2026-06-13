<script setup lang="ts">
import SshFilePreviewDialog from '@/components/workbench/sidebar/ssh/SshFilePreviewDialog.vue';
import type { ISshFileItem } from '@/types/ssh';
import type { ISshFileReadPayload } from '@/types/tauri';

defineProps<{
  fileItem: ISshFileItem;
  payload: ISshFileReadPayload | null;
  isLoading: boolean;
  isSaving: boolean;
}>();

defineEmits<{
  close: [];
  reload: [];
  download: [];
  save: [content: string];
}>();
</script>

<template>
  <SshFilePreviewDialog
    :file-item="fileItem"
    :payload="payload"
    :is-loading="isLoading"
    :is-saving="isSaving"
    @close="$emit('close')"
    @reload="$emit('reload')"
    @download="$emit('download')"
    @save="$emit('save', $event)"
  />
</template>
