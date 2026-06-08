<script setup lang="ts">
import { computed } from 'vue';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import AiErrorNotice from '@/components/business/ai/chat/AiErrorNotice.vue';
import AiPlanConfirmationMessage from '@/components/business/ai/plan/AiPlanConfirmationMessage.vue';
import AiPlanModePanel from '@/components/business/ai/plan/AiPlanModePanel.vue';
import type {
  IAiAgentPlanVersionSummary,
  IAiAgentRun,
  IAiTaskPlanStep,
  IAiToolActivityInline,
  IAiToolConfirmationRequest,
  IAiWebActivity,
  TAiToolConfirmationDecision,
} from '@/types/ai';
import type { TAgentPlanStatus } from '@/types/ai/sidecar';

interface IAiPlanThreadScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distanceFromBottom: number;
}

const props = withDefaults(
  defineProps<{
    goal: string;
    summary: string | null;
    status: TAgentPlanStatus | null;
    planId?: string | null;
    planVersion?: number | null;
    planThreadId?: string | null;
    planCreatedAt?: string | null;
    planUpdatedAt?: string | null;
    planExecutedAt?: string | null;
    planRejectionReason?: string | null;
    planErrorMessage?: string | null;
    planVersions?: IAiAgentPlanVersionSummary[];
    steps: IAiTaskPlanStep[];
    classificationReason?: string;
    isClassifying: boolean;
    isPlanning: boolean;
    isApproving: boolean;
    canEdit: boolean;
    canApprove: boolean;
    approvedAt: string | null;
    activeRun: IAiAgentRun | null;
    isRunActionPending?: boolean;
    webActivity?: IAiWebActivity | null;
    toolActivity?: IAiToolActivityInline | null;
    toolConfirmation?: IAiToolConfirmationRequest | null;
    errorMessage?: string;
    conversationId?: string | null;
    scrollState?: IAiPlanThreadScrollState | null;
  }>(),
  {
    planId: null,
    planVersion: null,
    planThreadId: null,
    planCreatedAt: null,
    planUpdatedAt: null,
    planExecutedAt: null,
    planRejectionReason: null,
    planErrorMessage: null,
    planVersions: () => [],
    classificationReason: '',
    isRunActionPending: false,
    webActivity: null,
    toolActivity: null,
    toolConfirmation: null,
    errorMessage: '',
    conversationId: null,
    scrollState: null,
  },
);

const emit = defineEmits<{
  updateStepTitle: [stepId: string, title: string];
  removeStep: [stepId: string];
  regenerate: [];
  reject: [];
  reset: [];
  approve: [];
  runStep: [];
  pauseRun: [];
  resumeRun: [];
  cancelRun: [];
  resolveToolConfirmation: [decision: TAiToolConfirmationDecision];
  scrollStateChange: [state: IAiPlanThreadScrollState];
}>();

const shouldShowPlanCard = computed(
  () => props.steps.length > 0 && !props.activeRun && !props.approvedAt,
);
const shouldShowRunPanel = computed(
  () =>
    Boolean(props.activeRun) ||
    Boolean(props.toolActivity) ||
    Boolean(props.toolConfirmation && props.activeRun) ||
    Boolean(props.approvedAt) ||
    props.status === 'approved' ||
    props.status === 'executing' ||
    props.status === 'completed' ||
    props.status === 'failed',
);
const shouldRenderReadonlySteps = computed(
  () => props.steps.length > 0 && !shouldShowPlanCard.value && !shouldShowRunPanel.value,
);
const shouldRenderEmptyState = computed(
  () =>
    props.steps.length === 0 &&
    !props.activeRun &&
    !props.isPlanning &&
    !props.isClassifying &&
    !props.errorMessage.trim(),
);
const conversationInitialScroll = computed(() => !props.scrollState);
const conversationResizeMode = computed(() => (props.isPlanning || props.isClassifying ? undefined : 'instant'));

const handleScrollStateChange = (state: IAiPlanThreadScrollState): void => {
  emit('scrollStateChange', state);
};
</script>

