import { unref } from 'vue';
import {
  type IAgentSidecarExecuteProjection,
  mapSidecarEventsToToolCalls,
  mapSidecarToolNameToAiToolName,
  projectSidecarExecuteResponse,
  resolveSidecarOfficialUsage,
} from '@/composables/ai/sidecar-events';
import { mapToolConfirmationDecisionToSidecarDecision } from '@/composables/ai/useAiAssistant.stream';
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
import type { TAgentUiEvent } from '@/types/ai/sidecar';
import { toErrorMessage } from '@/utils/error/error';

interface ISidecarStepLoopOptions {
  goal?: string;
  context?: IAiContextReference[];
  workspaceRootPath?: string | null;
}

// resume(续跑)一个被工具审批挂起的回合所需的上下文。
interface ISidecarConfirmationEntry {
  runId: string;
  sessionId: string;
  requestId: string;
  options: ISidecarStepLoopOptions;
}

const TERMINAL_RUN_STATUSES = new Set<IAiAgentRun['status']>(['completed', 'failed', 'cancelled']);

const isTerminalRunStatus = (status: IAiAgentRun['status']): boolean =>
  TERMINAL_RUN_STATUSES.has(status);

const createSidecarRunId = (): string => `sidecar-plan:${crypto.randomUUID()}`;

// 原生 agent 回合的会话键:同一 run 的 start / resolve 复用同一 sessionId,
// 让后端 session/prompt 在审批续跑时衔接到同一回合。
const createRunSessionId = (runId: string): string => `sidecar-run:${runId}`;

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

