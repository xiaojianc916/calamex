<script setup lang="ts">
import type { IAiThreadPlanDetails } from '@/components/business/ai/thread/types';
import type { IAiChatMessage } from '@/types/ai';
import AiThreadSingleMessageTimeline from './AiThreadSingleMessageTimeline.vue';

defineProps<{
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

const handleChangedFilesRollback = (messageId: string, summaryId: string): void => {
  emit('changedFilesRollback', messageId, summaryId);
};

const handleChangedFilesPin = (messageId: string, summaryId: string, pinned: boolean): void => {
  emit('changedFilesPin', messageId, summaryId, pinned);
};

const handlePlanUpdateStepTitle = (stepId: string, title: string): void => {
  emit('planUpdateStepTitle', stepId, title);
};

const handlePlanRemoveStep = (stepId: string): void => {
  emit('planRemoveStep', stepId);
};
</script>

<template>
  <AiThreadSingleMessageTimeline
    :message="message"
    :workspace-root-path="workspaceRootPath"
    :plan-details="planDetails"
    :reverting-changed-files-summary-id="revertingChangedFilesSummaryId"
    :pinning-changed-files-summary-id="pinningChangedFilesSummaryId"
    @changed-files-rollback="handleChangedFilesRollback"
    @changed-files-pin="handleChangedFilesPin"
    @plan-approve="emit('planApprove')"
    @plan-reject="emit('planReject')"
    @plan-regenerate="emit('planRegenerate')"
    @plan-update-step-title="handlePlanUpdateStepTitle"
    @plan-remove-step="handlePlanRemoveStep"
  >
    <template #after-message="{ message: slotMessage }">
      <slot name="after-message" :message="slotMessage" />
    </template>
  </AiThreadSingleMessageTimeline>
</template>
