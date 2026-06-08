<script setup lang="ts">
import { computed, ref } from 'vue';
import { AiQueue, type IAiQueueItem } from '@/components/ai-elements/queue';
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

const props = defineProps<{
  goal: string;
  planSummary?: string | null;
  planStatus?: TAgentPlanStatus | null;
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
  classificationReason: string;
  errorMessage: string;
  isPlanning: boolean;
  isApproving: boolean;
  approvedAt: string | null;
  activeRun: IAiAgentRun | null;
  isRunActionPending: boolean;
  isClassifying?: boolean;
  webActivity?: IAiWebActivity | null;
  toolActivity?: IAiToolActivityInline | null;
  toolConfirmation?: IAiToolConfirmationRequest | null;
}>();

const isCollapsed = ref(false);
const planContentId = 'ai-plan-mode-panel-content';
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
}>();

const runStatusLabel = computed(() => {
  if (!props.activeRun) {
    return props.approvedAt ? '等待启动' : '';
  }

  switch (props.activeRun.status) {
    case 'waiting-for-plan-approval':
      return '等待批准';
    case 'running-plan':
      return '运行中';
    case 'running-step':
      return '执行步骤中';
    case 'waiting-for-tool-confirmation':
      return '等待工具确认';
    case 'paused':
      return '可继续';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    default:
      return '未知状态';
  }
});

const executionSteps = computed(() => props.activeRun?.steps ?? props.steps);

const completedStepCount = computed(
  () => executionSteps.value.filter((step) => step.status === 'done').length,
);

const totalStepCount = computed(() => executionSteps.value.length);

const todoTitle = computed(() =>
  totalStepCount.value > 0
    ? `执行进度(${completedStepCount.value}/${totalStepCount.value})`
    : '执行进度',
);

const planStateLabel = computed(() => {
  if (props.isClassifying) {
    return '判断任务';
  }

  if (props.isPlanning) {
    return '生成计划';
  }

  if (props.activeRun) {
    return runStatusLabel.value;
  }

  if (props.approvedAt) {
    return '已批准';
  }

  if (props.steps.length) {
    return '待确认';
  }

  return '计划';
});

const planQueueItems = computed<IAiQueueItem[]>(() =>
  executionSteps.value.map((step) => ({
    id: step.id,
    label: step.title,
    status: step.status,
  })),
);

const collapseLabel = computed(() => (isCollapsed.value ? '展开执行进度' : '收起执行进度'));

const canResumeRun = computed(() => props.activeRun?.status === 'paused');

const toggleCollapsed = (): void => {
  isCollapsed.value = !isCollapsed.value;
};
</script>

<template>
  <section class="ai-plan-mode-panel" :class="{ 'is-collapsed': isCollapsed }" aria-label="计划模式">
    <header class="ai-plan-header">
      <button type="button" class="ai-plan-title-button" :aria-expanded="!isCollapsed" :aria-controls="planContentId"
        :aria-label="collapseLabel" @click="toggleCollapsed">
        <span class="icon-[lucide--chevron-down] ai-plan-caret" :class="{ 'is-collapsed': isCollapsed }"
          aria-hidden="true" />
        <h3 v-text="todoTitle"></h3>
      </button>
      <div class="ai-plan-header-actions">
        <button v-if="canResumeRun" type="button" class="ai-plan-resume-button" :disabled="isRunActionPending"
          aria-label="继续执行计划" @click="emit('resumeRun')">
          <span aria-hidden="true" class="icon-[lucide--play]" />
          <span>继续</span>
        </button>
        <span class="ai-plan-state-label" v-text="planStateLabel"></span>
      </div>
    </header>

    <Transition name="ai-plan-queue-expand">
      <div v-if="!isCollapsed" :id="planContentId" class="ai-plan-body">
        <AiQueue v-if="planQueueItems.length" :items="planQueueItems" class="ai-plan-step-queue" />
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.ai-plan-mode-panel {
  --ai-plan-panel-width: min(88%, calc(var(--app-density-scale) * 35rem));
  --ai-plan-expand-max-block: calc(var(--app-density-scale) * 24rem);
  display: grid;
  width: var(--ai-plan-panel-width);
  gap: calc(var(--app-density-scale) * 0.25rem);
  margin-inline: auto;
  border-top: 0;
  background: transparent;
  padding: 0;
}

.ai-plan-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: calc(var(--app-density-scale) * 0.5rem);
}

.ai-plan-title-button {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: calc(var(--app-density-scale) * 0.375rem);
  border-radius: var(--radius-sm);
  color: inherit;
  padding: calc(var(--app-density-scale) * 0.125rem) calc(var(--app-density-scale) * 0.25rem);
  transition:
    background-color var(--motion-duration-fast) var(--motion-easing-standard),
    color var(--motion-duration-fast) var(--motion-easing-standard),
    transform var(--motion-duration-fast) var(--motion-easing-standard);
}

