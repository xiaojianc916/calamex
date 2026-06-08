<script setup lang="ts">
import AiChangedFilesSummary from '@/components/business/ai/edit/AiChangedFilesSummary.vue';
import type { IAiPatchSet } from '@/types/ai';
import type { IAiThreadChangedFilesSummaryEntry } from './projection';

const props = defineProps<{
  entry: IAiThreadChangedFilesSummaryEntry;
  patches?: readonly IAiPatchSet[];
  workspaceRootPath?: string | null;
  isReverting?: boolean;
  isPinning?: boolean;
}>();

const emit = defineEmits<{
  undo: [messageId: string, summaryId: string];
  pin: [messageId: string, summaryId: string, pinned: boolean];
}>();

void props;
</script>

<template>
  <AiChangedFilesSummary
    class="ai-thread-changed-files-summary"
    variant="message"
    :summary="entry.summary"
    :patches="patches ?? []"
    :workspace-root-path="workspaceRootPath"
    :is-reverting="isReverting"
    :is-pinning="isPinning"
    @undo="(summaryId: string) => emit('undo', entry.messageId, summaryId)"
    @pin="(summaryId: string, pinned: boolean) => emit('pin', entry.messageId, summaryId, pinned)"
  />
</template>

<style scoped>
.ai-thread-changed-files-summary {
  width: min(100%, 640px);
}
</style>
