<script setup lang="ts">
import { computed } from 'vue';
import AiPlanConfirmationMessage from '@/components/business/ai/plan/AiPlanConfirmationMessage.vue';
import type { IAiThreadPlanControlEntry } from './projection';
import type { IAiThreadPlanDetails } from './types';

const props = defineProps<{
  entry: IAiThreadPlanControlEntry;
  details?: IAiThreadPlanDetails;
}>();

const emit = defineEmits<{
  approve: [];
  reject: [];
  regenerate: [];
  updateStepTitle: [stepId: string, title: string];
  removeStep: [stepId: string];
}>();

const FALLBACK_DETAILS: IAiThreadPlanDetails = {
  summary: null,
  status: null,
  steps: [],
  isPlanning: false,
  isApproving: false,
  canEdit: false,
  canApprove: false,
  approvedAt: null,
};

const resolved = computed<IAiThreadPlanDetails>(() => props.details ?? FALLBACK_DETAILS);
</script>

<template>
  <div class="ai-thread-plan-control">
    <AiPlanConfirmationMessage
      standalone
      :goal="entry.goal"
      :summary="resolved.summary"
      :status="resolved.status"
      :steps="resolved.steps"
      :is-planning="resolved.isPlanning"
      :is-approving="resolved.isApproving"
      :can-edit="resolved.canEdit"
      :can-approve="resolved.canApprove"
      :approved-at="resolved.approvedAt"
      @update-step-title="(stepId: string, title: string) => emit('updateStepTitle', stepId, title)"
      @remove-step="emit('removeStep', $event)"
      @regenerate="emit('regenerate')"
      @reject="emit('reject')"
      @approve="emit('approve')"
    />
  </div>
</template>

<style scoped>
.ai-thread-plan-control {
  width: 100%;
  min-width: 0;
}
</style>
