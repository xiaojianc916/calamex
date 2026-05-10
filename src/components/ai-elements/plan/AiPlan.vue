<script setup lang="ts">
import {
  AlertTriangle,
  Check,
  FileText,
  RotateCw,
  Terminal,
  Trash2,
  X,
} from 'lucide-vue-next';
import { computed } from 'vue';

import type { TAgentPlanStatus } from '@/types/agent-sidecar';
import type { IAiTaskPlanStep } from '@/types/ai';

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

  return props.isApproving ? '批准中...' : '批准并启动';
});

const canReject = computed(() =>
  !props.approvedAt &&
  props.status !== 'approved' &&
  props.status !== 'rejected' &&
  props.status !== 'executing' &&
  props.status !== 'completed' &&
  props.status !== 'failed',
);

const hasPlanNotes = (step: IAiTaskPlanStep): boolean =>
  Boolean(
    step.description ||
    step.files?.length ||
    step.commands?.length ||
    step.risks?.length ||
    step.acceptanceCriteria?.length,
  );

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
</script>

<template>
  <section class="ai-element-plan" aria-label="已生成计划">
    <p v-if="summary || goal" class="ai-element-plan-summary">
      {{ summary || goal }}
    </p>

    <ol class="ai-element-plan-steps">
      <li
        v-for="step in steps"
        :key="step.id"
        class="ai-element-plan-step"
        :class="[`is-${step.status}`, `risk-${step.riskLevel}`]"
      >
        <span class="ai-element-plan-step-index">{{ step.index + 1 }}</span>
        <div class="ai-element-plan-step-main">
          <div class="ai-element-plan-step-title-row">
            <input
              class="ai-element-plan-step-title"
              :value="step.title"
              aria-label="编辑计划步骤标题"
              :disabled="isPlanning || !canEdit"
              @keydown.enter.prevent="handleTitleEnter(step.id, $event)"
              @blur="handleTitleBlur(step, $event)"
            />
            <span class="ai-element-plan-risk">{{ step.riskLevel }}</span>
            <button
              type="button"
              class="ai-plan-step-remove"
              :disabled="steps.length <= MIN_STEP_COUNT || isPlanning || !canEdit"
              aria-label="删除计划步骤"
              title="删除计划步骤"
              @click="emit('removeStep', step.id)"
            >
              <Trash2 aria-hidden="true" />
            </button>
          </div>

          <p class="ai-element-plan-step-goal">{{ step.description || step.goal }}</p>
          <p class="ai-element-plan-step-output">{{ step.expectedOutput }}</p>

          <div v-if="hasPlanNotes(step)" class="ai-element-plan-step-notes">
            <span v-if="step.files?.length" class="ai-element-plan-note">
              <FileText aria-hidden="true" />
              {{ step.files.slice(0, 3).join('、') }}
            </span>
            <span v-if="step.commands?.length" class="ai-element-plan-note">
              <Terminal aria-hidden="true" />
              {{ step.commands.slice(0, 2).join('；') }}
            </span>
            <span v-if="step.risks?.length" class="ai-element-plan-note is-risk">
              <AlertTriangle aria-hidden="true" />
              {{ step.risks.slice(0, 2).join('；') }}
            </span>
          </div>

          <ul v-if="step.acceptanceCriteria?.length" class="ai-element-plan-criteria">
            <li v-for="item in step.acceptanceCriteria.slice(0, 3)" :key="item">
              {{ item }}
            </li>
          </ul>
        </div>
      </li>
    </ol>

    <footer class="ai-element-plan-actions">
      <button
        type="button"
        class="ai-plan-button"
        :disabled="isPlanning || isApproving"
        @click="emit('regenerate')"
      >
        <RotateCw aria-hidden="true" />
        重生成
      </button>
      <button
        type="button"
        class="ai-plan-button"
        :disabled="isPlanning || isApproving || !canReject"
        @click="emit('reject')"
      >
        <X aria-hidden="true" />
        拒绝
      </button>
      <button
        type="button"
        class="ai-plan-button is-primary"
        :disabled="!canApprove || isPlanning || isApproving"
        @click="emit('approve')"
      >
        <Check aria-hidden="true" />
        {{ approvalLabel }}
      </button>
    </footer>
  </section>
</template>

<style scoped>
.ai-element-plan {
  --ai-plan-border-width: thin;
  --ai-plan-focus-ring-size: 0.08em;
  --ai-plan-pill-radius: calc(var(--radius-xl) * 1000);
  --ai-plan-gap-2xs: calc(var(--app-density-scale) * 0.125rem);
  --ai-plan-gap-xs: calc(var(--app-density-scale) * 0.25rem);
  --ai-plan-gap-sm: calc(var(--app-density-scale) * 0.375rem);
  --ai-plan-gap-md: calc(var(--app-density-scale) * 0.5rem);
  --ai-plan-step-padding-block: calc(var(--app-density-scale) * 0.4375rem);
  --ai-plan-step-padding-inline: calc(var(--app-density-scale) * 0.3125rem);
  --ai-plan-title-padding-block: calc(var(--app-density-scale) * 0.0625rem);
  --ai-plan-title-padding-inline: calc(var(--app-density-scale) * 0.125rem);
  --ai-plan-index-track: calc(var(--app-density-scale) * 1.25rem);
  --ai-plan-index-size: calc(var(--app-density-scale) * 1.125rem);
  --ai-plan-remove-size: calc(var(--app-density-scale) * 1.375rem);
  --ai-plan-action-height: calc(var(--app-density-scale) * 1.75rem);
  --ai-plan-action-padding-inline: calc(var(--app-density-scale) * 0.625rem);
  --ai-plan-criteria-indent: calc(var(--app-density-scale) * 0.875rem);
  --ai-plan-font-xs: calc(var(--app-ui-font-size) * 0.77);
  --ai-plan-font-sm: calc(var(--app-ui-font-size) * 0.85);
  --ai-plan-font-md: calc(var(--app-ui-font-size) * 0.92);
  --ai-plan-icon-size: 1em;
  display: grid;
  gap: var(--ai-plan-step-padding-block);
}