.ai-plan-title-button:hover {
  background: color-mix(in srgb, var(--surface-hover) 64%, transparent);
  color: var(--text-primary);
}

.ai-plan-title-button:active {
  transform: scale(0.99);
}

.ai-plan-caret {
  width: calc(var(--app-density-scale) * 0.8125rem);
  height: calc(var(--app-density-scale) * 0.8125rem);
  color: var(--text-quaternary);
  transition: transform var(--motion-duration-fast) var(--motion-easing-standard);
}

.ai-plan-caret.is-collapsed {
  transform: rotate(-90deg);
}

.ai-plan-header h3 {
  margin: 0;
  color: var(--text-primary);
  font-size: calc(var(--app-ui-font-size) * 0.85);
  font-weight: 600;
}

.ai-plan-header-actions {
  display: inline-flex;
  min-width: 0;
  flex: 0 0 auto;
  align-items: center;
  gap: calc(var(--app-density-scale) * 0.5rem);
}

.ai-plan-resume-button {
  display: inline-flex;
  height: calc(var(--app-density-scale) * 1.5rem);
  align-items: center;
  gap: calc(var(--app-density-scale) * 0.25rem);
  border: 1px solid color-mix(in srgb, var(--accent-strong) 28%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--accent-strong) 9%, transparent);
  color: var(--accent-strong);
  padding: 0 calc(var(--app-density-scale) * 0.5rem);
  font-size: calc(var(--app-ui-font-size) * 0.77);
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  transition:
    background-color var(--motion-duration-fast) var(--motion-easing-standard),
    border-color var(--motion-duration-fast) var(--motion-easing-standard),
    color var(--motion-duration-fast) var(--motion-easing-standard),
    opacity var(--motion-duration-fast) var(--motion-easing-standard),
    transform var(--motion-duration-fast) var(--motion-easing-standard);
}

.ai-plan-resume-button:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent-strong) 42%, transparent);
  background: color-mix(in srgb, var(--accent-strong) 14%, transparent);
  color: var(--accent-strong);
}

.ai-plan-resume-button:active:not(:disabled) {
  transform: scale(0.98);
}

.ai-plan-resume-button:disabled {
  cursor: default;
  opacity: 0.58;
}

.ai-plan-resume-button svg {
  width: calc(var(--app-density-scale) * 0.75rem);
  height: calc(var(--app-density-scale) * 0.75rem);
  flex: 0 0 auto;
  stroke-width: 2.2;
}

.ai-plan-state-label {
  color: var(--text-quaternary);
  font-size: calc(var(--app-ui-font-size) * 0.77);
  white-space: nowrap;
}

.ai-plan-body {
  display: grid;
  gap: calc(var(--app-density-scale) * 0.375rem);
  overflow: hidden;
  transform-origin: top center;
}

.ai-plan-queue-expand-enter-active,
.ai-plan-queue-expand-leave-active {
  max-block-size: var(--ai-plan-expand-max-block);
  overflow: hidden;
  transition:
    max-block-size var(--motion-duration-normal) var(--motion-easing-emphasized),
    opacity var(--motion-duration-fast) var(--motion-easing-standard),
    transform var(--motion-duration-fast) var(--motion-easing-standard);
}

.ai-plan-queue-expand-enter-from,
.ai-plan-queue-expand-leave-to {
  max-block-size: 0;
  opacity: 0;
  transform: translateY(calc(var(--app-density-scale) * -0.25rem)) scale(0.99);
}

.ai-plan-queue-expand-enter-to,
.ai-plan-queue-expand-leave-from {
  max-block-size: var(--ai-plan-expand-max-block);
  opacity: 1;
  transform: translateY(0) scale(1);
}

.ai-plan-step-queue {
  max-block-size: calc(var(--app-density-scale) * 9.375rem);
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--text-primary) 12%, transparent) transparent;
}

.ai-plan-step-queue::-webkit-scrollbar {
  width: calc(var(--app-density-scale) * 0.375rem);
}

.ai-plan-step-queue::-webkit-scrollbar-track {
  background: transparent;
}

.ai-plan-step-queue::-webkit-scrollbar-thumb {
  border: calc(var(--app-density-scale) * 0.125rem) solid transparent;
  border-radius: calc(var(--radius-xl) * 1000);
  background: color-mix(in srgb, var(--text-primary) 12%, transparent);
  background-clip: content-box;
}

@media (prefers-reduced-motion: reduce) {

  .ai-plan-title-button,
  .ai-plan-resume-button,
  .ai-plan-caret,
  .ai-plan-queue-expand-enter-active,
  .ai-plan-queue-expand-leave-active {
    transition-duration: 1ms;
  }

  .ai-plan-queue-expand-enter-from,
  .ai-plan-queue-expand-leave-to {
    transform: none;
  }

}
</style>