export const useAiAgentRun = () => {
  const store = useAiAgentStore();
  const { refreshSidecarChangedDocuments } = useSidecarChangedDocumentRefresh();

  // confirmationId -> 恢复该 run 所需的上下文。
  const toolConfirmations = new Map<string, ISidecarConfirmationEntry>();
  // runId -> 原生回合的会话键。
  const runSessions = new Map<string, string>();
  // 协作式暂停 / 已启动标记。
  const pausedRuns = new Set<string>();
  const startedRuns = new Set<string>();
  // runId -> 当前前端生命周期 token。暂停/取消/重新执行会递增或清除 token,
  // 让已经在途的回合结果无法覆盖新的本地终态。
  const runLifecycleTokens = new Map<string, number>();

  const getRuns = (): IAiAgentRun[] => unref(store.runs);
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

  const bumpRunLifecycleToken = (runId: string): number => {
    const token = (runLifecycleTokens.get(runId) ?? 0) + 1;
    runLifecycleTokens.set(runId, token);
    return token;
  };

  const isRunLifecycleCurrent = (runId: string, token: number): boolean => {
    const run = getRuns().find((item) => item.id === runId) ?? null;
    return (
      runLifecycleTokens.get(runId) === token && run !== null && !isTerminalRunStatus(run.status)
    );
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
    runLifecycleTokens.delete(runId);
    runSessions.delete(runId);
  };

  const getRunSessionId = (runId: string): string => {
    const existing = runSessions.get(runId);
    if (existing) {
      return existing;
    }
    const sessionId = createRunSessionId(runId);
    runSessions.set(runId, sessionId);
    return sessionId;
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

  const setRunWaiting = (runId: string): IAiAgentRun =>
    updateRun(runId, (run) => ({
      ...run,
      status: 'waiting-for-tool-confirmation',
      updatedAt: new Date().toISOString(),
    }));

  const completeRun = (runId: string, finalAnswer: string): IAiAgentRun => {
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
    if (finalAnswer.trim() && run.steps.length > 0) {
      const last = run.steps[run.steps.length - 1];
      if (last) {
        store.appendStepFinalAnswer(
          toStepFinalAnswer(
            runId,
            last.id,
            finalAnswer,
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
    const stepId = getRuns().find((run) => run.id === runId)?.currentStepId ?? null;
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
    projection: IAgentSidecarExecuteProjection,
    workspaceRootPath: string | null | undefined,
  ): Promise<void> => {
    const refreshResult = await refreshSidecarChangedDocuments({
      changedFilePaths: projection.changedFilePaths,
      hasFileMutations: projection.hasFileMutations,
      workspaceRootPath: workspaceRootPath ?? null,
    });
    if (refreshResult.skippedDirtyNames.length > 0) {
      setErrorMessage(
        `Agent 已修改文件,但 ${refreshResult.skippedDirtyNames.join('、')} 有未保存改动,已跳过自动刷新。`,
      );
      return;
    }
    if (refreshResult.failedNames.length > 0) {
      setErrorMessage(
        `Agent 已修改文件,但刷新 ${refreshResult.failedNames.join('、')} 失败,请手动重新打开。`,
      );
    }
  };

  // 单次原生 agent 回合:start = sidecarChat(mode='agent');resolve = sidecarResolveApproval。
  // 后端在一次调用里自动跑到完成 / 工具审批挂起 / 出错,无需前端逐步 continue。
  const executeNativeTurn = async (
    runId: string,
    turn:
      | { kind: 'start' }
      | { kind: 'resolve'; requestId: string; decision: 'approve' | 'reject' | 'cancel' },
    options: ISidecarStepLoopOptions,
    lifecycleToken: number,
  ): Promise<IAiAgentRun> => {
    const run = getRunOrThrow(runId);
    const sessionId = getRunSessionId(runId);
    const baseRequest = {
      sessionId,
      goal: options.goal ?? run.goal,
      messages: [],
      context: options.context ?? [],
      workspaceRootPath: options.workspaceRootPath ?? null,
    };
    const response =
      turn.kind === 'start'
        ? await aiService.sidecarChat({ mode: 'agent', ...baseRequest })
        : await aiService.sidecarResolveApproval({
            ...baseRequest,
            requestId: turn.requestId,
            decision: turn.decision,
          });

    if (!isRunLifecycleCurrent(runId, lifecycleToken)) {
      return getRunOrThrow(runId);
    }

    const projection = projectSidecarExecuteResponse(response);
    const officialUsage = resolveSidecarOfficialUsage(response);
    if (officialUsage.usage) {
      store.setLatestOfficialUsage(officialUsage.usage);
    }
    appendLiveActivities(runId, response.events);
    const stepId = getRuns().find((item) => item.id === runId)?.currentStepId ?? null;
    if (stepId) {
      store.appendStepToolResults(
        runId,
        stepId,
        toStepToolResultSummaries(runId, stepId, projection.toolCalls),
      );
    }
    await refreshChangedDocs(projection, options.workspaceRootPath);

    if (!isRunLifecycleCurrent(runId, lifecycleToken)) {
      return getRunOrThrow(runId);
    }

    if (projection.errorMessage) {
      return failRun(runId, projection.errorMessage);
    }
    if (projection.pendingConfirmation) {
      const confirmationId = projection.pendingConfirmation.id;
      toolConfirmations.set(confirmationId, {
        runId,
        sessionId,
        requestId: confirmationId,
        options,
      });
      store.setPendingToolConfirmation({
        ...projection.pendingConfirmation,
        runId,
        ...(stepId ? { stepId } : {}),
      });
      return setRunWaiting(runId);
    }
    return completeRun(runId, projection.assistantContent);
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
    const run = await runPlan(goal, steps, options.context ?? []);
    startedRuns.add(run.id);
    const lifecycleToken = bumpRunLifecycleToken(run.id);
    return executeNativeTurn(
      run.id,
      { kind: 'start' },
      {
        goal,
        ...(options.context ? { context: options.context } : {}),
        workspaceRootPath: options.workspaceRootPath ?? null,
      },
      lifecycleToken,
    );
  };

  const continueRunToCompletion = async (
    runId: string,
    options: ISidecarStepLoopOptions,
  ): Promise<IAiAgentRun> => {
    pausedRuns.delete(runId);
    startedRuns.add(runId);
    const lifecycleToken = bumpRunLifecycleToken(runId);
    return executeNativeTurn(
      runId,
      { kind: 'start' },
      {
        ...(options.goal ? { goal: options.goal } : {}),
        ...(options.context ? { context: options.context } : {}),
        workspaceRootPath: options.workspaceRootPath ?? null,
      },
      lifecycleToken,
    );
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

  // 单步(手动 mode):跑一次原生 agent 回合,然后停。
  const runStepWithSidecar = async (
    runId: string,
    options: ISidecarStepLoopOptions,
  ): Promise<IAiAgentRun> => {
    try {
      startedRuns.add(runId);
      const lifecycleToken = bumpRunLifecycleToken(runId);
      setPlanStatus('executing', store.approvedAt);
      return executeNativeTurn(
        runId,
        { kind: 'start' },
        {
          ...(options.goal ? { goal: options.goal } : {}),
          ...(options.context ? { context: options.context } : {}),
          workspaceRootPath: options.workspaceRootPath ?? null,
        },
        lifecycleToken,
      );
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

    const sidecarDecision = mapToolConfirmationDecisionToSidecarDecision(decision);
    // 拒绝并中止(stop -> cancel):回投 cancel 决策拆掉回合,本地标记取消。
    if (sidecarDecision === 'cancel') {
      try {
        await aiService.sidecarResolveApproval({
          sessionId: entry.sessionId,
          requestId: entry.requestId,
          decision: 'cancel',
          messages: [],
          context: entry.options.context ?? [],
          ...(entry.options.goal ? { goal: entry.options.goal } : {}),
          workspaceRootPath: entry.options.workspaceRootPath ?? null,
        });
      } catch (error) {
        setErrorMessage(toErrorMessage(error, '取消 Agent run 失败。'));
      }
      return cancelRunLocal(entry.runId);
    }
    // 允许(approve)/ 跳过(reject):回投决策续跑同一回合,直到完成 / 下一个审批门。
    const lifecycleToken = bumpRunLifecycleToken(entry.runId);
    return executeNativeTurn(
      entry.runId,
      { kind: 'resolve', requestId: entry.requestId, decision: sidecarDecision },
      entry.options,
      lifecycleToken,
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
    throw new Error('未找到对应的工具确认,请重试或重新发起。');
  };

  const pauseRun = async (runId: string): Promise<IAiAgentRun> => {
    try {
      pausedRuns.add(runId);
      runLifecycleTokens.delete(runId);
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
      runLifecycleTokens.delete(runId);
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
