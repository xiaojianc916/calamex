<script setup lang="ts">
import { AlertCircle, CheckCircle2, Circle, LoaderCircle } from 'lucide-vue-next';

export type TAiQueueItemStatus = 'pending' | 'running' | 'done' | 'failed';

export interface IAiQueueItem {
  id: string;
  label: string;
  status: TAiQueueItemStatus;
  detail?: string;
}

defineProps<{
  items: IAiQueueItem[];
}>();
</script>

<template>
  <ol class="ai-element-queue" aria-label="计划流程状态">
    <li v-for="item in items" :key="item.id" class="ai-element-queue-item" :class="`is-${item.status}`">
      <LoaderCircle
        v-if="item.status === 'running'"
        class="ai-element-queue-icon ai-plan-status-icon is-spinning"
        aria-hidden="true"
      />
      <CheckCircle2
        v-else-if="item.status === 'done'"
        class="ai-element-queue-icon"
        aria-hidden="true"
      />
      <AlertCircle
        v-else-if="item.status === 'failed'"
        class="ai-element-queue-icon"
        aria-hidden="true"
      />
      <Circle v-else class="ai-element-queue-icon" aria-hidden="true" />
      <span class="ai-element-queue-copy">
        <span class="ai-element-queue-label">{{ item.label }}</span>
        <span v-if="item.detail" class="ai-element-queue-detail">{{ item.detail }}</span>
      </span>
    </li>
  </ol>
</template>

<style scoped>
.ai-element-queue {
  --ai-queue-border-width: thin;
  --ai-queue-gap-xs: calc(var(--app-density-scale) * 0.25rem);
  --ai-queue-gap-sm: calc(var(--app-density-scale) * 0.375rem);
  --ai-queue-padding-block: calc(var(--app-density-scale) * 0.3125rem);
  --ai-queue-padding-inline: calc(var(--app-density-scale) * 0.375rem);
  --ai-queue-icon-size: 1em;
  --ai-queue-font-xs: calc(var(--app-ui-font-size) * 0.77);
  --ai-queue-font-sm: calc(var(--app-ui-font-size) * 0.85);
  --ai-queue-spin-duration: calc(var(--motion-duration-normal) * 5);
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--ai-queue-gap-xs);
  margin: 0;
  padding: 0;
  list-style: none;
}

.ai-element-queue-item {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--ai-queue-gap-sm);
  border: var(--ai-queue-border-width) solid color-mix(in srgb, var(--shell-divider) 82%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--surface-soft) 44%, transparent);
  color: var(--text-quaternary);
  padding: var(--ai-queue-padding-block) var(--ai-queue-padding-inline);
}

.ai-element-queue-item.is-running {
  border-color: color-mix(in srgb, var(--accent-strong) 28%, var(--shell-divider));
  color: var(--text-secondary);
}

.ai-element-queue-item.is-done {
  color: var(--text-tertiary);
}

.ai-element-queue-item.is-failed {
  border-color: color-mix(in srgb, var(--danger) 30%, var(--shell-divider));
  color: var(--danger);
}

.ai-element-queue-icon {
  width: var(--ai-queue-icon-size);
  height: var(--ai-queue-icon-size);
  flex: 0 0 auto;
  stroke-width: 2;
}

.ai-element-queue-copy {
  display: grid;
  min-width: 0;
  gap: calc(var(--ai-queue-gap-xs) / 4);
}

.ai-element-queue-label,
.ai-element-queue-detail {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-element-queue-label {
  color: var(--text-secondary);
  font-size: var(--ai-queue-font-sm);
  font-weight: 500;
  line-height: 1.35;
}

.ai-element-queue-detail {
  color: var(--text-quaternary);
  font-size: var(--ai-queue-font-xs);
  line-height: 1.3;
}

.ai-plan-status-icon.is-spinning {
  animation: ai-element-queue-spin var(--ai-queue-spin-duration) var(--motion-easing-linear) infinite;
}

@keyframes ai-element-queue-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 45rem) {
  .ai-element-queue {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (prefers-reduced-motion: reduce) {
  .ai-plan-status-icon.is-spinning {
    animation: none;
  }
}
</style>
