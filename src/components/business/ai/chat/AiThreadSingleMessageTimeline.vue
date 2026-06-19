<script setup lang="ts">
import { computed } from 'vue';
import AiThreadEntryView from '@/components/business/ai/thread/AiThreadEntryView.vue';
import {
  buildSingleMessageThreadEntries,
  type TAiThreadEntry,
} from '@/components/business/ai/thread/projection';
import type { IAiThreadPlanDetails } from '@/components/business/ai/thread/types';
import { useThreadEntryExpansion } from '@/components/business/ai/thread/useThreadEntryExpansion';
import type { IAiChatMessage, IAiPatchSet } from '@/types/ai';

const props = defineProps<{
  message: IAiChatMessage;
  workspaceRootPath?: string | null;
  planDetails?: IAiThreadPlanDetails;
  revertingChangedFilesSummaryId?: string | null;
  pinningChangedFilesSummaryId?: string | null;
}>();

const emit = defineEmits<{
  changedFilesRollback: [messageId: string, summaryId: string];
  changedFilesPin: [messageId: string, summaryId: string, pinned: boolean];
  planApprove: [];
  planReject: [];
  planRegenerate: [];
  planUpdateStepTitle: [stepId: string, title: string];
  planRemoveStep: [stepId: string];
}>();

const entries = computed<TAiThreadEntry[]>(() => buildSingleMessageThreadEntries(props.message));

const expansion = useThreadEntryExpansion(entries);

const lastEntryId = computed(() => entries.value.at(-1)?.id ?? null);

const isMessageBoundary = (entry: TAiThreadEntry): boolean => entry.id === lastEntryId.value;

const patchesForMessage = computed<readonly IAiPatchSet[]>(() => props.message.patches ?? []);

const shouldAddUserReplyGap = (entry: TAiThreadEntry, index: number): boolean => {
  const previousEntry = entries.value[index - 1];

  return previousEntry?.kind === 'user-message' && entry.kind !== 'user-message';
};

const handlePlanUpdateStepTitle = (stepId: string, title: string): void => {
  emit('planUpdateStepTitle', stepId, title);
};

const handlePlanRemoveStep = (stepId: string): void => {
  emit('planRemoveStep', stepId);
};

const handleChangedFilesRollback = (messageId: string, summaryId: string): void => {
  emit('changedFilesRollback', messageId, summaryId);
};

const handleChangedFilesPin = (messageId: string, summaryId: string, pinned: boolean): void => {
  emit('changedFilesPin', messageId, summaryId, pinned);
};
</script>

<template>
  <div class="ai-thread-single-message">
    <template v-for="(entry, index) in entries" :key="entry.id">
      <AiThreadEntryView
        :entry="entry"
        :open="expansion.isExpanded(entry)"
        :after-user="shouldAddUserReplyGap(entry, index)"
        :plan-details="planDetails"
        :workspace-root-path="workspaceRootPath"
        :summary-patches="patchesForMessage"
        :tool-call-patches="patchesForMessage"
        :tool-call-workspace-root-path="workspaceRootPath"
        :reverting-changed-files-summary-id="revertingChangedFilesSummaryId"
        :pinning-changed-files-summary-id="pinningChangedFilesSummaryId"
        @update:open="expansion.setExpanded(entry, $event)"
        @changed-files-rollback="handleChangedFilesRollback"
        @changed-files-pin="handleChangedFilesPin"
        @plan-approve="emit('planApprove')"
        @plan-reject="emit('planReject')"
        @plan-regenerate="emit('planRegenerate')"
        @plan-update-step-title="handlePlanUpdateStepTitle"
        @plan-remove-step="handlePlanRemoveStep"
      />

      <slot v-if="isMessageBoundary(entry)" name="after-message" :message="message" />
    </template>
  </div>
</template>

<style scoped>
.ai-thread-single-message {
  display: flex;
  width: 100%;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
}
</style>
