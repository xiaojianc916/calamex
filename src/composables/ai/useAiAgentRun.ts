import { unref } from 'vue';
import {
  mapSidecarEventsToToolCalls,
  mapSidecarToolNameToAiToolName,
} from '@/composables/ai/sidecar-events';
import {
  type IOrchestrateProjection,
  resumeOrchestration,
} from '@/composables/ai/sidecar-orchestrate';
import { useSidecarChangedDocumentRefresh } from '@/composables/useSidecarChangedDocumentRefresh';
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
import type { TAgentSidecarOrchestrateDecision, TAgentUiEvent } from '@/types/ai/sidecar';
import { toErrorMessage } from '@/utils/error';

interface ISidecarStepLoopOptions {
  goal?: string;
  context?: IAiContextReference[];
  workspaceRootPath?: string | null;
}

const TERMINAL_RUN_STATUSES = new Set<IAiAgentRun['status']>(['completed', 'failed', 'cancelled']);

const isTerminalRunStatus = (status: IAiAgentRun['status']): boolean =>
  TERMINAL_RUN_STATUSES.has(status);

const createSidecarRunId = (): string => `sidecar-plan:${crypto.randomUUID()}`;

const mapToolConfirmationDecisionToOrchestrateDecision = (
  decision: TAiToolConfirmationDecision,
): TAgentSidecarOrchestrateDecision => {
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
    default:
      return 'running';
  }
};

const clearStepActivityFlags = (steps: IAiTaskPlanStep[]): IAiTaskPlanStep[] =>
  steps.map((step) => ({ ...step, isActive: false }));

const cloneStepsForRun = (steps: IAiTaskPlanStep[]): IAiTaskPlanStep[] =>
  clearStepActivityFlags(steps).map((step) => ({
    ...step,
    status: step.status === 'done' ? 'done' : 'pending',
  }));

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

type TSegmentOutcome = {
  kind: 'gate' | 'awaiting' | 'done' | 'error';
  run: IAiAgentRun;
};

