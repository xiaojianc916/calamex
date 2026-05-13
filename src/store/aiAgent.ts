import type { LanguageModelUsage } from 'ai';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { z } from 'zod';

import { AGENT_PLAN_STATUSES } from '@/types/agent-sidecar';
import type {
    IAiAgentClassifyTaskPayload,
    IAiAgentPatchSummary,
    IAiAgentPlanMetadata,
    IAiAgentPlanVersionSummary,
    IAiAgentRun,
    IAiAgentStepDetail,
    IAiAgentStepFinalAnswer,
    IAiAgentStepToolResultSummary,
    IAiAgentStepWebSourceSummary,
    IAiTaskPlanStep,
    IAiToolActivityInline,
    IAiToolConfirmationRequest,
    TAiAgentNetworkPermission,
    TAiAgentTaskClassification,
} from '@/types/ai';
import {
    aiAgentNetworkPermissionSchema,
    aiAgentRunSchema,
    aiAgentStepDetailSchema,
    aiAgentTaskClassificationSchema,
    aiTaskPlanStepSchema,
} from '@/types/ai-agent.schema';
import { aiToolActivityInlineSchema } from '@/types/ai-stream.schema';
import { aiLanguageModelUsageSchema } from '@/types/ai.schema';

export type TAiAgentPanelMode = 'chat' | 'plan' | 'agent';

const aiAgentPanelModeSchema = z.enum(['chat', 'plan', 'agent']);
const agentPlanStatusSchema = z.enum(AGENT_PLAN_STATUSES);
const nullablePersistedTextSchema = z.string().min(1).nullable();

const aiAgentStepFinalAnswerSchema = z.object({
    id: z.string().min(1),
    runId: z.string().min(1),
    stepId: z.string().min(1),
    content: z.string(),
    createdAt: z.string().min(1),
});

const aiAgentPersistSchema = z.object({
    mode: aiAgentPanelModeSchema,
    networkPermission: aiAgentNetworkPermissionSchema,
    activeGoal: z.string(),
    steps: z.array(aiTaskPlanStepSchema).max(6),
    classification: aiAgentTaskClassificationSchema.nullable(),
    classificationReason: z.string(),
    shouldEnterPlanMode: z.boolean(),
    approvedAt: nullablePersistedTextSchema,
    planId: nullablePersistedTextSchema,
    planVersion: z.number().int().positive().nullable(),
    planStatus: agentPlanStatusSchema.nullable(),
    planSummary: z.string(),
    planRequiresApproval: z.boolean(),
    planThreadId: nullablePersistedTextSchema,
    planCreatedAt: nullablePersistedTextSchema,
    planUpdatedAt: nullablePersistedTextSchema,
    planExecutedAt: nullablePersistedTextSchema,
    planRejectionReason: nullablePersistedTextSchema,
    planErrorMessage: nullablePersistedTextSchema,
    activeRunId: nullablePersistedTextSchema,
    runs: z.array(aiAgentRunSchema).max(20),
    latestOfficialUsageResolved: z.boolean(),
    latestOfficialUsage: aiLanguageModelUsageSchema.nullable(),
    totalOfficialUsageResolved: z.boolean().default(false),
    totalOfficialUsage: aiLanguageModelUsageSchema.nullable().default(null),
    stepDetails: z.record(z.string(), aiAgentStepDetailSchema),
    stepFinalAnswers: z.record(z.string(), z.array(aiAgentStepFinalAnswerSchema).max(50)),
    toolActivities: z.record(z.string(), z.array(aiToolActivityInlineSchema).max(50)),
    errorMessage: z.string(),
});

type TAiAgentPersistState = z.infer<typeof aiAgentPersistSchema>;

const normalizeHydratedRun = (run: IAiAgentRun): IAiAgentRun => {
    if (
        run.status !== 'running-plan' &&
        run.status !== 'running-step' &&
        run.status !== 'waiting-for-tool-confirmation'
    ) {
        return run;
    }

    return {
        ...run,
        status: 'paused',
        steps: run.steps.map((step) => ({
            ...step,
            status: step.status === 'running' ? 'pending' : step.status,
            isActive: false,
        })),
        updatedAt: new Date().toISOString(),
    };
};

