<script setup lang="ts">
import { ChevronDown, LoaderCircle } from 'lucide-vue-next';
import { computed, ref } from 'vue';

import AiToolConfirmationCard from '@/components/business/ai/AiToolConfirmationCard.vue';
import AiWebSearchActivity from '@/components/business/ai/AiWebSearchActivity.vue';
import { AiPlan } from '@/components/ai-elements/plan';
import { AiQueue, type IAiQueueItem } from '@/components/ai-elements/queue';
import InlineError from '@/components/common/InlineError.vue';
import type { TAgentPlanStatus } from '@/types/agent-sidecar';
import type {
    IAiAgentPlanVersionSummary,
    IAiAgentRun,
    IAiToolConfirmationRequest,
    IAiToolActivityInline,
    IAiTaskPlanStep,
    IAiWebActivity,
    TAiAgentRunStatus,
    TAiToolConfirmationDecision,
} from '@/types/ai';

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

const PLAN_STATUS_LABELS: Record<TAgentPlanStatus, string> = {
    draft: '草稿',
    pending_approval: '待审批',
    approved: '已批准',
    rejected: '已拒绝',
    executing: '执行中',
    completed: '已完成',
    failed: '失败',
};

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

const canApprove = computed(() =>
    props.steps.length >= 2 &&
    props.steps.length <= 6 &&
    !props.activeRun &&
    !props.approvedAt &&
    (
        props.planStatus === 'pending_approval' ||
        props.planStatus === 'draft' ||
        !props.planStatus
    ),
);

const canEditPlan = computed(() =>
    !props.activeRun &&
    !props.approvedAt &&
    !props.isPlanning &&
    !props.isApproving &&
    !props.isClassifying &&
    (
        props.planStatus === 'draft' ||
        !props.planStatus
    ),
);

const isTerminalRunStatus = (status: TAiAgentRunStatus): boolean =>
    status === 'completed' || status === 'failed' || status === 'cancelled';

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
            return '已暂停';
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

const runStatusClass = computed(() =>
    props.activeRun ? `is-${props.activeRun.status}` : 'is-waiting',
);

const currentStepTitle = computed(() => {
    if (!props.activeRun?.currentStepId) {
        return '';
    }

    return props.activeRun.steps.find((step) => step.id === props.activeRun?.currentStepId)?.title ?? '';
});

const completedStepCount = computed(() =>
    props.steps.filter((step) => step.status === 'done').length,
);

const totalStepCount = computed(() =>
    props.steps.length,
);

const todoTitle = computed(() =>
    totalStepCount.value > 0
        ? `待办事项(${completedStepCount.value}/${totalStepCount.value})`
        : '待办事项',
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

const loadingLabel = computed(() =>
    props.isClassifying ? '正在判断是否需要计划…' : '正在生成计划…',
);

const formatDateTime = (value: string | null | undefined): string | null => {
    if (!value) {
        return null;
    }

    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) {
        return value;
    }

    return new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(new Date(timestamp));
};

const formatStatus = (status: TAgentPlanStatus | null | undefined): string | null =>
    status ? PLAN_STATUS_LABELS[status] : null;

const shortIdentifier = (value: string): string =>
    value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;

const planAuditItems = computed(() => {
    const items: Array<{ id: string; label: string; value: string; title?: string }> = [];

    if (props.planId) {
        items.push({
            id: 'plan-id',
            label: '计划',
            value: shortIdentifier(props.planId),
            title: props.planId,
        });
    }

    if (props.planVersion) {
        items.push({
            id: 'version',
            label: '版本',
            value: `v${props.planVersion}`,
        });
    }

    const status = formatStatus(props.planStatus);
    if (status) {
        items.push({
            id: 'status',
            label: '状态',
            value: status,
        });
    }

    const updatedAt = formatDateTime(props.planUpdatedAt);
    if (updatedAt) {
        items.push({
            id: 'updated-at',
            label: '更新',
            value: updatedAt,
        });
    }

    const approvedAtLabel = formatDateTime(props.approvedAt);
    if (approvedAtLabel) {
        items.push({
            id: 'approved-at',
            label: '批准',
            value: approvedAtLabel,
        });
    }

    const executedAt = formatDateTime(props.planExecutedAt);
    if (executedAt) {
        items.push({
            id: 'executed-at',
            label: '执行',
            value: executedAt,
        });
    }

    return items;
});

