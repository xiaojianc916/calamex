<script setup lang="ts">
import AiErrorNotice from '@/components/business/ai/chat/AiErrorNotice.vue';
import AiPlanConfirmationMessage from '@/components/business/ai/plan/AiPlanConfirmationMessage.vue';
import AiToolConfirmationCard from '@/components/business/ai/shell/AiToolConfirmationCard.vue';
import type {
  IAiTaskPlanStep,
  IAiToolConfirmationRequest,
  TAiToolConfirmationDecision,
} from '@/types/ai';
import type { TAgentPlanStatus } from '@/types/ai/sidecar';

defineProps<{
  planConfirmationVisible: boolean;
  planActiveGoal: string;
  planSummary: string | null;
  planStatus: TAgentPlanStatus | null;
  planSteps: IAiTaskPlanStep[];
  planIsPlanning: boolean;
  planIsApproving: boolean;
  canEditPlan: boolean;
  canApprovePlan: boolean;
  planApprovedAt: string | null;
  directToolConfirmationVisible: boolean;
  visibleDirectToolConfirmation: IAiToolConfirmationRequest | null;
  isAgentRunActionPending: boolean;
  errorMessage: string;
}>();

const emit = defineEmits<{
  updateStepTitle: [stepId: string, title: string];
  removeStep: [stepId: string];
  regenerate: [];
  reject: [];
  approve: [];
  resolveToolConfirmation: [decision: TAiToolConfirmationDecision];
}>();
</script>

<template>
  <AiPlanConfirmationMessage
    v-if="planConfirmationVisible"
    :goal="planActiveGoal"
    :summary="planSummary"
    :status="planStatus"
    :steps="planSteps"
    :is-planning="planIsPlanning"
    :is-approving="planIsApproving"
    :can-edit="canEditPlan"
    :can-approve="canApprovePlan"
    :approved-at="planApprovedAt"
    @update-step-title="(stepId, title) => emit('updateStepTitle', stepId, title)"
    @remove-step="emit('removeStep', $event)"
    @regenerate="emit('regenerate')"
    @reject="emit('reject')"
    @approve="emit('approve')"
  />
  <div v-if="directToolConfirmationVisible && visibleDirectToolConfirmation" class="ai-direct-tool-confirmation">
    <AiToolConfirmationCard
      :confirmation="visibleDirectToolConfirmation"
      :disabled="isAgentRunActionPending"
      @resolve="emit('resolveToolConfirmation', $event)"
    />
  </div>
  <AiErrorNotice v-if="errorMessage" :message="errorMessage" />
</template>

<style scoped>
.ai-direct-tool-confirmation {
  box-sizing: border-box;
  display: flex;
  width: 100%;
  justify-content: flex-start;
  padding: 0 88px 0 12px;
}
</style>
