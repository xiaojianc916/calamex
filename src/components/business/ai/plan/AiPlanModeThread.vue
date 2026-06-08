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
import type { IAiAgentRun, IAiTaskPlanStep } from '@/types/ai';
import type { TAgentPlanStatus } from '@/types/ai/sidecar';

interface IAiPlanThreadScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distanceFromBottom: number;
}

interface IAiPlanThreadStat {
  id: string;
  label: string;
  value: string;
}

const props = withDefaults(
  defineProps<{
    goal: string;
    summary: string | null;
    status: TAgentPlanStatus | null;
    steps: IAiTaskPlanStep[];
    isClassifying: boolean;
    isPlanning: boolean;
    isApproving: boolean;
    canEdit: boolean;
    canApprove: boolean;
    approvedAt: string | null;
    activeRun: IAiAgentRun | null;
    errorMessage?: string;
    conversationId?: string | null;
    scrollState?: IAiPlanThreadScrollState | null;
  }>(),
  {
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
  approve: [];
  scrollStateChange: [state: IAiPlanThreadScrollState];
}>();

const completedStepCount = computed(
  () => (props.activeRun?.steps ?? props.steps).filter((step) => step.status === 'done').length,
);
const failedStepCount = computed(
  () =>
    (props.activeRun?.steps ?? props.steps).filter(
      (step) => step.status === 'failed' || step.status === 'cancelled',
    ).length,
);
const totalStepCount = computed(() => (props.activeRun?.steps ?? props.steps).length);
const activeStep = computed(() => {
  const run = props.activeRun;

  if (!run) {
    return props.steps.find((step) => step.isActive) ?? null;
  }

  if (run.currentStepId) {
    return run.steps.find((step) => step.id === run.currentStepId) ?? null;
  }

  return run.steps.find((step) => step.status === 'running') ?? null;
});
const statusLabel = computed(() => {
  if (props.isClassifying) {
    return '判断任务复杂度';
  }

  if (props.isPlanning) {
    return '生成结构化计划';
  }

  if (props.isApproving) {
    return '批准计划中';
  }

  if (props.activeRun) {
    switch (props.activeRun.status) {
      case 'running-plan':
      case 'running-step':
        return '计划执行中';
      case 'waiting-for-tool-confirmation':
        return '等待工具确认';
      case 'paused':
        return '计划已暂停';
      case 'completed':
        return '计划已完成';
      case 'failed':
        return '计划执行失败';
      case 'cancelled':
        return '计划已取消';
      default:
        return '等待执行';
    }
  }

  if (props.approvedAt) {
    return '计划已批准';
  }

  if (props.steps.length > 0) {
    return '等待确认计划';
  }

  return '等待生成计划';
});
const planStats = computed<IAiPlanThreadStat[]>(() => [
  { id: 'total', label: '步骤', value: String(totalStepCount.value) },
  { id: 'done', label: '完成', value: String(completedStepCount.value) },
  { id: 'failed', label: '异常', value: String(failedStepCount.value) },
]);
const shouldShowPlanCard = computed(
  () => props.steps.length > 0 && !props.activeRun && !props.approvedAt,
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
  <Conversation class="relative size-full overflow-x-hidden ai-plan-mode-thread" aria-label="Plan 模式"
    :initial="conversationInitialScroll" :resize="conversationResizeMode" :restore-key="conversationId"
    :initial-scroll-top="scrollState?.scrollTop ?? null"
    :initial-distance-from-bottom="scrollState?.distanceFromBottom ?? null"
    @scroll-state-change="handleScrollStateChange">
    <ConversationContent class="ai-plan-mode-thread__content" :class="{ 'is-empty': shouldRenderEmptyState }">
      <ConversationEmptyState v-if="shouldRenderEmptyState" class="ai-plan-empty-state" title="Plan 尚未开始"
        description="描述一个复杂目标后，Plan 会先拆解步骤、风险和确认点。">
        <template #icon>
          <span class="icon-[lucide--list-checks] size-6" />
        </template>
      </ConversationEmptyState>

      <template v-else>
        <section class="ai-plan-thread-activity" aria-label="Plan 活动概览">
          <header class="ai-plan-thread-activity__header">
            <span class="ai-plan-thread-activity__icon" aria-hidden="true">
              <span class="icon-[lucide--route]" />
            </span>
            <div class="ai-plan-thread-activity__copy">
              <strong v-text="statusLabel"></strong>
              <span v-if="activeStep" v-text="activeStep.title"></span>
              <span v-else-if="goal" v-text="goal"></span>
              <span v-else>等待用户目标</span>
            </div>
          </header>

          <div class="ai-plan-thread-stats" aria-label="Plan 统计">
            <div v-for="stat in planStats" :key="stat.id" class="ai-plan-thread-stat">
              <span v-text="stat.label"></span>
              <strong v-text="stat.value"></strong>
            </div>
          </div>
        </section>

        <AiPlanConfirmationMessage v-if="shouldShowPlanCard" class="ai-plan-thread-confirmation" :goal="goal"
          :summary="summary" :status="status" :steps="steps" :is-planning="isPlanning" :is-approving="isApproving"
          :can-edit="canEdit" :can-approve="canApprove" :approved-at="approvedAt"
          @update-step-title="(stepId, title) => emit('updateStepTitle', stepId, title)"
          @remove-step="emit('removeStep', $event)" @regenerate="emit('regenerate')" @reject="emit('reject')"
          @approve="emit('approve')" />

        <section v-else-if="steps.length" class="ai-plan-thread-readonly" aria-label="Plan 步骤快照">
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

        <AiErrorNotice v-if="errorMessage" class="ai-plan-thread-error" :message="errorMessage" />
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
  gap: 18px;
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

.ai-plan-thread-activity,
.ai-plan-thread-readonly {
  display: grid;
  width: min(100%, 760px);
  gap: 12px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 86%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-soft) 62%, transparent);
  padding: 12px;
}

.ai-plan-thread-activity__header {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
}

.ai-plan-thread-activity__icon {
  display: inline-grid;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent-strong) 10%, transparent);
  color: var(--accent-strong);
}

.ai-plan-thread-activity__icon svg {
  width: 16px;
  height: 16px;
  stroke-width: 2;
}

.ai-plan-thread-activity__copy {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.ai-plan-thread-activity__copy strong,
.ai-plan-thread-readonly h3 {
  margin: 0;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 650;
  line-height: 18px;
}

.ai-plan-thread-activity__copy span {
  overflow: hidden;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 17px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-plan-thread-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.ai-plan-thread-stat {
  display: grid;
  gap: 2px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--panel-bg) 78%, transparent);
  padding: 8px;
}

.ai-plan-thread-stat span {
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 15px;
}

.ai-plan-thread-stat strong {
  color: var(--text-primary);
  font-size: 16px;
  font-weight: 650;
  line-height: 20px;
}

.ai-plan-thread-confirmation {
  max-width: none;
  padding-left: 0;
  padding-right: 0;
}

.ai-plan-thread-confirmation :deep(.ai-element-plan) {
  width: min(100%, 760px);
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
  width: min(100%, 760px);
}

.ai-plan-scroll-button {
  bottom: 14px;
  left: 50%;
  z-index: 1;
  transform: translateX(-50%);
}
</style>
