<script setup lang="ts">
import type { IAiTaskPlanStep } from '@/types/ai';

defineProps<{
  steps: IAiTaskPlanStep[];
}>();
</script>

<template>
  <ol v-if="steps.length" class="ai-task-plan">
    <li v-for="step in steps" :key="step.id" :class="`is-${step.status}`">
      <span>{{ step.title }}</span>
      <em>{{ step.status }}</em>
    </li>
  </ol>
</template>

<style scoped>
.ai-task-plan {
  display: grid;
  gap: 6px;
  margin: 8px 12px;
  padding: 0;
  list-style: none;
}

.ai-task-plan li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid var(--shell-divider);
  border-radius: 7px;
  color: var(--text-secondary);
  font-size: 12px;
  padding: 7px 9px;
}

.ai-task-plan em {
  color: var(--text-quaternary);
  font-style: normal;
}
</style>