export const useAiAgentRun = () => {
  const store = useAiAgentStore();
  const { refreshSidecarChangedDocuments } = useSidecarChangedDocumentRefresh();

  // confirmationId -> 恢复该 run 所需的上下文。
  const toolConfirmations = new Map<
    string,
    { runId: string; orchestrationRunId: string; options: ISidecarStepLoopOptions }
  >();
  // 协作式暂停 / 已放行计划门标记。
  const pausedRuns = new Set<string>();
  const startedRuns = new Set<string>();

  const getRuns = (): IAiAgentRun[] => unref(store.runs);
  const getActiveRun = (): IAiAgentRun | null => unref(store.activeRun);
  const getPendingToolConfirmation = () => unref(store.pendingToolConfirmation);

  const setMode = (nextMode: TAiAgentPanelMode): void => {
    store.setMode(nextMode);
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

  const clearRunArtifacts = (runId: string): void => {
    for (const [confirmationId, entry] of toolConfirmations.entries()) {
      if (entry.runId === runId) {
        toolConfirmations.delete(confirmationId);
      }
    }
    pausedRuns.delete(runId);
    startedRuns.delete(runId);
  };

  const createLocalRun = (goal: string, steps: IAiTaskPlanStep[]): IAiAgentRun => {
    const now = new Date().toISOString();
    const cloned = cloneStepsForRun(steps);
    const withFirst = cloned.map((step, index) =>
      index === 0 ? { ...step, status: 'running' as const, isActive: true } : step,
    );
    return {
      id: createSidecarRunId(),
      goal,
      status: 'running-step',
      steps: withFirst,
      currentStepId: cloned[0]?.id ?? null,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: null,
      errorMessage: null,
    };
  };

  // 一个 step_gate 放行后:当前步标 done,下一个 pending 步标 running。
  const advanceStepCursor = (runId: string): IAiAgentRun =>
    updateRun(runId, (run) => {
      const now = new Date().toISOString();
      const currentIdx = run.steps.findIndex((step) => step.id === run.currentStepId);
      const afterDone = run.steps.map((step, index) =>
        index === currentIdx
          ? { ...step, status: 'done' as const, isActive: false }
          : { ...step, isActive: false },
      );
      const nextIdx = afterDone.findIndex((step) => step.status === 'pending');
      const nextSteps =
        nextIdx >= 0
          ? afterDone.map((step, index) =>
              index === nextIdx ? { ...step, status: 'running' as const, isActive: true } : step,
            )
          : afterDone;
      return {
        ...run,
        steps: nextSteps,
        currentStepId: nextIdx >= 0 ? (nextSteps[nextIdx]?.id ?? null) : null,
        status: 'running-step',
        updatedAt: now,
      };
    });

  const setRunWaiting = (runId: string): IAiAgentRun =>
    updateRun(runId, (run) => ({
      ...run,
      status: 'waiting-for-tool-confirmation',
      updatedAt: new Date().toISOString(),
    }));

  const completeRun = (runId: string, projection: IOrchestrateProjection): IAiAgentRun => {
    const run = updateRun(runId, (current) => {
      const now = new Date().toISOString();
      return {
        ...current,
        status: 'completed',
        currentStepId: null,
        completedAt: now,
        updatedAt: now,
        errorMessage: null,
        steps: clearStepActivityFlags(current.steps).map((step) =>
          step.status === 'cancelled' ? step : { ...step, status: 'done' as const },
        ),
      };
    });
    if (projection.finalAnswer && run.steps.length > 0) {
      const last = run.steps[run.steps.length - 1];
      if (last) {
        store.appendStepFinalAnswer(
          toStepFinalAnswer(
            runId,
            last.id,
            projection.finalAnswer,
            new Date().toISOString(),
            run.steps.length,
          ),
        );
      }
    }
    clearRunArtifacts(runId);
    return run;
  };

  const failRun = (runId: string, message: string): IAiAgentRun => {
    const run = updateRun(runId, (current) => {
      const now = new Date().toISOString();
      return {
        ...current,
        status: 'failed',
        currentStepId: null,
        completedAt: now,
        updatedAt: now,
        errorMessage: message,
        steps: clearStepActivityFlags(current.steps).map((step) =>
          step.id === current.currentStepId && step.status !== 'done'
            ? { ...step, status: 'failed' as const }
            : step,
        ),
      };
    });
    setErrorMessage(message);
    clearRunArtifacts(runId);
    return run;
  };

  const cancelRunLocal = (runId: string): IAiAgentRun => {
    clearRunArtifacts(runId);
    store.clearPendingToolConfirmation();
    return updateRun(runId, (run) => {
      const now = new Date().toISOString();
      const nextSteps = clearStepActivityFlags(run.steps).map((step) =>
        step.id === run.currentStepId && step.status !== 'done'
          ? { ...step, status: 'cancelled' as const }
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
  };

  const appendLiveActivities = (runId: string, events: readonly TAgentUiEvent[]): void => {
    const stepId = getActiveRun()?.currentStepId;
    if (!stepId) {
      return;
    }
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

  const refreshChangedDocs = async (
    projection: IOrchestrateProjection,
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

  // 单段:resume 一次,跑到下一个挂起点 / 终态,并把结果落到 store。
  const runOrchestrationSegment = async (
    runId: string,
    orchestrationRunId: string,
    decision: TAgentSidecarOrchestrateDecision,
    advanceOnGate: boolean,
    options: ISidecarStepLoopOptions,
  ): Promise<TSegmentOutcome> => {
    const { projection } = await resumeOrchestration({
      runId: orchestrationRunId,
      decision,
      onLiveEvents: (events) => appendLiveActivities(runId, events),
    });

    if (projection.usage) {
      store.setLatestOfficialUsage(projection.usage);
    }
    const stepId = getActiveRun()?.currentStepId ?? null;
    if (stepId) {
      store.appendStepToolResults(
        runId,
        stepId,
        toStepToolResultSummaries(runId, stepId, projection.toolCalls),
      );
    }
    await refreshChangedDocs(projection, options.workspaceRootPath);

    if (projection.errorMessage) {
      return { kind: 'error', run: failRun(runId, projection.errorMessage) };
    }
    if (projection.isDone) {
      return { kind: 'done', run: completeRun(runId, projection) };
    }
    if (projection.pendingConfirmation) {
      const confirmationId = projection.pendingConfirmation.id;
      toolConfirmations.set(confirmationId, { runId, orchestrationRunId, options });
      store.setPendingToolConfirmation({
        ...projection.pendingConfirmation,
        runId,
        ...(stepId ? { stepId } : {}),
      });
      return { kind: 'awaiting', run: setRunWaiting(runId) };
    }
    // step_gate:仅在「本段确实执行了一个 step」时推进游标。
    const run = advanceOnGate ? advanceStepCursor(runId) : getRunOrThrow(runId);
    return { kind: 'gate', run };
  };

  // 自动跑到底:每个 step_gate 自动 continue,直到终态 / 工具审批 / 暂停。
  const driveToCompletion = async (
    runId: string,
    orchestrationRunId: string,
    firstDecision: TAgentSidecarOrchestrateDecision,
    firstAdvance: boolean,
    options: ISidecarStepLoopOptions,
  ): Promise<IAiAgentRun> => {
    let decision = firstDecision;
    let advance = firstAdvance;
    for (;;) {
      const outcome = await runOrchestrationSegment(
        runId,
        orchestrationRunId,
        decision,
        advance,
        options,
      );
      if (outcome.kind !== 'gate') {
        return outcome.run;
      }
      if (pausedRuns.has(runId)) {
        return outcome.run;
      }
      decision = 'continue';
      advance = true;
    }
  };

  const runPlan = async (
    goal: string,
    steps: IAiTaskPlanStep[],
    _context: IAiContextReference[] = [],
  ): Promise<IAiAgentRun> => {
    void _context;
    try {
      const run = createLocalRun(goal, steps);
      clearRunArtifacts(run.id);
      store.clearPendingToolConfirmation();
      setPlanStatus('executing', store.approvedAt);
      return applyRunPayload(run);
    } catch (error) {
      setErrorMessage(toErrorMessage(error, '启动 Agent run 失败。'));
      throw error;
    }
  };

  const runPlanToCompletion = async (
    goal: string,
    steps: IAiTaskPlanStep[],
    options: Omit<ISidecarStepLoopOptions, 'goal'> = {},
  ): Promise<IAiAgentRun> => {
    const orchestrationRunId = store.orchestrationRunId;
    if (!orchestrationRunId) {
      throw new Error('当前没有可执行的编排 run，请先生成并批准计划。');
    }
    const run = await runPlan(goal, steps, options.context ?? []);
    startedRuns.add(run.id);
    // 第一段 = resume('approve'):清掉计划审批门,不执行 step(故 advance=false)。
    return driveToCompletion(run.id, orchestrationRunId, 'approve', false, {
      ...(options.context ? { context: options.context } : {}),
      workspaceRootPath: options.workspaceRootPath ?? null,
    });
  };

  const continueRunToCompletion = async (
    runId: string,
    options: ISidecarStepLoopOptions,
  ): Promise<IAiAgentRun> => {
    const orchestrationRunId = store.orchestrationRunId;
    if (!orchestrationRunId) {
      throw new Error('当前没有可继续的编排 run。');
    }
    pausedRuns.delete(runId);
    return driveToCompletion(runId, orchestrationRunId, 'continue', true, {
      ...(options.context ? { context: options.context } : {}),
      workspaceRootPath: options.workspaceRootPath ?? null,
    });
  };

  const runStep = async (runId: string, stepId?: string): Promise<IAiAgentRun> => {
    try {
      return updateRun(runId, (run) => {
        const target = stepId
          ? run.steps.find((step) => step.id === stepId)
          : run.steps.find((step) => step.status === 'pending');
        if (!target) {
          throw new Error('当前没有可执行的 Agent step。');
        }
        const now = new Date().toISOString();
        return {
          ...run,
          status: 'running-step',
          currentStepId: target.id,
          updatedAt: now,
          errorMessage: null,
          steps: run.steps.map((step) => ({
            ...step,
            status: step.id === target.id ? 'running' : step.status,
            isActive: step.id === target.id,
          })),
        };
      });
    } catch (error) {
      setErrorMessage(toErrorMessage(error, '执行 Agent step 失败。'));
      throw error;
    }
  };

  // 单步(手动 mode):resume 一次执行一个 step,然后停。
  const runStepWithSidecar = async (
    runId: string,
    options: ISidecarStepLoopOptions,
  ): Promise<IAiAgentRun> => {
    try {
      const orchestrationRunId = store.orchestrationRunId;
      if (!orchestrationRunId) {
        throw new Error('当前没有可执行的编排 run。');
      }
      const alreadyStarted = startedRuns.has(runId);
      const firstDecision: TAgentSidecarOrchestrateDecision = alreadyStarted
        ? 'continue'
        : 'approve';
      startedRuns.add(runId);
      setPlanStatus('executing', store.approvedAt);
      const outcome = await runOrchestrationSegment(
        runId,
        orchestrationRunId,
        firstDecision,
        alreadyStarted,
        {
          ...(options.context ? { context: options.context } : {}),
          workspaceRootPath: options.workspaceRootPath ?? null,
        },
      );
      return outcome.run;
    } catch (error) {
      setErrorMessage(toErrorMessage(error, '执行 Agent step 失败。'));
      throw error;
    }
  };

  const hasSidecarStepToolConfirmation = (confirmationId: string): boolean =>
    toolConfirmations.has(confirmationId);

  const resolveSidecarStepToolConfirmation = async (
    confirmationId: string,
    decision: TAiToolConfirmationDecision,
  ): Promise<IAiAgentRun> => {
    const entry = toolConfirmations.get(confirmationId);
    if (!entry) {
      throw new Error('当前没有可继续的工具确认。');
    }
    toolConfirmations.delete(confirmationId);
    store.clearPendingToolConfirmation(confirmationId);

    const orchestrateDecision = mapToolConfirmationDecisionToOrchestrateDecision(decision);
    // 拒绝并中止(stop):resume('cancel') 拆掉 workflow,本地标记取消。
    if (orchestrateDecision === 'cancel') {
      try {
        await resumeOrchestration({ runId: entry.orchestrationRunId, decision: 'cancel' });
      } catch (error) {
        setErrorMessage(toErrorMessage(error, '取消 Agent run 失败。'));
      }
      return cancelRunLocal(entry.runId);
    }
    // 允许(approve)/ 跳过(reject):续跑被工具审批挂起的那一步,然后自动跑到底。
    return driveToCompletion(
      entry.runId,
      entry.orchestrationRunId,
      orchestrateDecision,
      true,
      entry.options,
    );
  };

  const resolveToolConfirmation = async (
    _runId: string,
    confirmationId: string,
    decision: TAiToolConfirmationDecision,
  ): Promise<IAiAgentRun> => {
    void _runId;
    if (hasSidecarStepToolConfirmation(confirmationId)) {
      return resolveSidecarStepToolConfirmation(confirmationId, decision);
    }
    throw new Error('未找到对应的工具确认，请重试或重新发起。');
  };

  const pauseRun = async (runId: string): Promise<IAiAgentRun> => {
    try {
      pausedRuns.add(runId);
      return updateRun(runId, (run) =>
        isTerminalRunStatus(run.status)
          ? run
          : { ...run, status: 'paused', updatedAt: new Date().toISOString() },
      );
    } catch (error) {
      setErrorMessage(toErrorMessage(error, '暂停 Agent run 失败。'));
      throw error;
    }
  };

  const resumeRun = async (runId: string): Promise<IAiAgentRun> => {
    try {
      pausedRuns.delete(runId);
      return updateRun(runId, (run) => ({
        ...run,
        status: run.status === 'paused' ? 'running-step' : run.status,
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
      const orchestrationRunId = store.orchestrationRunId;
      if (orchestrationRunId) {
        try {
          await resumeOrchestration({ runId: orchestrationRunId, decision: 'cancel' });
        } catch {
          // best-effort:即使服务端 run 已不存在,也要把本地状态收成 cancelled。
        }
      }
      return cancelRunLocal(runId);
    } catch (error) {
      setErrorMessage(toErrorMessage(error, '取消 Agent run 失败。'));
      throw error;
    }
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
