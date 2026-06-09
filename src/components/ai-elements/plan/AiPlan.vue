<script setup lang="ts">
import { ChevronUp, FileText, Trash2 } from '@lucide/vue';
import { computed, ref } from 'vue';

import { ApprovalPrompt, type IApprovalPromptOption } from '@/components/ai-elements/approval';
import type { IAiTaskPlanStep } from '@/types/ai';
import type { TAgentPlanStatus } from '@/types/ai/sidecar';

const props = defineProps<{
  goal: string;
  summary: string | null;
  status: TAgentPlanStatus | null;
  steps: IAiTaskPlanStep[];
  isPlanning: boolean;
  isApproving: boolean;
  canEdit: boolean;
  canApprove: boolean;
  approvedAt: string | null;
}>();

const emit = defineEmits<{
  updateTitle: [stepId: string, title: string];
  removeStep: [stepId: string];
  regenerate: [];
  reject: [];
  approve: [];
}>();

const MIN_STEP_COUNT = 2;
const isCollapsed = ref(false);

const overviewText = computed(
  () => props.summary?.trim() || props.goal.trim() || 'AI 已生成一份计划，请确认后开始执行。',
);

const approvalLabel = computed(() => {
  if (props.status === 'rejected') {
    return '已拒绝';
  }

  if (props.status === 'completed') {
    return '已完成';
  }

  if (props.status === 'failed') {
    return '失败';
  }

  if (props.approvedAt || props.status === 'approved' || props.status === 'executing') {
    return props.canApprove ? '启动运行' : '已批准';
  }

  return props.isApproving ? '批准中…' : '批准并启动';
});

const canReject = computed(
  () =>
    !props.approvedAt &&
    props.status !== 'approved' &&
    props.status !== 'rejected' &&
    props.status !== 'executing' &&
    props.status !== 'completed' &&
    props.status !== 'failed',
);

const approveOptionLabel = computed(() => (props.isApproving ? '批准中…' : '批准并启动'));

/**
 * 对齐 Codex `approval_overlay.rs`:仅列出当前可执行的决策选项,
 * 按与 Codex apply-patch 审批一致的顺序(接受 → 重试/变体 → 拒绝)。
 */
const planOptions = computed<IApprovalPromptOption[]>(() => {
  const options: IApprovalPromptOption[] = [];

  if (props.canApprove) {
    options.push({ id: 'approve', label: approveOptionLabel.value, shortcut: 'y' });
  }

  if (!props.isPlanning && !props.isApproving) {
    options.push({ id: 'regenerate', label: '重新生成', shortcut: 'r' });
  }

  if (canReject.value) {
    options.push({ id: 'reject', label: '拒绝', shortcut: 'n', tone: 'danger' });
  }

  return options;
});

const approvalTitle = computed(() =>
  props.canApprove ? '是否按此计划开始执行？' : '需要调整这份计划吗？',
);

const statusNote = computed(() => {
  if (planOptions.value.length > 0) {
    return null;
  }

  if (props.isPlanning) {
    return '正在生成计划…';
  }

  return approvalLabel.value;
});

const getInputValue = (event: Event): string =>
  event.target instanceof HTMLInputElement ? event.target.value : '';

const submitTitle = (stepId: string, title: string): void => {
  const normalized = title.trim();
  if (!normalized) {
    return;
  }

  emit('updateTitle', stepId, normalized);
};

const handleTitleEnter = (stepId: string, event: Event): void => {
  submitTitle(stepId, getInputValue(event));
};

const handleTitleBlur = (step: IAiTaskPlanStep, event: Event): void => {
  const nextTitle = getInputValue(event).trim();

  if (nextTitle && nextTitle !== step.title) {
    emit('updateTitle', step.id, nextTitle);
  }
};

const toggleCollapsed = (): void => {
  isCollapsed.value = !isCollapsed.value;
};

const handlePlanSelect = (id: string): void => {
  if (props.isPlanning || props.isApproving) {
    return;
  }

  if (id === 'approve') {
    if (props.canApprove) {
      emit('approve');
    }
    return;
  }

  if (id === 'regenerate') {
    emit('regenerate');
    return;
  }

  if (id === 'reject' && canReject.value) {
    emit('reject');
  }
};

const handlePlanCancel = (): void => {
  if (props.isPlanning || props.isApproving) {
    return;
  }

  // 对齐 Codex:Esc 等价于拒绝当前请求。
  if (canReject.value) {
    emit('reject');
  }
};
</script>