.ai-element-plan-summary {
  margin: 0;
  color: var(--text-tertiary);
  font-size: var(--ai-plan-font-md);
  line-height: 1.5;
}

.ai-element-plan-steps {
  display: grid;
  gap: var(--ai-plan-gap-2xs);
  margin: 0;
  padding: 0;
  list-style: none;
}

.ai-element-plan-step {
  display: grid;
  grid-template-columns: var(--ai-plan-index-track) minmax(0, 1fr);
  gap: var(--ai-plan-gap-md);
  border-radius: var(--radius-sm);
  padding: var(--ai-plan-step-padding-block) var(--ai-plan-step-padding-inline);
}

.ai-element-plan-step:hover {
  background: color-mix(in srgb, var(--surface-hover) 72%, transparent);
}

.ai-element-plan-step-index {
  display: inline-grid;
  width: var(--ai-plan-index-size);
  height: var(--ai-plan-index-size);
  place-items: center;
  border: var(--ai-plan-border-width) solid color-mix(in srgb, var(--shell-divider) 90%, transparent);
  border-radius: var(--ai-plan-pill-radius);
  color: var(--text-quaternary);
  font-size: var(--ai-plan-font-xs);
  line-height: 1;
}

.ai-element-plan-step.is-running .ai-element-plan-step-index {
  border-color: color-mix(in srgb, var(--accent-strong) 35%, var(--shell-divider));
  color: var(--accent-strong);
}

.ai-element-plan-step.is-done .ai-element-plan-step-index {
  border-color: color-mix(in srgb, var(--success) 38%, var(--shell-divider));
  color: var(--success);
}

.ai-element-plan-step.is-failed .ai-element-plan-step-index {
  border-color: color-mix(in srgb, var(--danger) 36%, var(--shell-divider));
  color: var(--danger);
}

.ai-element-plan-step-main {
  display: grid;
  min-width: 0;
  gap: var(--ai-plan-title-padding-block);
}

.ai-element-plan-step-title-row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--ai-plan-gap-sm);
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
  font-weight: 600;
  line-height: var(--ai-plan-index-size);
  outline: none;
  padding: var(--ai-plan-title-padding-block) var(--ai-plan-title-padding-inline);
}

.ai-element-plan-step-title:focus {
  background: color-mix(in srgb, var(--surface-soft) 82%, transparent);
  box-shadow: 0 0 0 var(--ai-plan-focus-ring-size) color-mix(in srgb, var(--accent-strong) 34%, transparent);
}

.ai-element-plan-step-title:disabled {
  opacity: 0.8;
}

.ai-element-plan-risk {
  flex: 0 0 auto;
  color: var(--text-quaternary);
  font-size: var(--ai-plan-font-xs);
  text-transform: uppercase;
}

.risk-medium .ai-element-plan-risk {
  color: var(--warning);
}

.risk-high .ai-element-plan-risk {
  color: var(--danger);
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

.ai-plan-step-remove svg,
.ai-plan-button svg,
.ai-element-plan-note svg {
  width: var(--ai-plan-icon-size);
  height: var(--ai-plan-icon-size);
  stroke-width: 2;
}

.ai-element-plan-step-goal,
.ai-element-plan-step-output {
  margin: 0;
  color: var(--text-tertiary);
  font-size: var(--ai-plan-font-md);
  line-height: 1.45;
}

.ai-element-plan-step-output {
  color: var(--text-quaternary);
}

.ai-element-plan-step-notes {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: var(--ai-plan-gap-xs);
}

.ai-element-plan-note {
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  gap: var(--ai-plan-gap-xs);
  overflow: hidden;
  border: var(--ai-plan-border-width) solid color-mix(in srgb, var(--shell-divider) 82%, transparent);
  border-radius: var(--radius-sm);
  color: var(--text-tertiary);
  font-size: var(--ai-plan-font-sm);
  line-height: var(--ai-plan-index-size);
  padding: 0 var(--ai-plan-step-padding-inline);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-element-plan-note.is-risk {
  border-color: color-mix(in srgb, var(--warning) 28%, var(--shell-divider));
}

.ai-element-plan-criteria {
  display: grid;
  gap: var(--ai-plan-gap-2xs);
  margin: var(--ai-plan-gap-2xs) 0 0;
  padding: 0 0 0 var(--ai-plan-criteria-indent);
  color: var(--text-tertiary);
  font-size: var(--ai-plan-font-sm);
  line-height: 1.45;
}

.ai-element-plan-actions {
  display: flex;
  align-items: center;
  gap: var(--ai-plan-gap-md);
}

.ai-plan-button {
  display: inline-flex;
  height: var(--ai-plan-action-height);
  align-items: center;
  gap: var(--ai-plan-step-padding-inline);
  border: var(--ai-plan-border-width) solid color-mix(in srgb, var(--shell-divider) 88%, transparent);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: var(--ai-plan-font-md);
  padding: 0 var(--ai-plan-action-padding-inline);
}

.ai-plan-button.is-primary {
  margin-left: auto;
  border-color: color-mix(in srgb, var(--accent-strong) 35%, var(--shell-divider));
  background: color-mix(in srgb, var(--accent-strong) 16%, transparent);
  color: var(--text-primary);
}

.ai-plan-button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
