import { unref } from 'vue';
import {
  mapSidecarEventsToToolCalls,
  mapSidecarToolNameToAiToolName,
  projectSidecarExecuteResponse,
  projectSidecarPlanRecordResponse,
  projectSidecarPlanResponse,
  projectSidecarPlanValidationResponse,
  resolveSidecarOfficialUsage,
} from '@/composables/ai/sidecar-events';
import { useSidecarChangedDocumentRefresh } from '@/composables/useSidecarChangedDocumentRefresh';
import { aiService } from '@/services/ipc/ai.service';
import { type TAiAgentPanelMode, useAiAgentStore } from '@/store/aiAgent';
import type {
  IAiAgentRun,
  IAiAgentStepFinalAnswer,
  IAiAgentStepToolResultSummary,
  IAiContextReference,
  IAiTaskPlanStep,
  IAiToolCall,
  TAiToolConfirmationDecision,
} from '@/types/ai';

import type { IAgentSidecarMessage, TAgentUiEvent } from '@/types/ai/sidecar';
import { toErrorMessage } from '@/utils/error';

const mapToolConfirmationDecisionToSidecarDecision = (
  decision: TAiToolConfirmationDecision,
): 'approve' | 'reject' | 'cancel' | 'modify' => {
  switch (decision) {
    case 'allow-once':
    case 'allow-run':
      return 'approve';
    case 'skip':
      return 'reject';
    case 'stop':
      return 'cancel';
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
};

interface ISidecarStepLoopOptions {
  goal: string;
  context?: IAiContextReference[];
  workspaceRootPath?: string | null;
}

interface ISidecarStepLoopSession {
  runId: string;
  stepId: string;
  planId: string;
  planVersion: number;
  goal: string;
  messages: IAgentSidecarMessage[];
  context: IAiContextReference[];
  workspaceRootPath?: string | null;
  threadId?: string;
  sessionId?: string;
  pendingRequestId?: string;
}

const SIDECAR_STEP_CONFIRMATION_PREFIX = 'sidecar-step-tool-confirmation:';
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

const createSidecarRunId = (): string => {
  return `sidecar-plan:${crypto.randomUUID()}`;
};

const createSidecarStepSessionId = (runId: string, stepId: string): string =>
  `sidecar-step:${runId}:${stepId}:${Date.now()}`;

const findRunningStep = (run: IAiAgentRun | null): IAiTaskPlanStep | null =>
  run?.steps.find((step) => step.status === 'running') ?? null;

const buildStepSidecarMessages = (
  run: IAiAgentRun,
  step: IAiTaskPlanStep,
  goal: string,
): IAgentSidecarMessage[] => {
  const toolList = step.tools.length ? step.tools.join(', ') : '未限定，按任务需要选择可用工具';

  return [
    {
      role: 'system',
      content: [
        '你正在执行 IDE Agent Plan 的单个步骤。',
        '必须围绕当前步骤目标调用可用工具；不要执行与当前步骤无关的操作。',
        '如果需要高风险工具，请通过 sidecar approval 事件等待用户确认。',
        '写盘、删除、命令、安装依赖和 Git 操作都必须保留可回滚语义。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `任务目标：${goal || run.goal}`,
        `当前步骤：${step.title}`,
        `步骤目标：${step.goal}`,
        `预期产物：${step.expectedOutput}`,
        `建议工具：${toolList}`,
        '请执行这个步骤，并在完成后给出简短结论。',
      ].join('\n'),
    },
  ];
};

const createSidecarStepConfirmationId = (
  session: ISidecarStepLoopSession,
  requestId: string,
): string => `${SIDECAR_STEP_CONFIRMATION_PREFIX}${session.runId}:${session.stepId}:${requestId}`;

const mapToolCallStatusToActivityState = (
  status: IAiToolCall['status'],
): 'running' | 'succeeded' | 'failed' | 'cancelled' => {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'denied':
      return 'cancelled';
    case 'pending':
    case 'running':
    default:
      return 'running';
  }
};