<template>
  <section class="ai-element-plan" :class="{ 'is-collapsed': isCollapsed }" aria-label="已生成计划">
    <header class="ai-element-plan-header">
      <div class="ai-element-plan-title-group">
        <FileText class="ai-element-plan-title-icon" aria-hidden="true" />
        <h3 class="ai-element-plan-title" v-text="goal" />
      </div>
      <button type="button" class="ai-element-plan-collapse" :aria-expanded="!isCollapsed"
        :aria-label="isCollapsed ? '展开计划' : '收起计划'" @click="toggleCollapsed">
        <ChevronUp class="ai-element-plan-collapse-icon" :class="{ 'is-collapsed': isCollapsed }"
          aria-hidden="true" />
      </button>
    </header>

    <Transition name="ai-element-plan-content">
      <div v-if="!isCollapsed" class="ai-element-plan-content">
        <section class="ai-element-plan-section" aria-label="计划概览">
          <h4>概览</h4>
          <p v-text="overviewText" />
        </section>

        <section class="ai-element-plan-section" aria-label="关键步骤">
          <h4>关键步骤</h4>
          <ol class="ai-element-plan-steps">
            <li v-for="step in steps" :key="step.id" class="ai-element-plan-step"
              :class="[`is-${step.status}`, `risk-${step.riskLevel}`]">
              <span class="ai-element-plan-step-bullet" aria-hidden="true" />
              <input v-if="canEdit" class="ai-element-plan-step-title" :value="step.title" aria-label="编辑计划步骤标题"
                :disabled="isPlanning" @keydown.enter.prevent="handleTitleEnter(step.id, $event)"
                @blur="handleTitleBlur(step, $event)" />
              <span v-else class="ai-element-plan-step-title is-readonly" v-text="step.title" />
              <button v-if="canEdit" type="button" class="ai-plan-step-remove"
                :disabled="steps.length <= MIN_STEP_COUNT || isPlanning" aria-label="删除计划步骤" title="删除计划步骤"
                @click="emit('removeStep', step.id)">
                <Trash2 aria-hidden="true" />
              </button>
            </li>
          </ol>
        </section>

        <footer class="ai-element-plan-approval">
          <ApprovalPrompt v-if="planOptions.length > 0" :title="approvalTitle" :options="planOptions"
            :disabled="isPlanning || isApproving" @select="handlePlanSelect" @cancel="handlePlanCancel" />
          <p v-else class="ai-element-plan-status" v-text="statusNote" />
        </footer>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.ai-element-plan {
  --ai-plan-border-width: thin;
  --ai-plan-focus-ring-size: 0.08em;
  --ai-plan-gap-xs: calc(var(--app-density-scale) * 0.25rem);
  --ai-plan-gap-sm: calc(var(--app-density-scale) * 0.375rem);
  --ai-plan-gap-md: calc(var(--app-density-scale) * 0.5rem);
  --ai-plan-gap-lg: calc(var(--app-density-scale) * 0.875rem);
  --ai-plan-gap-xl: calc(var(--app-density-scale) * 1.25rem);
  --ai-plan-padding: calc(var(--app-density-scale) * 1.25rem);
  --ai-plan-bullet-size: calc(var(--app-density-scale) * 0.3125rem);
  --ai-plan-remove-size: calc(var(--app-density-scale) * 1.375rem);
  --ai-plan-font-sm: calc(var(--app-ui-font-size) * 0.92);
  --ai-plan-font-md: calc(var(--app-ui-font-size) * 1);
  --ai-plan-font-lg: calc(var(--app-ui-font-size) * 1.22);
  --ai-plan-icon-size: 1em;
  display: grid;
  width: min(100%, calc(var(--app-density-scale) * 45rem));
  gap: var(--ai-plan-gap-lg);
  border: var(--ai-plan-border-width) solid color-mix(in srgb, var(--shell-divider) 92%, transparent);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--panel-bg) 96%, transparent);
  padding: var(--ai-plan-padding);
}

.ai-element-plan-header {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--ai-plan-gap-md);
}

.ai-element-plan-title-group {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--ai-plan-gap-md);
}

.ai-element-plan-title-icon {
  width: calc(var(--app-density-scale) * 1.125rem);
  height: calc(var(--app-density-scale) * 1.125rem);
  flex: 0 0 auto;
  color: var(--text-primary);
  stroke-width: 2;
}

.ai-element-plan-title {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--text-primary);
  font-size: var(--ai-plan-font-lg);
  font-weight: 650;
  line-height: 1.35;
}