const hasPlanAudit = computed(() =>
    planAuditItems.value.length > 0 ||
    Boolean(props.planRejectionReason) ||
    Boolean(props.planErrorMessage) ||
    Boolean(props.planVersions?.length),
);

const visiblePlanVersions = computed(() =>
    (props.planVersions ?? []).slice(0, 4).map((version) => ({
        key: `${version.planId}:${version.version}`,
        label: `v${version.version}`,
        status: formatStatus(version.status) ?? version.status,
        title: version.userRequest ?? version.summary ?? '',
    })),
);

const queueItems = computed<IAiQueueItem[]>(() => {
    const hasPlan = props.steps.length > 0;
    const hasError = Boolean(props.errorMessage);
    const executionStatus = props.activeRun?.status;
    const isExecuting = executionStatus === 'running-plan' ||
        executionStatus === 'running-step' ||
        executionStatus === 'waiting-for-tool-confirmation';
    const isPlanRejected = props.planStatus === 'rejected';
    const isPlanCompleted = props.planStatus === 'completed';
    const isPlanFailed = props.planStatus === 'failed';

    return [
        {
            id: 'reading',
            label: '读取上下文',
            status: props.isClassifying
                ? 'running'
                : (props.isPlanning || hasPlan || Boolean(props.activeRun) ? 'done' : 'pending'),
            detail: props.isClassifying ? '判断任务类型' : undefined,
        },
        {
            id: 'planning',
            label: '生成计划',
            status: props.isPlanning ? 'running' : hasError && !hasPlan ? 'failed' : hasPlan ? 'done' : 'pending',
            detail: props.isPlanning ? '结构化输出' : undefined,
        },
        {
            id: 'approval',
            label: '等待审批',
            status: props.isApproving
                ? 'running'
                : isPlanRejected
                    ? 'failed'
                : (props.approvedAt || props.planStatus === 'approved' || props.planStatus === 'executing'
                    ? 'done'
                    : hasPlan ? 'pending' : 'pending'),
            detail: isPlanRejected ? '已拒绝' : props.approvedAt ? '已批准' : undefined,
        },
        {
            id: 'executing',
            label: '执行计划',
            status: isExecuting
                ? 'running'
                : executionStatus === 'completed' || isPlanCompleted
                    ? 'done'
                    : executionStatus === 'failed' || executionStatus === 'cancelled' || isPlanFailed
                        ? 'failed'
                        : 'pending',
            detail: runStatusLabel.value || undefined,
        },
    ];
});

const collapseLabel = computed(() =>
    isCollapsed.value ? '展开待办事项' : '收起待办事项',
);

const shouldShowContextLine = computed(() =>
    !props.steps.length && Boolean(props.goal || props.classificationReason),
);

const canRunStep = computed(() => {
    if (!props.activeRun || props.isRunActionPending || props.toolConfirmation) {
        return false;
    }

    return props.activeRun.status !== 'paused' &&
        props.activeRun.status !== 'waiting-for-tool-confirmation' &&
        !isTerminalRunStatus(props.activeRun.status);
});

const canPauseRun = computed(() => {
    if (!props.activeRun || props.isRunActionPending) {
        return false;
    }

    return props.activeRun.status === 'running-plan' || props.activeRun.status === 'running-step';
});

const canResumeRun = computed(() =>
    Boolean(props.activeRun && props.activeRun.status === 'paused' && !props.isRunActionPending),
);

const canCancelRun = computed(() => {
    if (!props.activeRun || props.isRunActionPending) {
        return false;
    }

    return !isTerminalRunStatus(props.activeRun.status);
});

const runStepLabel = computed(() =>
    props.activeRun?.status === 'running-step' ? '完成当前步骤' : '执行下一步',
);

