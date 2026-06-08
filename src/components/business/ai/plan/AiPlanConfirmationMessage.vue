<script setup lang="ts">
import { Message } from '@/components/ai-elements/message';
import { AiPlan } from '@/components/ai-elements/plan';
import type { IAiTaskPlanStep } from '@/types/ai';
import type { TAgentPlanStatus } from '@/types/ai/sidecar';

withDefaults(
  defineProps<{
    goal: string;
    summary: string | null;
    status: TAgentPlanStatus | null;
    steps: IAiTaskPlanStep[];
    isPlanning: boolean;
    isApproving: boolean;
    canEdit: boolean;
    canApprove: boolean;
    approvedAt: string | null;
    standalone?: boolean;
  }>(),
  {
    standalone: false,
  },
);

const emit = defineEmits<{
  updateStepTitle: [stepId: string, title: string];
  removeStep: [stepId: string];
  regenerate: [];
  reject: [];
  approve: [];
}>();
</script>

<template>
  <component
    :is="standalone ? 'section' : Message"
    :from="standalone ? undefined : 'assistant'"
    class="ai-plan-confirmation-message"
    :class="{ 'is-standalone': standalone }"
  >
    <AiPlan
      class="ai-plan-confirmation-message__plan"
      :goal="goal"
      :summary="summary"
      :status="status"
      :steps="steps"
      :is-planning="isPlanning"
      :is-approving="isApproving"
      :can-edit="canEdit"
      :can-approve="canApprove"
      :approved-at="approvedAt"
      @update-title="(stepId, title) => emit('updateStepTitle', stepId, title)"
      @remove-step="emit('removeStep', $event)"
      @regenerate="emit('regenerate')"
      @reject="emit('reject')"
      @approve="emit('approve')"
    />
  </component>
</template>

<style scoped>
.ai-plan-confirmation-message {
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  padding-left: calc(var(--app-density-scale) * 0.75rem);
  padding-right: calc(var(--app-density-scale) * 5.5rem);
}

.ai-plan-confirmation-message.is-standalone {
  display: block;
  padding-left: 0;
  padding-right: 0;
}

.ai-plan-confirmation-message__plan {
  width: min(100%, calc(var(--app-density-scale) * 45rem));
}

.ai-plan-confirmation-message.is-standalone .ai-plan-confirmation-message__plan {
  width: min(100%, 760px);
}
</style>
