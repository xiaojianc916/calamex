<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { IAiTaskPlanStep } from '@/types/ai';

const props = defineProps<{
    step: IAiTaskPlanStep;
    canRemove: boolean;
}>();

const emit = defineEmits<{
    updateTitle: [stepId: string, title: string];
    remove: [stepId: string];
}>();

const draftTitle = ref(props.step.title);

watch(
    () => props.step.title,
    (value) => {
        draftTitle.value = value;
    },
);

const statusLabel = computed(() => {
    switch (props.step.status) {
        case 'running':
            return '进行中';
        case 'done':
            return '已完成';
        case 'failed':
            return '失败';
        case 'skipped':
            return '已跳过';
        case 'cancelled':
            return '已取消';
        default:
            return '待处理';
    }
});

const statusDotLabel = computed(() => {
    switch (props.step.status) {
        case 'running':
            return '◉';
        case 'done':
            return '●';
        case 'failed':
            return '×';
        case 'skipped':
        case 'cancelled':
            return '–';
        default:
            return '○';
    }
});

const commitTitle = (): void => {
    const nextTitle = draftTitle.value.trim();
    if (!nextTitle || nextTitle === props.step.title) {
        draftTitle.value = props.step.title;
        return;
    }

    emit('updateTitle', props.step.id, nextTitle);
};
</script>

<template>
    <li class="ai-plan-step-item" :class="[`is-${step.status}`, { 'is-active': step.isActive }]">
        <header class="ai-plan-step-header">
            <span class="ai-plan-step-index" :aria-label="statusLabel">{{ statusDotLabel }}</span>
            <input
v-model="draftTitle" class="ai-plan-step-title" type="text" aria-label="编辑计划步骤标题" @blur="commitTitle"
                @keydown.enter.prevent="commitTitle" />
            <span class="ai-plan-step-status">{{ statusLabel }}</span>
            <button type="button" class="ai-plan-step-remove" :disabled="!canRemove" @click="emit('remove', step.id)">
                删除
            </button>
        </header>

        <details class="ai-plan-step-detail">
            <summary>详情</summary>
            <p class="ai-plan-step-output">{{ step.expectedOutput }}</p>
            <footer class="ai-plan-step-meta">
                <span>风险：{{ step.riskLevel }}</span>
                <span>工具：{{ step.tools.join('、') }}</span>
            </footer>
        </details>
    </li>
</template>

<style scoped>
.ai-plan-step-item {
    display: grid;
    gap: 2px;
    border-radius: 6px;
    padding: 2px 4px;
}

.ai-plan-step-item:hover,
.ai-plan-step-item.is-active {
    background: color-mix(in srgb, var(--surface-soft) 76%, transparent);
}

.ai-plan-step-header {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 7px;
    min-height: 28px;
}

.ai-plan-step-index {
    width: 14px;
    flex: 0 0 auto;
    color: var(--text-quaternary);
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    text-align: center;
}

.ai-plan-step-item.is-running .ai-plan-step-index,
.ai-plan-step-item.is-active .ai-plan-step-index {
    color: var(--accent-strong);
}

.ai-plan-step-item.is-done .ai-plan-step-index {
    color: var(--success);
}

.ai-plan-step-item.is-failed .ai-plan-step-index {
    color: var(--danger);
}

.ai-plan-step-title {
    min-width: 0;
    flex: 1;
    color: var(--text-primary);
    font-size: 12px;
    font-weight: 500;
}

.ai-plan-step-status {
    color: var(--text-quaternary);
    font-size: 11px;
    white-space: nowrap;
}

.ai-plan-step-detail {
    margin-left: 21px;
    color: var(--text-quaternary);
    font-size: 11px;
}

.ai-plan-step-detail summary {
    width: max-content;
    cursor: pointer;
    list-style: none;
}

.ai-plan-step-detail summary::-webkit-details-marker {
    display: none;
}

.ai-plan-step-output {
    margin: 0;
    color: var(--text-secondary);
    font-size: 11px;
    line-height: 1.5;
    padding-top: 4px;
}

.ai-plan-step-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    color: var(--text-quaternary);
    font-size: 11px;
    padding: 4px 0 2px;
}

.ai-plan-step-remove {
    opacity: 0;
    color: var(--text-tertiary);
    font-size: 11px;
}

.ai-plan-step-item:hover .ai-plan-step-remove,
.ai-plan-step-remove:focus-visible {
    opacity: 1;
}

.ai-plan-step-remove:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
</style>