const handleUpdateStepTitle = (stepId: string, title: string): void => {
    emit('updateStepTitle', stepId, title);
};

const handleRemoveStep = (stepId: string): void => {
    emit('removeStep', stepId);
};

const toggleCollapsed = (): void => {
    isCollapsed.value = !isCollapsed.value;
};
</script>

<template>
    <section class="ai-plan-mode-panel" aria-label="计划模式">
        <header class="ai-plan-header">
            <button
                type="button"
                class="ai-plan-title-button"
                :aria-expanded="!isCollapsed"
                :aria-controls="planContentId"
                :aria-label="collapseLabel"
                @click="toggleCollapsed"
            >
                <ChevronDown class="ai-plan-caret" :class="{ 'is-collapsed': isCollapsed }" aria-hidden="true" />
                <h3>{{ todoTitle }}</h3>
            </button>
            <span class="ai-plan-state-label">{{ planStateLabel }}</span>
        </header>

        <div v-if="!isCollapsed" :id="planContentId" class="ai-plan-body">
            <p v-if="shouldShowContextLine" class="ai-plan-reason">
                {{ goal || classificationReason }}
            </p>
            <p v-if="approvedAt && !activeRun" class="ai-plan-approved">计划已批准，正在等待启动 Agent run。</p>
            <InlineError v-if="errorMessage" title="计划生成失败" :message="errorMessage" />

            <section v-if="hasPlanAudit" class="ai-plan-audit" aria-label="计划审计信息">
                <dl v-if="planAuditItems.length" class="ai-plan-audit-list">
                    <div v-for="item in planAuditItems" :key="item.id" class="ai-plan-audit-item" :title="item.title">
                        <dt>{{ item.label }}</dt>
                        <dd>{{ item.value }}</dd>
                    </div>
                </dl>
                <div v-if="visiblePlanVersions.length" class="ai-plan-version-list" aria-label="计划版本">
                    <span
                        v-for="version in visiblePlanVersions"
                        :key="version.key"
                        class="ai-plan-version-pill"
                        :title="version.title"
                    >
                        {{ version.label }} · {{ version.status }}
                    </span>
                </div>
                <p v-if="planRejectionReason" class="ai-plan-audit-message">
                    拒绝原因：{{ planRejectionReason }}
                </p>
                <p v-if="planErrorMessage" class="ai-plan-audit-message is-error">
                    执行错误：{{ planErrorMessage }}
                </p>
            </section>

            <div v-if="isClassifying || isPlanning" class="ai-plan-loading">
                <LoaderCircle class="ai-plan-status-icon is-spinning" aria-hidden="true" />
                <span>{{ loadingLabel }}</span>
            </div>

            <AiQueue
                v-if="steps.length || isClassifying || isPlanning || activeRun"
                :items="queueItems"
            />

            <AiPlan
                v-if="steps.length"
                :goal="goal"
                :summary="planSummary ?? null"
                :status="planStatus ?? null"
                :steps="steps"
                :is-planning="Boolean(isClassifying) || isPlanning"
                :is-approving="isApproving"
                :can-edit="canEditPlan"
                :can-approve="canApprove"
                :approved-at="approvedAt"
                @update-title="handleUpdateStepTitle"
                @remove-step="handleRemoveStep"
                @regenerate="emit('regenerate')"
                @reject="emit('reject')"
                @approve="emit('approve')"
            />

            <AiWebSearchActivity :activity="webActivity ?? null" />

            <AiToolConfirmationCard
                v-if="toolConfirmation"
                :confirmation="toolConfirmation"
                :disabled="isRunActionPending"
                @resolve="emit('resolveToolConfirmation', $event)"
            />

            <div v-if="toolActivity" class="ai-plan-tool-activity" aria-live="polite">
                <LoaderCircle class="ai-plan-status-icon is-spinning" aria-hidden="true" />
                <span>{{ toolActivity.label }}</span>
            </div>

            <section v-if="activeRun" class="ai-plan-run-card" aria-label="Agent run 状态">
                <header class="ai-plan-run-header">
                    <span class="ai-plan-run-dot" :class="runStatusClass" aria-hidden="true"></span>
                    <strong>{{ runStatusLabel }}</strong>
                    <span>{{ completedStepCount }}/{{ activeRun.steps.length }} 步</span>
                </header>
                <p v-if="currentStepTitle" class="ai-plan-run-current">当前步骤：{{ currentStepTitle }}</p>
                <InlineError v-if="activeRun.errorMessage" title="Agent run 失败" :message="activeRun.errorMessage" />
                <footer class="ai-plan-run-actions">
                    <button
                        v-if="canResumeRun"
                        type="button"
                        class="ai-plan-button is-primary"
                        :disabled="isRunActionPending"
                        @click="emit('resumeRun')"
                    >
                        继续运行
                    </button>
                    <button
                        v-else
                        type="button"
                        class="ai-plan-button is-primary"
                        :disabled="!canRunStep"
                        @click="emit('runStep')"
                    >
                        {{ isRunActionPending ? '执行中...' : runStepLabel }}
                    </button>
                    <button
                        type="button"
                        class="ai-plan-button"
                        :disabled="!canPauseRun"
                        @click="emit('pauseRun')"
                    >
                        暂停
                    </button>
                    <button
                        type="button"
                        class="ai-plan-button"
                        :disabled="!canCancelRun"
                        @click="emit('cancelRun')"
                    >
                        取消
                    </button>
                </footer>
            </section>

            <button
                v-if="!steps.length && !isClassifying && !isPlanning"
                type="button"
                class="ai-plan-button"
                @click="emit('reset')"
            >
                清空
            </button>
        </div>
    </section>
