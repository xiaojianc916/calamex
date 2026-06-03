import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { z } from 'zod';
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
  IAiChatMessage,
  IAiContextReference,
  IAiLanguageModelUsage,
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
  aiToolConfirmationRequestSchema,
} from '@/types/ai/agent.schema';
import { AI_ASSISTANT_MODES, type TAiAssistantMode } from '@/types/ai/assistant-mode';
import { aiContextReferenceSchema } from '@/types/ai/context.schema';
import { aiChatMessageSchema, aiLanguageModelUsageSchema } from '@/types/ai/schema';
import { AGENT_PLAN_STATUSES } from '@/types/ai/sidecar';
import { aiToolActivityInlineSchema } from '@/types/ai/stream.schema';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IAiPersistedSidecarAgentSession {
  sessionId: string;
  assistantMessageId: string;
  threadId: string | null;
  turnId: string | null;
  baseMessages: IAiChatMessage[];
  messageContent: string;
  references: IAiContextReference[];
}

export type TAiAgentPanelMode = TAiAssistantMode;

// ---------------------------------------------------------------------------
// Persistence schema
// ---------------------------------------------------------------------------

const aiAgentPanelModeSchema = z.enum(AI_ASSISTANT_MODES);
const agentPlanStatusSchema = z.enum(AGENT_PLAN_STATUSES);
const nullablePersistedTextSchema = z.string().min(1).nullable();

const aiAgentStepFinalAnswerSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  stepId: z.string().min(1),
  content: z.string(),
  createdAt: z.string().min(1),
});

const aiPersistedSidecarAgentSessionSchema = z.object({
  sessionId: z.string().min(1),
  assistantMessageId: z.string().min(1),
  threadId: z.string().min(1).nullable(),
  turnId: z.string().min(1).nullable(),
  baseMessages: z.array(aiChatMessageSchema).max(20),
  messageContent: z.string(),
  references: z.array(aiContextReferenceSchema).max(20),
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
  pendingToolConfirmation: aiToolConfirmationRequestSchema.nullable(),
  pendingSidecarAgentSession: aiPersistedSidecarAgentSessionSchema.nullable(),
  errorMessage: z.string(),
});

type TAiAgentPersistState = z.infer<typeof aiAgentPersistSchema>;

// hydrate 内部用 schema 推断的行类型，避免与手写接口 IAiAgentRun / IAiTaskPlanStep
// 产生「同义但不同形」的 TS 漂移 (TS2322)。
type TPersistedAgentRun = TAiAgentPersistState['runs'][number];
type TPersistedPlanStep = TPersistedAgentRun['steps'][number];

// ---------------------------------------------------------------------------
// Hydrate helpers
// ---------------------------------------------------------------------------

const normalizeHydratedRun = (run: TPersistedAgentRun): TPersistedAgentRun => {
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
    steps: run.steps.map(
      (step): TPersistedPlanStep => ({
        ...step,
        status: step.status === 'running' ? 'pending' : step.status,
        isActive: false,
      }),
    ),
    updatedAt: new Date().toISOString(),
  };
};

const normalizeHydratedAgentState = (state: TAiAgentPersistState): TAiAgentPersistState => {
  const runs = state.runs.map(normalizeHydratedRun);
  const activeRunId =
    state.activeRunId && runs.some((run) => run.id === state.activeRunId)
      ? state.activeRunId
      : null;
  return {
    ...state,
    activeRunId,
    runs,
    // 没有待确认工具时,顺手清掉 pending sidecar session,避免「确认窗口已关但 session 残留」
    pendingSidecarAgentSession: state.pendingToolConfirmation
      ? state.pendingSidecarAgentSession
      : null,
  };
};

// store 与 source 同型,逐字段赋值改成 Object.assign,避免后续加字段时漏同步。
const applyHydratedAgentState = (
  target: TAiAgentPersistState,
  source: TAiAgentPersistState,
): void => {
  Object.assign(target, source);
};

// ---------------------------------------------------------------------------
// Usage aggregation helpers
// ---------------------------------------------------------------------------

const addTokenCounts = (
  left: number | undefined,
  right: number | undefined,
): number | undefined => {
  if (left === undefined && right === undefined) {
    return undefined;
  }
  return (left ?? 0) + (right ?? 0);
};

const addRequiredTokenCounts = (left: number | undefined, right: number | undefined): number =>
  (left ?? 0) + (right ?? 0);