const normalizeHydratedAgentState = (state: TAiAgentPersistState): TAiAgentPersistState => {
    const runs = state.runs.map(normalizeHydratedRun);
    const activeRunId = state.activeRunId && runs.some((run) => run.id === state.activeRunId)
        ? state.activeRunId
        : null;

    return {
        ...state,
        activeRunId,
        runs,
    };
};

const applyHydratedAgentState = (
    target: TAiAgentPersistState,
    source: TAiAgentPersistState,
): void => {
    target.mode = source.mode;
    target.networkPermission = source.networkPermission;
    target.activeGoal = source.activeGoal;
    target.steps = source.steps;
    target.classification = source.classification;
    target.classificationReason = source.classificationReason;
    target.shouldEnterPlanMode = source.shouldEnterPlanMode;
    target.approvedAt = source.approvedAt;
    target.planId = source.planId;
    target.planVersion = source.planVersion;
    target.planStatus = source.planStatus;
    target.planSummary = source.planSummary;
    target.planRequiresApproval = source.planRequiresApproval;
    target.planThreadId = source.planThreadId;
    target.planCreatedAt = source.planCreatedAt;
    target.planUpdatedAt = source.planUpdatedAt;
    target.planExecutedAt = source.planExecutedAt;
    target.planRejectionReason = source.planRejectionReason;
    target.planErrorMessage = source.planErrorMessage;
    target.activeRunId = source.activeRunId;
    target.runs = source.runs;
    target.latestOfficialUsageResolved = source.latestOfficialUsageResolved;
    target.latestOfficialUsage = source.latestOfficialUsage;
    target.totalOfficialUsageResolved = source.totalOfficialUsageResolved;
    target.totalOfficialUsage = source.totalOfficialUsage;
    target.stepDetails = source.stepDetails;
    target.stepFinalAnswers = source.stepFinalAnswers;
    target.toolActivities = source.toolActivities;
    target.errorMessage = source.errorMessage;
};

const addTokenCounts = (
    left: number | undefined,
    right: number | undefined,
): number | undefined => {
    if (left === undefined && right === undefined) {
        return undefined;
    }

    return (left ?? 0) + (right ?? 0);
};

const addRequiredTokenCounts = (
    left: number | undefined,
    right: number | undefined,
): number => (left ?? 0) + (right ?? 0);

const addOfficialUsage = (
    current: LanguageModelUsage | null,
    next: LanguageModelUsage,
): LanguageModelUsage => {
    const inputTokenDetails = {
        noCacheTokens: addTokenCounts(
            current?.inputTokenDetails?.noCacheTokens,
            next.inputTokenDetails?.noCacheTokens,
        ) ?? 0,
        cacheReadTokens: addTokenCounts(
            current?.inputTokenDetails?.cacheReadTokens,
            next.inputTokenDetails?.cacheReadTokens,
        ) ?? 0,
        cacheWriteTokens: addTokenCounts(
            current?.inputTokenDetails?.cacheWriteTokens,
            next.inputTokenDetails?.cacheWriteTokens,
        ) ?? 0,
    };
    const outputTokenDetails = {
        textTokens: addTokenCounts(
            current?.outputTokenDetails?.textTokens,
            next.outputTokenDetails?.textTokens,
        ) ?? 0,
        reasoningTokens: addTokenCounts(
            current?.outputTokenDetails?.reasoningTokens,
            next.outputTokenDetails?.reasoningTokens,
        ) ?? 0,
    };
    const cachedInputTokens = addTokenCounts(current?.cachedInputTokens, next.cachedInputTokens);
    const reasoningTokens = addTokenCounts(current?.reasoningTokens, next.reasoningTokens);

    return {
        inputTokens: addRequiredTokenCounts(current?.inputTokens, next.inputTokens),
        inputTokenDetails,
        outputTokens: addRequiredTokenCounts(current?.outputTokens, next.outputTokens),
        outputTokenDetails,
        totalTokens: addRequiredTokenCounts(current?.totalTokens, next.totalTokens),
        ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
        ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    };
};