</template>

<style scoped>
.ai-plan-mode-panel {
    display: grid;
    gap: 6px;
    border-top: 1px solid var(--shell-divider);
    background: color-mix(in srgb, var(--panel-bg) 86%, transparent);
    padding: 8px 12px;
}

.ai-plan-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}

.ai-plan-title-button {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: 6px;
    border-radius: 6px;
    color: inherit;
    padding: 2px 4px 2px 0;
    transition:
        color 120ms cubic-bezier(0.23, 1, 0.32, 1),
        transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-plan-title-button:hover {
    color: var(--text-primary);
}

.ai-plan-title-button:active {
    transform: scale(0.99);
}

.ai-plan-caret {
    width: 13px;
    height: 13px;
    color: var(--text-quaternary);
    transition: transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-plan-caret.is-collapsed {
    transform: rotate(-90deg);
}

.ai-plan-header h3 {
    margin: 0;
    color: var(--text-primary);
    font-size: 12px;
    font-weight: 600;
}

.ai-plan-state-label {
    color: var(--text-quaternary);
    font-size: 11px;
    white-space: nowrap;
}

.ai-plan-body {
    display: grid;
    gap: 6px;
}

.ai-plan-goal,
.ai-plan-reason,
.ai-plan-approved,
.ai-plan-loading {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
}

.ai-plan-goal {
    color: var(--text-secondary);
}

.ai-plan-reason {
    color: var(--text-tertiary);
}

.ai-plan-approved {
    color: var(--text-tertiary);
}

.ai-plan-loading {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--text-quaternary);
}

.ai-plan-audit {
    --ai-plan-audit-gap: calc(var(--app-density-scale) * 0.375rem);
    --ai-plan-audit-padding-block: calc(var(--app-density-scale) * 0.375rem);
    --ai-plan-audit-padding-inline: calc(var(--app-density-scale) * 0.5rem);
    --ai-plan-audit-font-xs: calc(var(--app-ui-font-size) * 0.77);
    --ai-plan-audit-font-sm: calc(var(--app-ui-font-size) * 0.85);
    display: grid;
    gap: var(--ai-plan-audit-gap);
    border: thin solid color-mix(in srgb, var(--shell-divider) 82%, transparent);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--surface-soft) 52%, transparent);
    padding: var(--ai-plan-audit-padding-block) var(--ai-plan-audit-padding-inline);
}