const toStepToolResultSummaries = (
  runId: string,
  stepId: string,
  toolCalls: readonly IAiToolCall[],
): IAiAgentStepToolResultSummary[] => {
  const endedAt = new Date().toISOString();

  return toolCalls
    .filter((toolCall) => toolCall.status === 'succeeded' || toolCall.status === 'failed')
    .map((toolCall) => ({
      id: toolCall.id,
      runId,
      stepId,
      toolName: mapSidecarToolNameToAiToolName(toolCall.name),
      status: toolCall.status === 'succeeded' ? 'succeeded' : 'failed',
      summary: toolCall.summary,
      startedAt: endedAt,
      endedAt,
    }));
};

const toStepFinalAnswer = (
  runId: string,
  stepId: string,
  content: string,
  createdAt: string,
  eventCount: number,
): IAiAgentStepFinalAnswer => ({
  id: `${runId}:${stepId}:final:${eventCount}:${createdAt}`,
  runId,
  stepId,
  content,
  createdAt,
});

const isTerminalRunStatus = (status: IAiAgentRun['status']): boolean =>
  TERMINAL_RUN_STATUSES.has(status);

const isAutoExecutionBoundaryStatus = (status: IAiAgentRun['status']): boolean =>
  isTerminalRunStatus(status) || status === 'paused' || status === 'waiting-for-tool-confirmation';

const clearStepActivityFlags = (steps: IAiTaskPlanStep[]): IAiTaskPlanStep[] =>
  steps.map((step) => ({
    ...step,
    isActive: false,
  }));

const cloneStepsForRun = (steps: IAiTaskPlanStep[]): IAiTaskPlanStep[] =>
  clearStepActivityFlags(steps).map((step) => ({
    ...step,
    status: step.status === 'done' ? 'done' : 'pending',
  }));

