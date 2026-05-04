<script setup lang="ts">
import AiPlanStepItem from '@/components/business/ai/AiPlanStepItem.vue';
import type { IAiTaskPlanStep } from '@/types/ai';

defineProps<{
    steps: IAiTaskPlanStep[];
}>();

const emit = defineEmits<{
    updateTitle: [stepId: string, title: string];
    removeStep: [stepId: string];
}>();

const MIN_STEP_COUNT = 2;

const handleUpdateTitle = (stepId: string, title: string): void => {
    emit('updateTitle', stepId, title);
};

const handleRemoveStep = (stepId: string): void => {
    emit('removeStep', stepId);
};
</script>

<template>
    <ol class="ai-plan-step-list">
        <AiPlanStepItem
v-for="step in steps" :key="step.id" :step="step" :can-remove="steps.length > MIN_STEP_COUNT"
            @update-title="handleUpdateTitle" @remove="handleRemoveStep" />
    </ol>
</template>

<style scoped>
.ai-plan-step-list {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
}
</style>