.ai-plan-audit-list {
    display: flex;
    min-width: 0;
    flex-wrap: wrap;
    gap: var(--ai-plan-audit-gap);
    margin: 0;
}

.ai-plan-audit-item {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: calc(var(--ai-plan-audit-gap) / 1.5);
    color: var(--text-quaternary);
    font-size: var(--ai-plan-audit-font-xs);
    line-height: 1.45;
}

.ai-plan-audit-item dt,
.ai-plan-audit-item dd {
    margin: 0;
}

.ai-plan-audit-item dd {
    max-width: calc(var(--app-density-scale) * 10rem);
    overflow: hidden;
    color: var(--text-secondary);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ai-plan-version-list {
    display: flex;
    min-width: 0;
    flex-wrap: wrap;
    gap: calc(var(--ai-plan-audit-gap) / 1.25);
}

.ai-plan-version-pill {
    max-width: 100%;
    overflow: hidden;
    border: thin solid color-mix(in srgb, var(--shell-divider) 82%, transparent);
    border-radius: var(--radius-sm);
    color: var(--text-tertiary);
    font-size: var(--ai-plan-audit-font-xs);
    line-height: 1.45;
    padding: 0 calc(var(--ai-plan-audit-padding-inline) / 1.25);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ai-plan-audit-message {
    margin: 0;
    color: var(--text-tertiary);
    font-size: var(--ai-plan-audit-font-sm);
    line-height: 1.5;
}

.ai-plan-audit-message.is-error {
    color: var(--danger);
}

.ai-plan-tool-activity {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 7px;
    color: var(--text-tertiary);
    font-size: 12px;
    line-height: 18px;
}

.ai-plan-tool-activity > span:last-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ai-plan-status-icon {
    width: 13px;
    height: 13px;
    flex: 0 0 auto;
    color: var(--text-tertiary);
    stroke-width: 2;
}

.ai-plan-status-icon.is-spinning {
    animation: ai-plan-status-spin 900ms linear infinite;
}

.ai-plan-run-card {
    display: grid;
    gap: 8px;
    border: 1px solid color-mix(in srgb, var(--shell-divider) 85%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--surface-soft) 62%, transparent);
    padding: 9px;
}

.ai-plan-run-header {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    color: var(--text-quaternary);
    font-size: 11px;
}

.ai-plan-run-header strong {
    color: var(--text-primary);
    font-size: 12px;
    font-weight: 600;
}

.ai-plan-run-dot {
    width: 7px;
    height: 7px;
    flex: 0 0 auto;
    border-radius: 999px;
    background: var(--text-quaternary);
}

.ai-plan-run-dot.is-running-plan,
.ai-plan-run-dot.is-running-step,
.ai-plan-run-dot.is-waiting-for-tool-confirmation {
    background: var(--accent-strong);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-strong) 12%, transparent);
}

.ai-plan-run-dot.is-completed {
    background: var(--success);
}

.ai-plan-run-dot.is-failed,
.ai-plan-run-dot.is-cancelled {
    background: var(--danger);
}

.ai-plan-run-current {
    margin: 0;
    color: var(--text-tertiary);
    font-size: 12px;
    line-height: 1.5;
}

.ai-plan-run-actions {
    display: flex;
    align-items: center;
    gap: 7px;
}

.ai-plan-button {
    height: 26px;
    border: 1px solid color-mix(in srgb, var(--shell-divider) 88%, transparent);
    border-radius: 6px;
    color: var(--text-secondary);
    font-size: 12px;
    padding: 0 9px;
}

.ai-plan-button.is-primary {
    border-color: color-mix(in srgb, var(--accent-strong) 35%, var(--shell-divider));
    background: color-mix(in srgb, var(--accent-strong) 16%, transparent);
    color: var(--text-primary);
}

.ai-plan-button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
}

@keyframes ai-plan-status-spin {
    to {
        transform: rotate(360deg);
    }
}

@media (prefers-reduced-motion: reduce) {
    .ai-plan-status-icon.is-spinning {
        animation: none;
    }
}
</style>