export const useAiAgentStore = defineStore('ai-agent', () => {
    const mode = ref<TAiAgentPanelMode>('agent');
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
    const latestOfficialUsageResolved = ref<boolean>(false);
    const latestOfficialUsage = ref<LanguageModelUsage | null>(null);
    const totalOfficialUsageResolved = ref<boolean>(false);
    const totalOfficialUsage = ref<LanguageModelUsage | null>(null);
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
        latestOfficialUsageResolved.value = false;
        latestOfficialUsage.value = null;
        totalOfficialUsageResolved.value = false;
        totalOfficialUsage.value = null;
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
        latestOfficialUsageResolved.value = false;
        latestOfficialUsage.value = null;
        totalOfficialUsageResolved.value = false;
        totalOfficialUsage.value = null;
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

    const setLatestOfficialUsage = (usage: LanguageModelUsage | null): void => {
        latestOfficialUsageResolved.value = true;
        latestOfficialUsage.value = usage;

        if (usage) {
            totalOfficialUsageResolved.value = true;
            totalOfficialUsage.value = addOfficialUsage(totalOfficialUsage.value, usage);
        }
    };

    const clearLatestOfficialUsage = (): void => {
        latestOfficialUsageResolved.value = false;
        latestOfficialUsage.value = null;
        totalOfficialUsageResolved.value = false;
        totalOfficialUsage.value = null;
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
        latestOfficialUsageResolved.value = false;
        latestOfficialUsage.value = null;
        totalOfficialUsageResolved.value = false;
        totalOfficialUsage.value = null;
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
        latestOfficialUsageResolved,
        latestOfficialUsage,
        totalOfficialUsageResolved,
        totalOfficialUsage,
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
        setLatestOfficialUsage,
        clearLatestOfficialUsage,
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
}, {
    persist: {
        key: 'shell-ide.ai-agent',
        pick: [
            'mode',
            'networkPermission',
            'activeGoal',
            'steps',
            'classification',
            'classificationReason',
            'shouldEnterPlanMode',
            'approvedAt',
            'planId',
            'planVersion',
            'planStatus',
            'planSummary',
            'planRequiresApproval',
            'planThreadId',
            'planCreatedAt',
            'planUpdatedAt',
            'planExecutedAt',
            'planRejectionReason',
            'planErrorMessage',
            'activeRunId',
            'runs',
            'latestOfficialUsageResolved',
            'latestOfficialUsage',
            'totalOfficialUsageResolved',
            'totalOfficialUsage',
            'stepDetails',
            'stepFinalAnswers',
            'toolActivities',
            'errorMessage',
        ],
        afterHydrate(ctx) {
            const store = ctx.store as unknown as TAiAgentPersistState;
            const parsed = aiAgentPersistSchema.safeParse({
                mode: store.mode,
                networkPermission: store.networkPermission,
                activeGoal: store.activeGoal,
                steps: store.steps,
                classification: store.classification,
                classificationReason: store.classificationReason,
                shouldEnterPlanMode: store.shouldEnterPlanMode,
                approvedAt: store.approvedAt,
                planId: store.planId,
                planVersion: store.planVersion,
                planStatus: store.planStatus,
                planSummary: store.planSummary,
                planRequiresApproval: store.planRequiresApproval,
                planThreadId: store.planThreadId,
                planCreatedAt: store.planCreatedAt,
                planUpdatedAt: store.planUpdatedAt,
                planExecutedAt: store.planExecutedAt,
                planRejectionReason: store.planRejectionReason,
                planErrorMessage: store.planErrorMessage,
                activeRunId: store.activeRunId,
                runs: store.runs,
                latestOfficialUsageResolved: store.latestOfficialUsageResolved,
                latestOfficialUsage: store.latestOfficialUsage,
                totalOfficialUsageResolved: store.totalOfficialUsageResolved,
                totalOfficialUsage: store.totalOfficialUsage,
                stepDetails: store.stepDetails,
                stepFinalAnswers: store.stepFinalAnswers,
                toolActivities: store.toolActivities,
                errorMessage: store.errorMessage,
            });

            if (!parsed.success) {
                return;
            }

            applyHydratedAgentState(store, normalizeHydratedAgentState(parsed.data));
        },
    },
});