<template>
  <Conversation
    class="relative size-full overflow-x-hidden ai-plan-mode-thread"
    aria-label="Plan 模式"
    :initial="conversationInitialScroll"
    :resize="conversationResizeMode"
    :restore-key="conversationId"
    :initial-scroll-top="scrollState?.scrollTop ?? null"
    :initial-distance-from-bottom="scrollState?.distanceFromBottom ?? null"
    @scroll-state-change="handleScrollStateChange"
  >
    <ConversationContent class="ai-plan-mode-thread__content" :class="{ 'is-empty': shouldRenderEmptyState }">
      <slot v-if="shouldRenderEmptyState" name="empty">
        <ConversationEmptyState
          class="ai-plan-empty-state"
          title="Plan 尚未开始"
          description="描述一个复杂目标后，Plan 会先拆解步骤、风险和确认点。"
        >
          <template #icon>
            <span class="icon-[lucide--list-checks] size-6" />
          </template>
        </ConversationEmptyState>
      </slot>

      <template v-else>
        <AiPlanConfirmationMessage
          v-if="shouldShowPlanCard"
          class="ai-plan-thread-entry ai-plan-thread-confirmation"
          standalone
          :goal="goal"
          :summary="summary"
          :status="status"
          :steps="steps"
          :is-planning="isPlanning"
          :is-approving="isApproving"
          :can-edit="canEdit"
          :can-approve="canApprove"
          :approved-at="approvedAt"
          @update-step-title="(stepId, title) => emit('updateStepTitle', stepId, title)"
          @remove-step="emit('removeStep', $event)"
          @regenerate="emit('regenerate')"
          @reject="emit('reject')"
          @approve="emit('approve')"
        />

        <AiPlanModePanel
          v-if="shouldShowRunPanel"
          class="ai-plan-thread-entry ai-plan-thread-run-panel"
          :goal="goal"
          :plan-summary="summary"
          :plan-status="status"
          :plan-id="planId"
          :plan-version="planVersion"
          :plan-thread-id="planThreadId"
          :plan-created-at="planCreatedAt"
          :plan-updated-at="planUpdatedAt"
          :plan-executed-at="planExecutedAt"
          :plan-rejection-reason="planRejectionReason"
          :plan-error-message="planErrorMessage"
          :plan-versions="planVersions"
          :steps="steps"
          :classification-reason="classificationReason"
          :error-message="errorMessage"
          :is-classifying="isClassifying"
          :is-planning="isPlanning"
          :is-approving="isApproving"
          :approved-at="approvedAt"
          :active-run="activeRun"
          :is-run-action-pending="isRunActionPending"
          :web-activity="webActivity"
          :tool-activity="toolActivity"
          :tool-confirmation="toolConfirmation"
          @update-step-title="(stepId, title) => emit('updateStepTitle', stepId, title)"
          @remove-step="emit('removeStep', $event)"
          @regenerate="emit('regenerate')"
          @reject="emit('reject')"
          @approve="emit('approve')"
          @reset="emit('reset')"
          @run-step="emit('runStep')"
          @pause-run="emit('pauseRun')"
          @resume-run="emit('resumeRun')"
          @cancel-run="emit('cancelRun')"
          @resolve-tool-confirmation="emit('resolveToolConfirmation', $event)"
        />

        <section v-else-if="shouldRenderReadonlySteps" class="ai-plan-thread-entry ai-plan-thread-readonly" aria-label="Plan 步骤快照">
          <h3>计划步骤</h3>
          <ol>
            <li v-for="step in steps" :key="step.id" :class="[`is-${step.status}`, `risk-${step.riskLevel}`]">
              <span class="ai-plan-thread-step-status" aria-hidden="true"></span>
              <div>
                <strong v-text="step.title"></strong>
                <p v-text="step.goal"></p>
              </div>
            </li>
          </ol>
        </section>

        <AiErrorNotice v-if="errorMessage && !shouldShowRunPanel" class="ai-plan-thread-entry ai-plan-thread-error" :message="errorMessage" />
      </template>
    </ConversationContent>
    <ConversationScrollButton v-if="!shouldRenderEmptyState" class="ai-plan-scroll-button" />
  </Conversation>
</template>

<style scoped>
.ai-plan-mode-thread {
  min-height: 0;
  flex: 1 1 0;
}

.ai-plan-mode-thread :deep(> div > div) {
  overscroll-behavior: contain;
  scroll-behavior: auto;
  overflow-anchor: none;
  scrollbar-color: transparent transparent;
  scrollbar-width: thin;
}

.ai-plan-mode-thread.is-scrollbar-active :deep(> div > div) {
  scrollbar-color: color-mix(in srgb, var(--text-primary) 18%, transparent) transparent;
}

.ai-plan-mode-thread__content {
  min-width: 0;
  gap: 14px;
  min-height: 100%;
  overflow-x: hidden;
  padding: 16px 16px 24px;
}

.ai-plan-mode-thread__content.is-empty {
  justify-content: center;
}

.ai-plan-empty-state {
  color: var(--text-tertiary);
}

.ai-plan-thread-entry {
  width: min(100%, 760px);
  align-self: flex-start;
}

.ai-plan-thread-run-panel {
  --ai-plan-panel-width: 100%;
  max-width: none;
  margin-inline: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 0;
}

.ai-plan-thread-confirmation :deep(.ai-element-plan) {
  width: min(100%, 760px);
}

.ai-plan-thread-readonly {
  display: grid;
  gap: 10px;
  padding-left: 12px;
  padding-right: 88px;
}

.ai-plan-thread-readonly h3 {
  margin: 0;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 650;
  line-height: 18px;
}

.ai-plan-thread-readonly ol {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ai-plan-thread-readonly li {
  display: grid;
  min-width: 0;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 8px;
}

.ai-plan-thread-step-status {
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: 999px;
  background: var(--text-quaternary);
}

.ai-plan-thread-readonly li.is-running .ai-plan-thread-step-status {
  background: var(--accent-strong);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent-strong) 12%, transparent);
}

.ai-plan-thread-readonly li.is-done .ai-plan-thread-step-status {
  background: var(--success);
}

.ai-plan-thread-readonly li.is-failed .ai-plan-thread-step-status,
.ai-plan-thread-readonly li.is-cancelled .ai-plan-thread-step-status {
  background: var(--danger);
}

.ai-plan-thread-readonly strong {
  display: block;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 650;
  line-height: 18px;
}

.ai-plan-thread-readonly p {
  margin: 2px 0 0;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 17px;
}

.ai-plan-thread-error {
  padding-left: 12px;
  padding-right: 88px;
}

.ai-plan-scroll-button {
  bottom: 14px;
  left: 50%;
  z-index: 1;
  transform: translateX(-50%);
}
</style>
