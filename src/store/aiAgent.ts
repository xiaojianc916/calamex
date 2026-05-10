import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import type {
    IAiAgentPatchSummary,
    IAiAgentClassifyTaskPayload,
    IAiAgentPlanMetadata,
    IAiAgentPlanVersionSummary,
    IAiAgentRun,
    IAiAgentStepDetail,
    IAiAgentStepFinalAnswer,
    IAiAgentStepToolResultSummary,
    IAiAgentStepWebSourceSummary,
    IAiToolConfirmationRequest,
    IAiToolActivityInline,
    IAiTaskPlanStep,
    TAiAgentNetworkPermission,
    TAiAgentTaskClassification,
} from '@/types/ai';

export type TAiAgentPanelMode = 'chat' | 'plan' | 'agent';

export const useAiAgentStore = defineStore('ai-agent', () => {
    const mode = ref<TAiAgentPanelMode>('chat');
    const networkPermission = ref<TAiAgentNetworkPermission>('ask');
    const activeGoal = ref<string>('');
    const steps = ref<IAiTaskPlanStep[]>([]);
    const classification = ref<TAiAgentTaskClassification | null>(null);
    const classificationReason = ref<string>('');
    const shouldEnterPlanMode = ref<boolean>(false);
    const isClassifying = ref<boolean>(false);
    const isPlanning = ref<boolean>(false);
    const isApproving = ref<boolean>(false);
    const approvedAt = ref<string | null>(null);
    const planId = ref<string | null>(null);
    const planVersion = ref<number | null>(null);
    const planStatus = ref<IAiAgentPlanMetadata['status'] | null>(null);
    const planSummary = ref<string>('');
    const planRequiresApproval = ref<boolean>(true);
    const planThreadId = ref<string | null>(null);
    const planCreatedAt = ref<string | null>(null);
    const planUpdatedAt = ref<string | null>(null);
    const planExecutedAt = ref<string | null>(null);
    const planRejectionReason = ref<string | null>(null);
    const planErrorMessage = ref<string | null>(null);
    const planVersions = ref<IAiAgentPlanVersionSummary[]>([]);
    const activeRunId = ref<string | null>(null);
    const runs = ref<IAiAgentRun[]>([]);
    const stepDetails = ref<Record<string, IAiAgentStepDetail>>({});
    const stepFinalAnswers = ref<Record<string, IAiAgentStepFinalAnswer[]>>({});
    const patchSummaries = ref<Record<string, IAiAgentPatchSummary[]>>({});
    const toolActivities = ref<Record<string, IAiToolActivityInline[]>>({});
    const pendingToolConfirmation = ref<IAiToolConfirmationRequest | null>(null);
    const errorMessage = ref<string>('');

    const hasPlan = computed(() => steps.value.length > 0);
    const activeRun = computed(() =>
        runs.value.find((run) => run.id === activeRunId.value) ?? null,
    );
    const isActiveToolActivity = (activity: IAiToolActivityInline): boolean =>
        activity.state === 'starting' ||
        activity.state === 'running' ||
        activity.state === 'waiting-confirmation';

    const findLatestActiveToolActivity = (
        activities: IAiToolActivityInline[],
    ): IAiToolActivityInline | null =>
        [...activities].reverse().find(isActiveToolActivity) ?? null;

    const activeToolActivity = computed(() => {
        if (pendingToolConfirmation.value) {
            return null;
        }

        const runId = activeRunId.value;
        const currentRunActivity = runId
            ? findLatestActiveToolActivity(toolActivities.value[runId] ?? [])
            : null;

        if (currentRunActivity) {
            return currentRunActivity;
        }

        return findLatestActiveToolActivity(Object.values(toolActivities.value).flat());
    });

    const getStepDetailKey = (runId: string, stepId: string): string => `${runId}:${stepId}`;

    const createStepDetail = (runId: string, stepId: string): IAiAgentStepDetail => ({
        runId,
        stepId,
        webSources: [],
        toolResults: [],
        updatedAt: new Date().toISOString(),
    });

    const setClassification = (payload: IAiAgentClassifyTaskPayload): void => {
        classification.value = payload.classification;
        shouldEnterPlanMode.value = payload.shouldEnterPlanMode;
        classificationReason.value = payload.reason;
    };

    const beginPlanning = (goal: string): void => {
        activeGoal.value = goal;
        steps.value = [];
        approvedAt.value = null;
        planId.value = null;
        planVersion.value = null;
        planStatus.value = null;
        planSummary.value = '';
        planRequiresApproval.value = true;
        planThreadId.value = null;
        planCreatedAt.value = null;
        planUpdatedAt.value = null;
        planExecutedAt.value = null;
        planRejectionReason.value = null;
        planErrorMessage.value = null;
        planVersions.value = [];
        activeRunId.value = null;
        classification.value = null;
        classificationReason.value = '';
        shouldEnterPlanMode.value = false;
        pendingToolConfirmation.value = null;
        errorMessage.value = '';
    };

    const failPlanning = (goal: string, message: string): void => {
        activeGoal.value = goal;
        steps.value = [];
        approvedAt.value = null;
        planId.value = null;
        planVersion.value = null;
        planStatus.value = null;
        planSummary.value = '';
        planRequiresApproval.value = true;
        planThreadId.value = null;
        planCreatedAt.value = null;
        planUpdatedAt.value = null;
        planExecutedAt.value = null;
        planRejectionReason.value = null;
        planErrorMessage.value = null;
        planVersions.value = [];
        activeRunId.value = null;
        shouldEnterPlanMode.value = false;
        pendingToolConfirmation.value = null;
        errorMessage.value = message;
        mode.value = 'plan';
    };

    const setNetworkPermission = (permission: TAiAgentNetworkPermission): void => {
        networkPermission.value = permission;
    };

    const setPlan = (
        goal: string,
        nextSteps: IAiTaskPlanStep[],
        metadata: IAiAgentPlanMetadata | null = null,
    ): void => {
        activeGoal.value = goal;
        steps.value = nextSteps;
        approvedAt.value = null;
        planId.value = metadata?.planId ?? null;
        planVersion.value = metadata?.version ?? null;
        planStatus.value = metadata?.status ?? null;
        planSummary.value = metadata?.summary ?? '';
        planRequiresApproval.value = metadata?.requiresApproval ?? true;
        planThreadId.value = metadata?.threadId ?? null;
        planCreatedAt.value = metadata?.createdAt ?? null;
        planUpdatedAt.value = metadata?.updatedAt ?? null;
        planExecutedAt.value = metadata?.executedAt ?? null;
        planRejectionReason.value = metadata?.rejectionReason ?? null;
        planErrorMessage.value = metadata?.errorMessage ?? null;
        planVersions.value = metadata ? [{
            ...metadata,
        }] : [];
        activeRunId.value = null;
    };

    const applyPlanMetadata = (
        metadata: IAiAgentPlanMetadata,
        versions: IAiAgentPlanVersionSummary[] = planVersions.value,
    ): void => {
        planId.value = metadata.planId;
        planVersion.value = metadata.version;
        planStatus.value = metadata.status;
        planSummary.value = metadata.summary ?? planSummary.value;
        planRequiresApproval.value = metadata.requiresApproval ?? planRequiresApproval.value;
        planThreadId.value = metadata.threadId ?? planThreadId.value;
        planCreatedAt.value = metadata.createdAt ?? planCreatedAt.value;
        planUpdatedAt.value = metadata.updatedAt ?? planUpdatedAt.value;
        approvedAt.value = metadata.approvedAt !== undefined ? metadata.approvedAt : approvedAt.value;
        planExecutedAt.value = metadata.executedAt !== undefined ? metadata.executedAt : planExecutedAt.value;
        planRejectionReason.value = metadata.rejectionReason !== undefined
            ? metadata.rejectionReason
            : planRejectionReason.value;
        planErrorMessage.value = metadata.errorMessage !== undefined
            ? metadata.errorMessage
            : planErrorMessage.value;
        planVersions.value = versions;
    };

    const setPlanStatus = (
        status: IAiAgentPlanMetadata['status'],
        nextApprovedAt: string | null = approvedAt.value,
    ): void => {
        planStatus.value = status;
        approvedAt.value = nextApprovedAt;
    };

    const replaceStep = (stepId: string, nextStep: IAiTaskPlanStep): void => {
        steps.value = steps.value.map((step) => (step.id === stepId ? nextStep : step));
        approvedAt.value = null;
        planStatus.value = planStatus.value === 'approved' ? 'pending_approval' : planStatus.value;
        activeRunId.value = null;
    };

    const removeStep = (stepId: string): void => {
        steps.value = steps.value.filter((step) => step.id !== stepId);
        approvedAt.value = null;
        planStatus.value = planStatus.value === 'approved' ? 'pending_approval' : planStatus.value;
        activeRunId.value = null;
    };

    const clearPlan = (): void => {
        activeGoal.value = '';
        steps.value = [];
        approvedAt.value = null;
        planId.value = null;
        planVersion.value = null;
        planStatus.value = null;
        planSummary.value = '';
        planRequiresApproval.value = true;
        planThreadId.value = null;
        planCreatedAt.value = null;
        planUpdatedAt.value = null;
        planExecutedAt.value = null;
        planRejectionReason.value = null;
        planErrorMessage.value = null;
        planVersions.value = [];
        classificationReason.value = '';
        classification.value = null;
        shouldEnterPlanMode.value = false;
        isClassifying.value = false;
        isPlanning.value = false;
        isApproving.value = false;
        errorMessage.value = '';
        activeRunId.value = null;
    };

    const upsertRun = (run: IAiAgentRun): void => {
        activeRunId.value = run.id;
        runs.value = [
            run,
            ...runs.value.filter((item) => item.id !== run.id),
        ];
        steps.value = run.steps;
    };

    const setRuns = (nextRuns: IAiAgentRun[]): void => {
        runs.value = nextRuns;
        if (activeRunId.value && !nextRuns.some((run) => run.id === activeRunId.value)) {
            activeRunId.value = null;
        }
    };

    const getStepDetail = (runId: string, stepId: string): IAiAgentStepDetail | null =>
        stepDetails.value[getStepDetailKey(runId, stepId)] ?? null;

    const upsertStepDetail = (detail: IAiAgentStepDetail): void => {
        stepDetails.value = {
            ...stepDetails.value,
            [getStepDetailKey(detail.runId, detail.stepId)]: {
                ...detail,
                updatedAt: new Date().toISOString(),
            },
        };
    };

    const setStepWebSources = (
        runId: string,
        stepId: string,
        webSources: IAiAgentStepWebSourceSummary[],
    ): void => {
        const previous = getStepDetail(runId, stepId) ?? createStepDetail(runId, stepId);
        upsertStepDetail({
            ...previous,
            webSources,
        });
    };

    const appendStepToolResults = (
        runId: string,
        stepId: string,
        toolResults: IAiAgentStepToolResultSummary[],
    ): void => {
        if (!toolResults.length) {
            return;
        }

        const previous = getStepDetail(runId, stepId) ?? createStepDetail(runId, stepId);
        upsertStepDetail({
            ...previous,
            toolResults: [
                ...previous.toolResults,
                ...toolResults,
            ],
        });
    };

    const getPatchSummaries = (runId: string): IAiAgentPatchSummary[] =>
        patchSummaries.value[runId] ?? [];

    const getStepFinalAnswers = (runId: string): IAiAgentStepFinalAnswer[] =>
        stepFinalAnswers.value[runId] ?? [];

    const appendStepFinalAnswer = (answer: IAiAgentStepFinalAnswer): void => {
        const previous = getStepFinalAnswers(answer.runId);
        stepFinalAnswers.value = {
            ...stepFinalAnswers.value,
            [answer.runId]: [
                ...previous.filter((item) => item.id !== answer.id),
                answer,
            ].slice(-50),
        };
    };

    const appendPatchSummary = (summary: IAiAgentPatchSummary): void => {
        const previous = getPatchSummaries(summary.runId);
        patchSummaries.value = {
            ...patchSummaries.value,
            [summary.runId]: [
                ...previous.filter((item) => item.id !== summary.id),
                summary,
            ],
        };
    };

    const getToolActivities = (runId: string): IAiToolActivityInline[] =>
        toolActivities.value[runId] ?? [];

    const appendToolActivity = (runId: string, activity: IAiToolActivityInline): void => {
        const previous = getToolActivities(runId);
        toolActivities.value = {
            ...toolActivities.value,
            [runId]: [
                ...previous.filter((item) =>
                    item.id !== activity.id &&
                    !(item.stepId === activity.stepId && item.toolName === activity.toolName),
                ),
                activity,
            ].slice(-50),
        };
    };

    const setPendingToolConfirmation = (confirmation: IAiToolConfirmationRequest): void => {
        pendingToolConfirmation.value = confirmation;
    };

    const clearPendingToolConfirmation = (confirmationId?: string): void => {
        if (!confirmationId || pendingToolConfirmation.value?.id === confirmationId) {
            pendingToolConfirmation.value = null;
        }
    };

    const upsertRunStep = (runId: string, step: IAiTaskPlanStep): void => {
        const targetRun = runs.value.find((run) => run.id === runId);

        if (!targetRun) {
            steps.value = steps.value.map((item) => (item.id === step.id ? step : item));
            return;
        }

        upsertRun({
            ...targetRun,
            steps: targetRun.steps.map((item) => (item.id === step.id ? step : item)),
            currentStepId: step.status === 'running'
                ? step.id
                : targetRun.currentStepId === step.id ? null : targetRun.currentStepId,
            updatedAt: new Date().toISOString(),
        });
    };

    return {
        mode,
        networkPermission,
        activeGoal,
        steps,
        classification,
        classificationReason,
        shouldEnterPlanMode,
        isClassifying,
        isPlanning,
        isApproving,
        approvedAt,
        planId,
        planVersion,
        planStatus,
        planSummary,
        planRequiresApproval,
        planThreadId,
        planCreatedAt,
        planUpdatedAt,
        planExecutedAt,
        planRejectionReason,
        planErrorMessage,
        planVersions,
        activeRunId,
        runs,
        stepDetails,
        stepFinalAnswers,
        patchSummaries,
        toolActivities,
        pendingToolConfirmation,
        errorMessage,
        hasPlan,
        activeRun,
        activeToolActivity,
        getStepDetail,
        getPatchSummaries,
        getStepFinalAnswers,
        getToolActivities,
        setNetworkPermission,
        setClassification,
        beginPlanning,
        failPlanning,
        setPlan,
        applyPlanMetadata,
        setPlanStatus,
        replaceStep,
        removeStep,
        clearPlan,
        upsertRun,
        upsertRunStep,
        setRuns,
        upsertStepDetail,
        setStepWebSources,
        appendStepToolResults,
        appendStepFinalAnswer,
        appendPatchSummary,
        appendToolActivity,
        setPendingToolConfirmation,
        clearPendingToolConfirmation,
    };
});