export const useAiAgentRun = () => {
  const store = useAiAgentStore();
  const { refreshSidecarChangedDocuments } = useSidecarChangedDocumentRefresh();
  const sidecarStepLoopSessions = new Map<string, ISidecarStepLoopSession>();

  const getRuns = (): IAiAgentRun[] => unref(store.runs);
  const getActiveRun = (): IAiAgentRun | null => unref(store.activeRun);
  const getPendingToolConfirmation = () => unref(store.pendingToolConfirmation);
  const setMode = (nextMode: TAiAgentPanelMode): void => {
    Reflect.set(store, 'mode', nextMode);
  };
  const setErrorMessage = (message: string): void => {
    Reflect.set(store, 'errorMessage', message);
  };

  const setPlanStatus = (
    status: Parameters<typeof store.setPlanStatus>[0],
    approvedAt = store.approvedAt,
  ): void => {
    store.setPlanStatus(status, approvedAt);
  };

  const applyRunPayload = (run: IAiAgentRun): IAiAgentRun => {
    store.upsertRun(run);
    setMode('agent');
    setErrorMessage('');
    return run;
  };

  const getRunOrThrow = (runId: string): IAiAgentRun => {
    const run = getRuns().find((item) => item.id === runId) ?? null;

    if (!run) {
      throw new Error('当前没有可执行的 Agent run。');
    }

    return run;
  };

  const updateRun = (runId: string, updater: (run: IAiAgentRun) => IAiAgentRun): IAiAgentRun =>
    applyRunPayload(updater(getRunOrThrow(runId)));

  const clearRunSessions = (runId: string): void => {
    for (const [confirmationId, session] of sidecarStepLoopSessions.entries()) {
      if (session.runId === runId) {
        sidecarStepLoopSessions.delete(confirmationId);
      }
    }
  };

  const finishSidecarPlanIfTerminal = async (
    run: IAiAgentRun,
    fallbackErrorMessage: string | null = null,
  ): Promise<void> => {
    if (!isTerminalRunStatus(run.status) || !store.planId || !store.planVersion) {
      return;
    }

    const status = run.status === 'completed' ? 'completed' : 'failed';

    try {
      const payload = await aiService.sidecarPlanFinish({
        planId: store.planId,
        version: store.planVersion,
        status,
        ...(status === 'failed'
          ? { errorMessage: run.errorMessage ?? fallbackErrorMessage ?? 'Agent run 未完成。' }
          : {}),
      });
      const projection = projectSidecarPlanRecordResponse(payload);

      if (projection.metadata) {
        store.applyPlanMetadata(projection.metadata, projection.versions);
        return;
      }

      setPlanStatus(status, store.approvedAt);
    } catch (error) {
      setErrorMessage(toErrorMessage(error, '收口 Agent 计划状态失败。'));
    }
  };

  const buildPlanLifecycleMessages = (goal: string): IAgentSidecarMessage[] => [
    {
      role: 'user',
      content: goal,
    },
  ];

  const applyReplannedPlanPayload = (
    payload: Awaited<ReturnType<typeof aiService.sidecarPlanReplan>>,
    fallbackGoal: string,
  ): void => {
    const projection = projectSidecarPlanResponse(payload, fallbackGoal);

    if (projection.errorMessage) {
      throw new Error(projection.errorMessage);
    }

    if (!projection.planMetadata) {
      throw new Error('sidecar 未返回重规划后的计划元数据。');
    }

    store.setPlan(projection.goal, projection.steps, projection.planMetadata);
    store.mode = 'plan';
  };

  const validateCompletedSidecarPlan = async (
    run: IAiAgentRun,
    session: ISidecarStepLoopSession,
  ): Promise<void> => {
    if (run.status !== 'completed') {
      await finishSidecarPlanIfTerminal(run);
      return;
    }

    try {
      const messages = buildPlanLifecycleMessages(session.goal || run.goal);
      const validationPayload = await aiService.sidecarPlanValidate({
        sessionId: `sidecar-validate:${run.id}:${Date.now()}`,
        goal: session.goal || run.goal,
        messages,
        context: session.context,
        workspaceRootPath: session.workspaceRootPath ?? null,
        planId: session.planId,
        planVersion: session.planVersion,
        ...(session.threadId ? { threadId: session.threadId } : {}),
      });
      const validationUsageResolution = resolveSidecarOfficialUsage(validationPayload);

      if (validationUsageResolution.resolved && validationUsageResolution.usage) {
        store.setLatestOfficialUsage(validationUsageResolution.usage);
      }

      const validation = projectSidecarPlanValidationResponse(validationPayload);

      if (validation.errorMessage) {
        throw new Error(validation.errorMessage);
      }

      if (validation.report?.needsReplan) {
        const replanPayload = await aiService.sidecarPlanReplan({
          sessionId: `sidecar-replan:${run.id}:${Date.now()}`,
          goal: session.goal || run.goal,
          messages,
          context: session.context,
          workspaceRootPath: session.workspaceRootPath ?? null,
          planId: session.planId,
          planVersion: session.planVersion,
          ...(session.threadId ? { threadId: session.threadId } : {}),
        });

        const replanUsageResolution = resolveSidecarOfficialUsage(replanPayload);

        if (replanUsageResolution.resolved && replanUsageResolution.usage) {
          store.setLatestOfficialUsage(replanUsageResolution.usage);
        }

        applyReplannedPlanPayload(replanPayload, session.goal || run.goal);
        return;
      }

      await finishSidecarPlanIfTerminal(run);
    } catch (error) {
      const message = toErrorMessage(error, '验证 Agent 计划执行结果失败。');
      setErrorMessage(message);
      await finishSidecarPlanIfTerminal(
        {
          ...run,
          status: 'failed',
          errorMessage: message,
        },
        message,
      );
    }
  };

  const appendSidecarToolState = (
    runId: string,
    stepId: string,
    toolCalls: readonly IAiToolCall[],
  ): void => {
    store.appendStepToolResults(runId, stepId, toStepToolResultSummaries(runId, stepId, toolCalls));

    for (const toolCall of toolCalls) {
      store.appendToolActivity(runId, {
        id: `${toolCall.id}:activity`,
        stepId,
        toolName: mapSidecarToolNameToAiToolName(toolCall.name),
        state: mapToolCallStatusToActivityState(toolCall.status),
        label: toolCall.summary,
        targetPreview: toolCall.targetPreview,
        startedAt: new Date().toISOString(),
      });
    }
  };

  const appendSidecarLiveToolActivities = (
    runId: string,
    stepId: string,
    events: readonly TAgentUiEvent[],
  ): void => {
    for (const toolCall of mapSidecarEventsToToolCalls(events)) {
      store.appendToolActivity(runId, {
        id: `${toolCall.id}:activity`,
        stepId,
        toolName: mapSidecarToolNameToAiToolName(toolCall.name),
        state: mapToolCallStatusToActivityState(toolCall.status),
        label: toolCall.summary,
        targetPreview: toolCall.targetPreview,
        startedAt: new Date().toISOString(),
      });
    }
  };

  const refreshChangedDocumentsAfterSidecarRun = async (
    projection: ReturnType<typeof projectSidecarExecuteResponse>,
    workspaceRootPath: string | null | undefined,
  ): Promise<void> => {
    const refreshResult = await refreshSidecarChangedDocuments({
      changedFilePaths: projection.changedFilePaths,
      hasFileMutations: projection.hasFileMutations,
      workspaceRootPath: workspaceRootPath ?? null,
    });

    if (refreshResult.skippedDirtyNames.length > 0) {
      setErrorMessage(
        `Agent 已修改文件，但 ${refreshResult.skippedDirtyNames.join('、')} 有未保存改动，已跳过自动刷新。`,
      );
      return;
    }

    if (refreshResult.failedNames.length > 0) {
      setErrorMessage(
        `Agent 已修改文件，但刷新 ${refreshResult.failedNames.join('、')} 失败，请手动重新打开。`,
      );
    }
  };

  const runPlan = async (
    goal: string,
    steps: IAiTaskPlanStep[],
    _context: IAiContextReference[] = [],
  ): Promise<IAiAgentRun> => {
    void _context;
    try {
      const now = new Date().toISOString();
      const run: IAiAgentRun = {
        id: createSidecarRunId(),
        goal,
        status: 'running-plan',
        steps: cloneStepsForRun(steps),
        currentStepId: null,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        completedAt: null,
        errorMessage: null,
      };
      clearRunSessions(run.id);
      store.clearPendingToolConfirmation();
      setPlanStatus('executing', store.approvedAt);
      return applyRunPayload(run);
    } catch (error) {
      setErrorMessage(toErrorMessage(error, '启动 Agent run 失败。'));
      throw error;
    }
  };

  const findNextStep = (run: IAiAgentRun, stepId?: string): IAiTaskPlanStep | null => {
    if (stepId) {
      return run.steps.find((step) => step.id === stepId) ?? null;
    }

    return findRunningStep(run) ?? run.steps.find((step) => step.status === 'pending') ?? null;
  };

  const markStepRunning = (runId: string, stepId?: string): IAiAgentRun =>
    updateRun(runId, (run) => {
      const targetStep = findNextStep(run, stepId);

      if (!targetStep) {
        throw new Error('当前没有可执行的 Agent step。');
      }

      const now = new Date().toISOString();
      return {
        ...run,
        status: 'running-step',
        currentStepId: targetStep.id,
        updatedAt: now,
        errorMessage: null,
        steps: run.steps.map((step) => ({
          ...step,
          status: step.id === targetStep.id ? 'running' : step.status,
          isActive: step.id === targetStep.id,
        })),
      };
    });

  const finishRunWithStepStatus = (
    runId: string,
    stepId: string,
    stepStatus: IAiTaskPlanStep['status'],
    runStatus?: IAiAgentRun['status'],
    errorMessage: string | null = null,
  ): IAiAgentRun =>
    updateRun(runId, (run) => {
      const now = new Date().toISOString();
      const nextSteps = clearStepActivityFlags(run.steps).map((step) =>
        step.id === stepId
          ? {
              ...step,
              status: stepStatus,
            }
          : step,
      );
      const hasRemainingPendingSteps = nextSteps.some((step) => step.status === 'pending');
      const nextRunStatus = runStatus ?? (!hasRemainingPendingSteps ? 'completed' : 'running-plan');

      return {
        ...run,
        status: nextRunStatus,
        currentStepId: null,
        updatedAt: now,
        completedAt: isTerminalRunStatus(nextRunStatus) ? now : null,
        errorMessage,
        steps: nextSteps,
      };
    });

  const setRunWaitingForConfirmation = (runId: string): IAiAgentRun =>
    updateRun(runId, (run) => ({
      ...run,
      status: 'waiting-for-tool-confirmation',
      updatedAt: new Date().toISOString(),
      errorMessage: null,
    }));

  const executeSidecarStepLoop = async (session: ISidecarStepLoopSession): Promise<IAiAgentRun> => {
    const sidecarSessionId =
      session.sessionId ?? createSidecarStepSessionId(session.runId, session.stepId);
    const liveEvents: TAgentUiEvent[] = [];
    const unlistenSidecarStream = await aiService.onSidecarStream((payload) => {
      if (payload.sessionId !== sidecarSessionId) {
        return;
      }

      liveEvents.push(payload.event);
      appendSidecarLiveToolActivities(session.runId, session.stepId, liveEvents);
    });

    let payload: Awaited<ReturnType<typeof aiService.sidecarExecute>>;

    try {
      payload = await aiService.sidecarExecute({
        sessionId: sidecarSessionId,
        goal: session.goal,
        messages: session.messages,
        context: session.context,
        workspaceRootPath: session.workspaceRootPath ?? null,
        planId: session.planId,
        planVersion: session.planVersion,
        planStepId: session.stepId,
        ...(session.threadId ? { threadId: session.threadId } : {}),
      });
    } finally {
      unlistenSidecarStream();
    }

    const executeUsageResolution = resolveSidecarOfficialUsage(payload);

    if (executeUsageResolution.resolved && executeUsageResolution.usage) {
      store.setLatestOfficialUsage(executeUsageResolution.usage);
    }

    const projection = projectSidecarExecuteResponse(payload);
    appendSidecarToolState(session.runId, session.stepId, projection.toolCalls);
    await refreshChangedDocumentsAfterSidecarRun(projection, session.workspaceRootPath);

    if (projection.pendingConfirmation) {
      const confirmationId = createSidecarStepConfirmationId(
        session,
        projection.pendingConfirmation.id,
      );

      sidecarStepLoopSessions.set(confirmationId, {
        ...session,
        sessionId: payload.sessionId,
        pendingRequestId: projection.pendingConfirmation.id,
      });
      store.setPendingToolConfirmation({
        ...projection.pendingConfirmation,
        id: confirmationId,
        runId: session.runId,
        stepId: session.stepId,
      });
      return setRunWaitingForConfirmation(session.runId);
    }

    if (projection.errorMessage) {
      setErrorMessage(projection.errorMessage);
      const failedRun = finishRunWithStepStatus(
        session.runId,
        session.stepId,
        'failed',
        'failed',
        projection.errorMessage,
      );
      await finishSidecarPlanIfTerminal(failedRun, projection.errorMessage);
      return failedRun;
    }

    const finalContent = projection.assistantContent.trim();
    if (finalContent) {
      const createdAt = new Date().toISOString();
      store.appendStepFinalAnswer(
        toStepFinalAnswer(
          session.runId,
          session.stepId,
          finalContent,
          createdAt,
          projection.toolCalls.length,
        ),
      );
    }

    const nextRun = finishRunWithStepStatus(session.runId, session.stepId, 'done');
    await validateCompletedSidecarPlan(nextRun, session);
    return nextRun;
  };

  const runStep = async (runId: string, stepId?: string): Promise<IAiAgentRun> => {
    try {
      return markStepRunning(runId, stepId);
    } catch (error) {
      setErrorMessage(toErrorMessage(error, '执行 Agent step 失败。'));
      throw error;
    }
  };

  const runStepWithSidecar = async (
    runId: string,
    options: ISidecarStepLoopOptions,
  ): Promise<IAiAgentRun> => {
    try {
      let run = getActiveRun()?.id === runId ? getActiveRun() : null;
      let step = findRunningStep(run);

      if (!step) {
        run = await runStep(runId);
        step = findRunningStep(run);
      }

      if (!run || !step) {
        throw new Error('当前没有可执行的 Agent step。');
      }

      const planId = store.planId;
      const planVersion = store.planVersion;

      if (!planId || !planVersion) {
        throw new Error('当前 Agent run 缺少已批准计划的 planId 或 version。');
      }

      setPlanStatus('executing', store.approvedAt);

      const session: ISidecarStepLoopSession = {
        runId,
        stepId: step.id,
        planId,
        planVersion,
        goal: options.goal || run.goal,
        messages: buildStepSidecarMessages(run, step, options.goal),
        context: options.context ?? [],
        workspaceRootPath: options.workspaceRootPath ?? null,
        ...(store.planThreadId ? { threadId: store.planThreadId } : {}),
      };

      return await executeSidecarStepLoop(session);
    } catch (error) {
      setErrorMessage(toErrorMessage(error, '执行 Agent step 失败。'));
      throw error;
    }
  };

  const continueRunToCompletion = async (
    runId: string,
    options: ISidecarStepLoopOptions,
  ): Promise<IAiAgentRun> => {
    let run = getRunOrThrow(runId);

    while (!isAutoExecutionBoundaryStatus(run.status)) {
      run = await runStepWithSidecar(run.id, options);
    }

    return run;
  };

  const runPlanToCompletion = async (
    goal: string,
    steps: IAiTaskPlanStep[],
    options: Omit<ISidecarStepLoopOptions, 'goal'> = {},
  ): Promise<IAiAgentRun> => {
    const run = await runPlan(goal, steps, options.context ?? []);

    return continueRunToCompletion(run.id, {
      goal,
      context: options.context ?? [],
      workspaceRootPath: options.workspaceRootPath ?? null,
    });
  };

  const hasSidecarStepToolConfirmation = (confirmationId: string): boolean =>
    sidecarStepLoopSessions.has(confirmationId);

  const resolveSidecarStepToolConfirmation = async (
    confirmationId: string,
    decision: TAiToolConfirmationDecision,
  ): Promise<IAiAgentRun> => {
    const session = sidecarStepLoopSessions.get(confirmationId);

    if (!session) {
      throw new Error('当前没有可继续的 Sidecar step 工具确认。');
    }

    sidecarStepLoopSessions.delete(confirmationId);
    store.clearPendingToolConfirmation(confirmationId);

    const sidecarSessionId =
      session.sessionId ?? createSidecarStepSessionId(session.runId, session.stepId);
    const liveEvents: TAgentUiEvent[] = [];
    const unlistenSidecarStream = await aiService.onSidecarStream((payload) => {
      if (payload.sessionId !== sidecarSessionId) {
        return;
      }

      liveEvents.push(payload.event);
      appendSidecarLiveToolActivities(session.runId, session.stepId, liveEvents);
    });

    let payload: Awaited<ReturnType<typeof aiService.sidecarResolveApproval>>;

    try {
      payload = await aiService.sidecarResolveApproval({
        sessionId: sidecarSessionId,
        requestId: session.pendingRequestId ?? confirmationId,
        decision: mapToolConfirmationDecisionToSidecarDecision(decision),
        goal: session.goal,
        messages: session.messages,
        context: session.context,
        workspaceRootPath: session.workspaceRootPath ?? null,
        planId: session.planId,
        planVersion: session.planVersion,
        planStepId: session.stepId,
        ...(session.threadId ? { threadId: session.threadId } : {}),
      });
    } finally {
      unlistenSidecarStream();
    }

    const approvalUsageResolution = resolveSidecarOfficialUsage(payload);

    if (approvalUsageResolution.resolved && approvalUsageResolution.usage) {
      store.setLatestOfficialUsage(approvalUsageResolution.usage);
    }

    const projection = projectSidecarExecuteResponse(payload);
    appendSidecarToolState(session.runId, session.stepId, projection.toolCalls);
    await refreshChangedDocumentsAfterSidecarRun(projection, session.workspaceRootPath);

    if (projection.pendingConfirmation) {
      const nextConfirmationId = createSidecarStepConfirmationId(
        session,
        projection.pendingConfirmation.id,
      );

      sidecarStepLoopSessions.set(nextConfirmationId, {
        ...session,
        sessionId: payload.sessionId,
        pendingRequestId: projection.pendingConfirmation.id,
      });
      store.setPendingToolConfirmation({
        ...projection.pendingConfirmation,
        id: nextConfirmationId,
        runId: session.runId,
        stepId: session.stepId,
      });
      return setRunWaitingForConfirmation(session.runId);
    }

    const finalContent = projection.assistantContent.trim();
    if (finalContent) {
      const createdAt = new Date().toISOString();
      store.appendStepFinalAnswer(
        toStepFinalAnswer(
          session.runId,
          session.stepId,
          finalContent,
          createdAt,
          projection.toolCalls.length,
        ),
      );
    }

    if (projection.errorMessage) {
      setErrorMessage(projection.errorMessage);
      const failedRun = finishRunWithStepStatus(
        session.runId,
        session.stepId,
        decision === 'stop' ? 'cancelled' : 'failed',
        decision === 'stop' ? 'cancelled' : 'failed',
        projection.errorMessage,
      );
      await finishSidecarPlanIfTerminal(failedRun, projection.errorMessage);
      return failedRun;
    }

    if (decision === 'stop') {
      const cancelledRun = finishRunWithStepStatus(
        session.runId,
        session.stepId,
        'cancelled',
        'cancelled',
      );
      await finishSidecarPlanIfTerminal(cancelledRun, '用户停止了工具审批。');
      return cancelledRun;
    }

    const nextRun = finishRunWithStepStatus(session.runId, session.stepId, 'done');
    await validateCompletedSidecarPlan(nextRun, session);
    return nextRun;
  };

  const pauseRun = async (runId: string): Promise<IAiAgentRun> => {
    try {
      return updateRun(runId, (run) => {
        if (isTerminalRunStatus(run.status)) {
          return run;
        }

        return {
          ...run,
          status: 'paused',
          updatedAt: new Date().toISOString(),
        };
      });
    } catch (error) {
      setErrorMessage(toErrorMessage(error, '暂停 Agent run 失败。'));
      throw error;
    }
  };

  const resumeRun = async (runId: string): Promise<IAiAgentRun> => {
    try {
      return updateRun(runId, (run) => ({
        ...run,
        status: run.status === 'paused' ? 'running-plan' : run.status,
        updatedAt: new Date().toISOString(),
      }));
    } catch (error) {
      setErrorMessage(toErrorMessage(error, '继续 Agent run 失败。'));
      throw error;
    }
  };

  const cancelRun = async (runId: string): Promise<IAiAgentRun> => {
    const confirmation = getPendingToolConfirmation();
    if (confirmation?.runId === runId && hasSidecarStepToolConfirmation(confirmation.id)) {
      return resolveSidecarStepToolConfirmation(confirmation.id, 'stop');
    }

    try {
      clearRunSessions(runId);
      store.clearPendingToolConfirmation();
      const cancelledRun = updateRun(runId, (run) => {
        const now = new Date().toISOString();
        const nextSteps: IAiTaskPlanStep[] = clearStepActivityFlags(run.steps).map(
          (step): IAiTaskPlanStep =>
            step.id === run.currentStepId && step.status !== 'done'
              ? {
                  ...step,
                  status: 'cancelled',
                }
              : step,
        );

        return {
          ...run,
          status: 'cancelled',
          currentStepId: null,
          updatedAt: now,
          completedAt: now,
          errorMessage: null,
          steps: nextSteps,
        };
      });
      await finishSidecarPlanIfTerminal(cancelledRun, '用户取消了 Agent run。');
      return cancelledRun;
    } catch (error) {
      setErrorMessage(toErrorMessage(error, '取消 Agent run 失败。'));
      throw error;
    }
  };

  const resolveToolConfirmation = async (
    _runId: string,
    confirmationId: string,
    decision: TAiToolConfirmationDecision,
  ): Promise<IAiAgentRun> => {
    if (hasSidecarStepToolConfirmation(confirmationId)) {
      return resolveSidecarStepToolConfirmation(confirmationId, decision);
    }

    throw new Error('Legacy Agent 工具确认链已移除，请使用官方 sidecar 审批链。');
  };

  const refreshRun = async (runId: string): Promise<IAiAgentRun> => getRunOrThrow(runId);

  const loadRuns = async (): Promise<IAiAgentRun[]> => getRuns();

  return {
    store,
    runPlan,
    runPlanToCompletion,
    runStep,
    runStepWithSidecar,
    continueRunToCompletion,
    pauseRun,
    resumeRun,
    cancelRun,
    resolveToolConfirmation,
    hasSidecarStepToolConfirmation,
    resolveSidecarStepToolConfirmation,
    refreshRun,
    loadRuns,
  };
};