const addOfficialUsage = (
  current: IAiLanguageModelUsage | null,
  next: IAiLanguageModelUsage,
): IAiLanguageModelUsage => {
  const inputTokenDetails = {
    noCacheTokens:
      addTokenCounts(
        current?.inputTokenDetails?.noCacheTokens,
        next.inputTokenDetails?.noCacheTokens,
      ) ?? 0,
    cacheReadTokens:
      addTokenCounts(
        current?.inputTokenDetails?.cacheReadTokens,
        next.inputTokenDetails?.cacheReadTokens,
      ) ?? 0,
    cacheWriteTokens:
      addTokenCounts(
        current?.inputTokenDetails?.cacheWriteTokens,
        next.inputTokenDetails?.cacheWriteTokens,
      ) ?? 0,
  };
  const outputTokenDetails = {
    textTokens:
      addTokenCounts(
        current?.outputTokenDetails?.textTokens,
        next.outputTokenDetails?.textTokens,
      ) ?? 0,
    reasoningTokens:
      addTokenCounts(
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

// ---------------------------------------------------------------------------
// Tool activity helpers
// ---------------------------------------------------------------------------

const isActiveToolActivity = (activity: IAiToolActivityInline): boolean =>
  activity.state === 'starting' ||
  activity.state === 'running' ||
  activity.state === 'waiting-confirmation';

const findLatestActiveToolActivity = (
  activities: IAiToolActivityInline[],
): IAiToolActivityInline | null => [...activities].reverse().find(isActiveToolActivity) ?? null;

// 同一 (stepId, toolName) 上只保留最新一条 activity;否则按 id 去重。
const isSameToolActivity = (a: IAiToolActivityInline, b: IAiToolActivityInline): boolean =>
  a.id === b.id || (a.stepId === b.stepId && a.toolName === b.toolName);

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useAiAgentStore = defineStore(
  'ai-agent',
  () => {
    // ── State ───────────────────────────────────────────────────
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
    const latestOfficialUsage = ref<IAiLanguageModelUsage | null>(null);
    const totalOfficialUsageResolved = ref<boolean>(false);
    const totalOfficialUsage = ref<IAiLanguageModelUsage | null>(null);
    const stepDetails = ref<Record<string, IAiAgentStepDetail>>({});
    const stepFinalAnswers = ref<Record<string, IAiAgentStepFinalAnswer[]>>({});
    const patchSummaries = ref<Record<string, IAiAgentPatchSummary[]>>({});
    const toolActivities = ref<Record<string, IAiToolActivityInline[]>>({});
    const pendingToolConfirmation = ref<IAiToolConfirmationRequest | null>(null);
    const pendingSidecarAgentSession = ref<IAiPersistedSidecarAgentSession | null>(null);
    const errorMessage = ref<string>('');

    // ── Getters ────────────────────────────────────────────────
    const hasPlan = computed(() => steps.value.length > 0);

    const activeRun = computed(
      () => runs.value.find((run) => run.id === activeRunId.value) ?? null,
    );

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

    // ── Internal helpers ────────────────────────────────────────

    const getStepDetailKey = (runId: string, stepId: string): string => `${runId}:${stepId}`;

    const createStepDetail = (runId: string, stepId: string): IAiAgentStepDetail => ({
      runId,
      stepId,
      webSources: [],
      toolResults: [],
      updatedAt: new Date().toISOString(),
    });

    /**
     * 把所有 plan/run/usage 相关字段归零。
     * 三个入口 (beginPlanning / failPlanning / clearPlan) 都需要这套基础重置,
     * 各自再叠加自己的 errorMessage / mode / classification 等差异化逻辑。
     */
    const resetPlanScaffold = (): void => {
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
    };

    // ── Actions: classification & plan lifecycle ────────────────────────

    const setClassification = (payload: IAiAgentClassifyTaskPayload): void => {
      classification.value = payload.classification;
      shouldEnterPlanMode.value = payload.shouldEnterPlanMode;
      classificationReason.value = payload.reason;
    };

    const beginPlanning = (goal: string): void => {
      resetPlanScaffold();
      activeGoal.value = goal;
      classification.value = null;
      classificationReason.value = '';
      shouldEnterPlanMode.value = false;
      pendingToolConfirmation.value = null;
      pendingSidecarAgentSession.value = null;
      errorMessage.value = '';
    };

    const failPlanning = (goal: string, message: string): void => {
      resetPlanScaffold();
      activeGoal.value = goal;
      shouldEnterPlanMode.value = false;
      pendingToolConfirmation.value = null;
      pendingSidecarAgentSession.value = null;
      errorMessage.value = message;
      mode.value = 'plan';
    };

    const clearPlan = (): void => {
      resetPlanScaffold();
      activeGoal.value = '';
      classification.value = null;
      classificationReason.value = '';
      shouldEnterPlanMode.value = false;
      isClassifying.value = false;
      isPlanning.value = false;
      isApproving.value = false;
      errorMessage.value = '';
    };

    const setNetworkPermission = (permission: TAiAgentNetworkPermission): void => {
      networkPermission.value = permission;
    };

    const setMode = (nextMode: TAiAgentPanelMode): void => {
      mode.value = nextMode;
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
      planVersions.value = metadata ? [{ ...metadata }] : [];
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
      planExecutedAt.value =
        metadata.executedAt !== undefined ? metadata.executedAt : planExecutedAt.value;
      planRejectionReason.value =
        metadata.rejectionReason !== undefined
          ? metadata.rejectionReason
          : planRejectionReason.value;
      planErrorMessage.value =
        metadata.errorMessage !== undefined ? metadata.errorMessage : planErrorMessage.value;
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

    // ── Actions: runs ────────────────────────────────────────────

    const upsertRun = (run: IAiAgentRun): void => {
      activeRunId.value = run.id;
      runs.value = [run, ...runs.value.filter((item) => item.id !== run.id)];
      steps.value = run.steps;
    };

    const setRuns = (nextRuns: IAiAgentRun[]): void => {
      runs.value = nextRuns;
      if (activeRunId.value && !nextRuns.some((run) => run.id === activeRunId.value)) {
        activeRunId.value = null;
      }
    };

    const upsertRunStep = (runId: string, step: IAiTaskPlanStep): void => {
      const targetRun = runs.value.find((run) => run.id === runId);
      if (!targetRun) {
        steps.value = steps.value.map((item) => (item.id === step.id ? step : item));
        return;
      }
      // 优先级:
      //   step 正在运行 → currentStepId 指向它
      //   否则 step 是上一次的 currentStep → 清空
      //   否则保持不动
      const nextCurrentStepId =
        step.status === 'running'
          ? step.id
          : targetRun.currentStepId === step.id
            ? null
            : targetRun.currentStepId;
      upsertRun({
        ...targetRun,
        steps: targetRun.steps.map((item) => (item.id === step.id ? step : item)),
        currentStepId: nextCurrentStepId,
        updatedAt: new Date().toISOString(),
      });
    };

    // ── Actions: usage ──────────────────────────────────────────

    const setLatestOfficialUsage = (usage: IAiLanguageModelUsage | null): void => {
      latestOfficialUsageResolved.value = true;
      latestOfficialUsage.value = usage;
      if (usage) {
        totalOfficialUsageResolved.value = true;
        totalOfficialUsage.value = addOfficialUsage(totalOfficialUsage.value, usage);
      }
    };

    /**
     * 只清空 usage 统计;不再连带清空 pendingToolConfirmation /
     * pendingSidecarAgentSession (那是独立的待确认工具调用,与 token 计数无关)。
     * 如需同时清待确认工具,显式调用 clearPendingToolConfirmation()。
     */
    const clearLatestOfficialUsage = (): void => {
      latestOfficialUsageResolved.value = false;
      latestOfficialUsage.value = null;
      totalOfficialUsageResolved.value = false;
      totalOfficialUsage.value = null;
    };

    // ── Actions: step details / final answers / patches ──────────────────

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
        toolResults: [...previous.toolResults, ...toolResults],
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
        [answer.runId]: [...previous.filter((item) => item.id !== answer.id), answer].slice(-50),
      };
    };

    const appendPatchSummary = (summary: IAiAgentPatchSummary): void => {
      const previous = getPatchSummaries(summary.runId);
      patchSummaries.value = {
        ...patchSummaries.value,
        [summary.runId]: [...previous.filter((item) => item.id !== summary.id), summary],
      };
    };

    // ── Actions: tool activities & confirmations ────────────────────────

    const getToolActivities = (runId: string): IAiToolActivityInline[] =>
      toolActivities.value[runId] ?? [];

    const appendToolActivity = (runId: string, activity: IAiToolActivityInline): void => {
      const previous = getToolActivities(runId);
      toolActivities.value = {
        ...toolActivities.value,
        [runId]: [
          ...previous.filter((item) => !isSameToolActivity(item, activity)),
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
        pendingSidecarAgentSession.value = null;
      }
    };

    const setPendingSidecarAgentSession = (session: IAiPersistedSidecarAgentSession): void => {
      pendingSidecarAgentSession.value = session;
    };

    const clearPendingSidecarAgentSession = (): void => {
      pendingSidecarAgentSession.value = null;
    };

    return {
      // state
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
      pendingSidecarAgentSession,
      errorMessage,
      // getters
      hasPlan,
      activeRun,
      activeToolActivity,
      // queries
      getStepDetail,
      getPatchSummaries,
      getStepFinalAnswers,
      getToolActivities,
      // actions
      setNetworkPermission,
      setMode,
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
      setPendingSidecarAgentSession,
      clearPendingSidecarAgentSession,
    };
  },
  {
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
        'pendingToolConfirmation',
        'pendingSidecarAgentSession',
        'errorMessage',
      ],
      afterHydrate(ctx) {
        const store = ctx.store as unknown as TAiAgentPersistState;
        // store 上额外挂的 method / getter 在 .object() 默认 strip 行为下会被忽略,
        // 不必再手工 picking 31 个字段拼对象。
        const parsed = aiAgentPersistSchema.safeParse(store);
        if (!parsed.success) {
          return;
        }
        applyHydratedAgentState(store, normalizeHydratedAgentState(parsed.data));
      },
    },
  },
);
