<script setup lang="ts">
import { AlertCircle, Check, Circle, LoaderCircle, Trash2 } from '@lucide/vue';
export type TAiQueueItemStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface IAiQueueItem {
  id: string;
  label: string;
  status: TAiQueueItemStatus;
  editable?: boolean;
  inputDisabled?: boolean;
  removable?: boolean;
  removeDisabled?: boolean;
}

defineProps<{
  items: IAiQueueItem[];
}>();

const emit = defineEmits<{
  updateLabel: [itemId: string, label: string];
  removeItem: [itemId: string];
}>();

const getInputValue = (event: Event): string =>
  event.target instanceof HTMLInputElement ? event.target.value : '';

const submitLabel = (itemId: string, value: string): void => {
  const normalized = value.trim();

  if (!normalized) {
    return;
  }

  emit('updateLabel', itemId, normalized);
};

const handleLabelEnter = (itemId: string, event: Event): void => {
  submitLabel(itemId, getInputValue(event));
};

const handleLabelBlur = (item: IAiQueueItem, event: Event): void => {
  const normalized = getInputValue(event).trim();

  if (normalized && normalized !== item.label) {
    emit('updateLabel', item.id, normalized);
  }
};
</script>

<template>
  <ol class="ai-element-queue" aria-label="计划流程状态">
    <li v-for="item in items" :key="item.id" class="ai-element-queue-item" :class="`is-${item.status}`">
      <LoaderCircle class="ai-element-queue-icon ai-plan-status-icon is-spinning" v-if="item.status === 'running'" aria-hidden="true" />
      <span v-else-if="item.status === 'done'" class="ai-element-queue-indicator" aria-hidden="true">
        <Check class="ai-element-queue-check" />
      </span>
      <AlertCircle class="ai-element-queue-icon" v-else-if="item.status === 'failed' || item.status === 'cancelled'" aria-hidden="true" />
      <Circle class="ai-element-queue-icon" v-else aria-hidden="true" />
      <input v-if="item.editable" class="ai-element-queue-label ai-element-queue-input" :value="item.label"
        aria-label="编辑计划步骤标题" :disabled="item.inputDisabled" @keydown.enter.prevent="handleLabelEnter(item.id, $event)"
        @blur="handleLabelBlur(item, $event)" />
      <span v-else class="ai-element-queue-label">{{ item.label }}</span>
      <button v-if="item.removable" type="button" class="ai-element-queue-action ai-plan-step-remove"
        :disabled="item.removeDisabled" aria-label="删除计划步骤" title="删除计划步骤" @click="emit('removeItem', item.id)">
        <Trash2 aria-hidden="true" />
      </button>
    </li>
  </ol>
</template>

<style scoped>
.ai-element-queue {
  --ai-queue-border-width: thin;
  --ai-queue-gap-sm: calc(var(--app-density-scale) * 0.5rem);
  --ai-queue-padding-block: calc(var(--app-density-scale) * 0.375rem);
  --ai-queue-padding-inline: calc(var(--app-density-scale) * 0.5rem);
  --ai-queue-icon-size: calc(var(--app-density-scale) * 0.875rem);
  --ai-queue-action-size: calc(var(--app-density-scale) * 1.375rem);
  --ai-queue-font-sm: calc(var(--app-ui-font-size) * 0.85);
  --ai-queue-spin-duration: calc(var(--motion-duration-normal) * 5);
  display: grid;
  gap: calc(var(--app-density-scale) * 0.0625rem);
  margin: 0;
  padding: 0;
  list-style: none;
}

.ai-element-queue-item {
  position: relative;
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--ai-queue-gap-sm);
  border-radius: var(--radius-sm);
  color: var(--text-quaternary);
  padding: var(--ai-queue-padding-block) var(--ai-queue-padding-inline);
  transition:
    background-color var(--motion-duration-fast) var(--motion-easing-standard),
    color var(--motion-duration-fast) var(--motion-easing-standard),
    transform var(--motion-duration-fast) var(--motion-easing-standard);
}

.ai-element-queue-item:hover {
  background: color-mix(in srgb, var(--surface-hover) 70%, transparent);
}

.ai-element-queue-item:active {
  transform: scale(0.995);
}

.ai-element-queue-item.is-running,
.ai-element-queue-item.is-done {
  color: var(--text-secondary);
}

.ai-element-queue-item.is-skipped {
  color: var(--text-tertiary);
}

.ai-element-queue-item.is-failed,
.ai-element-queue-item.is-cancelled {
  color: var(--danger);
}

.ai-element-queue-icon,
.ai-element-queue-indicator {
  width: var(--ai-queue-icon-size);
  height: var(--ai-queue-icon-size);
  flex: 0 0 auto;
  stroke-width: 2;
}

.ai-element-queue-indicator {
  display: inline-grid;
  place-items: center;
  border-radius: calc(var(--radius-xl) * 1000);
  background: var(--text-secondary);
  color: var(--panel-bg);
}

.ai-element-queue-check {
  width: calc(var(--ai-queue-icon-size) * 0.72);
  height: calc(var(--ai-queue-icon-size) * 0.72);
  stroke-width: 2.4;
}

.ai-element-queue-label {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--ai-queue-font-sm);
  font-weight: 500;
  line-height: 1.55;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-element-queue-input {
  border-radius: var(--radius-sm);
  outline: none;
  padding: 0 calc(var(--app-density-scale) * 0.125rem);
}

.ai-element-queue-input:focus {
  background: color-mix(in srgb, var(--surface-soft) 82%, transparent);
  box-shadow: 0 0 0 var(--ai-queue-border-width) color-mix(in srgb, var(--accent-strong) 34%, transparent);
}

.ai-element-queue-input:disabled {
  opacity: 0.9;
  cursor: default;
}

.ai-element-queue-action {
  display: inline-grid;
  width: var(--ai-queue-action-size);
  height: var(--ai-queue-action-size);
  flex: 0 0 auto;
  place-items: center;
  border-radius: var(--radius-sm);
  color: var(--text-quaternary);
  opacity: 0;
  transition:
    background-color var(--motion-duration-fast) var(--motion-easing-standard),
    color var(--motion-duration-fast) var(--motion-easing-standard),
    opacity var(--motion-duration-fast) var(--motion-easing-standard),
    transform var(--motion-duration-fast) var(--motion-easing-standard);
}

.ai-element-queue-action:hover:not(:disabled) {
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  color: var(--danger);
}

.ai-element-queue-action:active:not(:disabled) {
  transform: scale(0.96);
}

.ai-element-queue-action:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}

.ai-element-queue-action svg {
  width: calc(var(--ai-queue-icon-size) * 0.9);
  height: calc(var(--ai-queue-icon-size) * 0.9);
  stroke-width: 2;
}

@media (hover: hover) and (pointer: fine) {
  .ai-element-queue-item:hover .ai-element-queue-action {
    opacity: 1;
  }
}

.ai-plan-status-icon.is-spinning {
  animation: ai-element-queue-spin var(--ai-queue-spin-duration) var(--motion-easing-linear) infinite;
}

@keyframes ai-element-queue-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {

  .ai-element-queue-item,
  .ai-element-queue-action {
    transition-duration: 1ms;
  }

  .ai-plan-status-icon.is-spinning {
    animation: none;
  }
}
</style>