.ai-element-plan-collapse {
  display: inline-grid;
  width: calc(var(--app-density-scale) * 1.625rem);
  height: calc(var(--app-density-scale) * 1.625rem);
  flex: 0 0 auto;
  place-items: center;
  border-radius: var(--radius-sm);
  color: var(--text-tertiary);
  transition:
    background-color var(--motion-duration-fast) var(--motion-easing-standard),
    color var(--motion-duration-fast) var(--motion-easing-standard),
    transform var(--motion-duration-fast) var(--motion-easing-standard);
}

.ai-element-plan-collapse:hover {
  background: color-mix(in srgb, var(--surface-hover) 72%, transparent);
  color: var(--text-primary);
}

.ai-element-plan-collapse:active {
  transform: scale(0.97);
}

.ai-element-plan-collapse-icon {
  width: calc(var(--app-density-scale) * 0.9375rem);
  height: calc(var(--app-density-scale) * 0.9375rem);
  transition: transform var(--motion-duration-fast) var(--motion-easing-standard);
}

.ai-element-plan-collapse-icon.is-collapsed {
  transform: rotate(180deg);
}

.ai-element-plan-content {
  display: grid;
  gap: var(--ai-plan-gap-xl);
  overflow: hidden;
}

.ai-element-plan-content-enter-active,
.ai-element-plan-content-leave-active {
  max-block-size: calc(var(--app-density-scale) * 38rem);
  overflow: hidden;
  transition:
    max-block-size var(--motion-duration-normal) var(--motion-easing-emphasized),
    opacity var(--motion-duration-fast) var(--motion-easing-standard),
    transform var(--motion-duration-fast) var(--motion-easing-standard);
}

.ai-element-plan-content-enter-from,
.ai-element-plan-content-leave-to {
  max-block-size: 0;
  opacity: 0;
  transform: translateY(calc(var(--app-density-scale) * -0.25rem));
}

.ai-element-plan-content-enter-to,
.ai-element-plan-content-leave-from {
  max-block-size: calc(var(--app-density-scale) * 38rem);
  opacity: 1;
  transform: translateY(0);
}

.ai-element-plan-section {
  display: grid;
  gap: var(--ai-plan-gap-md);
}

.ai-element-plan-section h4 {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--ai-plan-font-md);
  font-weight: 650;
  line-height: 1.4;
}

.ai-element-plan-section p {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--ai-plan-font-md);
  line-height: 1.55;
}

.ai-element-plan-steps {
  display: grid;
  gap: var(--ai-plan-gap-sm);
  margin: 0;
  padding: 0;
  list-style: none;
}

.ai-element-plan-step {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--ai-plan-gap-md);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
}

.ai-element-plan-step:hover {
  background: color-mix(in srgb, var(--surface-hover) 72%, transparent);
}

.ai-element-plan-step-bullet {
  width: var(--ai-plan-bullet-size);
  height: var(--ai-plan-bullet-size);
  flex: 0 0 auto;
  border-radius: calc(var(--radius-xl) * 1000);
  background: currentColor;
}

.ai-element-plan-step-title {
  min-width: 0;
  flex: 1 1 auto;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: var(--ai-plan-font-md);
  font-weight: 400;
  line-height: 1.45;
  outline: none;
  padding: 0;
}

.ai-element-plan-step-title:focus {
  background: color-mix(in srgb, var(--surface-soft) 82%, transparent);
  box-shadow: 0 0 0 var(--ai-plan-focus-ring-size) color-mix(in srgb, var(--accent-strong) 34%, transparent);
}

.ai-element-plan-step-title.is-readonly {
  overflow-wrap: anywhere;
}

.ai-plan-step-remove {
  display: inline-grid;
  width: var(--ai-plan-remove-size);
  height: var(--ai-plan-remove-size);
  flex: 0 0 auto;
  place-items: center;
  border-radius: var(--radius-sm);
  color: var(--text-quaternary);
}

.ai-plan-step-remove:hover:not(:disabled) {
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  color: var(--danger);
}

.ai-plan-step-remove:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.ai-plan-step-remove svg {
  width: var(--ai-plan-icon-size);
  height: var(--ai-plan-icon-size);
  stroke-width: 2;
}

.ai-element-plan-approval {
  display: grid;
  gap: var(--ai-plan-gap-sm);
}

.ai-element-plan-status {
  margin: 0;
  color: var(--text-tertiary);
  font-size: var(--ai-plan-font-sm);
  line-height: 1.5;
}

@media (prefers-reduced-motion: reduce) {

  .ai-element-plan-collapse,
  .ai-element-plan-collapse-icon,
  .ai-element-plan-content-enter-active,
  .ai-element-plan-content-leave-active {
    transition-duration: 1ms;
  }

  .ai-element-plan-content-enter-from,
  .ai-element-plan-content-leave-to {
    transform: none;
  }
}
</style>
