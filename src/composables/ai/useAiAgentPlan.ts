import { ref } from 'vue';
import {
  mapSidecarPlanToTaskSteps,
  projectSidecarPlanRecordResponse,
} from '@/composables/ai/sidecar-events';
import { resumeOrchestration, startOrchestration } from '@/composables/ai/sidecar-orchestrate';
import { aiService } from '@/services/ipc/ai.service';
import { useAiAgentStore } from '@/store/aiAgent';
import type {
  IAiAgentPlanMetadata,
  IAiContextReference,
  IAiTaskPlanStep,
  IAiToolCall,
} from '@/types/ai';
import type { IAgentSidecarResponsePayload } from '@/types/ai/sidecar';
import { toErrorMessage } from '@/utils/error';
import { logger } from '@/utils/logger';

const MIN_PLAN_STEPS = 2;
const MAX_PLAN_STEPS = 6;

export interface IAiAgentPlanCreationResult {
  steps: IAiTaskPlanStep[];
  planMetadata: IAiAgentPlanMetadata;
  summary: string | null;
  toolCalls: IAiToolCall[];
  assistantContent: string;
}

interface IAiAgentCreatePlanOptions {
  planId?: string;
  threadId?: string;
}

const cloneContext = (context: IAiContextReference[]): IAiContextReference[] =>
  context.map((item) => ({ ...item }));

const assertValidGoal = (goal: string, message: string): void => {
  if (!goal.trim()) {
    throw new Error(message);
  }
};

const assertValidPlanSteps = (steps: IAiTaskPlanStep[]): void => {
  if (steps.length < MIN_PLAN_STEPS || steps.length > MAX_PLAN_STEPS) {
    throw new Error(`计划步骤数必须在 ${MIN_PLAN_STEPS} 到 ${MAX_PLAN_STEPS} 之间。`);
  }
};

export const useAiAgentPlan = () => {
  const store = useAiAgentStore();
  const latestContext = ref<IAiContextReference[]>([]);
  const latestWorkspaceRootPath = ref<string | null>(null);

  const applyPlanRecordPayload = (
    payload: IAgentSidecarResponsePayload,
    options: { replacePlanSnapshot?: boolean } = {},
  ): void => {
    const projection = projectSidecarPlanRecordResponse(payload);
    if (projection.errorMessage) {
      throw new Error(projection.errorMessage);
    }
    if (!projection.metadata) {
      throw new Error('sidecar 未返回计划记录，无法同步计划状态。');
    }
    const metadata = projection.metadata;

    if (options.replacePlanSnapshot && projection.record) {
      const activeRun = store.activeRun;
      if (activeRun) {
        store.activeGoal = projection.record.plan.goal;
        store.steps = activeRun.steps;
      } else {
        store.setPlan(
          projection.record.plan.goal,
          mapSidecarPlanToTaskSteps(projection.record.plan),
          metadata,
        );
      }
    }
    store.applyPlanMetadata(metadata, projection.versions);
  };

  const classifyTask = async (goal: string, context: IAiContextReference[]): Promise<void> => {
    store.beginPlanning(goal);
    store.isClassifying = true;
    try {
      const contextSnapshot = cloneContext(context);
      const payload = await aiService.classifyTask({
        goal,
        context: contextSnapshot,
      });
      latestContext.value = contextSnapshot;
      store.setClassification(payload);
    } catch (error) {
      store.failPlanning(goal, toErrorMessage(error, '任务分类失败。'));
      throw error;
    } finally {
      store.isClassifying = false;
    }
  };

  const createPlan = async (
    goal: string,
    context: IAiContextReference[],
    workspaceRootPath: string | null = null,
    options: IAiAgentCreatePlanOptions = {},
  ): Promise<IAiAgentPlanCreationResult> => {
    store.beginPlanning(goal);
    store.isPlanning = true;
    try {
      assertValidGoal(goal, '任务目标不能为空。');
      const contextSnapshot = cloneContext(context);

      // 原生编排:启动单条 workflow run,跑到计划审批门挂起(plan_ready + suspend)。
      const { payload, projection } = await startOrchestration({
        goal,
        ...(options.threadId ? { threadId: options.threadId } : {}),
      });

      if (projection.usage) {
        store.setLatestOfficialUsage(projection.usage);
      }
      if (projection.errorMessage) {
        throw new Error(projection.errorMessage);
      }
      if (!projection.planMetadata) {
        throw new Error('编排未返回计划元数据，无法进入审批流程。');
      }
      const planMetadata = projection.planMetadata;

      latestContext.value = contextSnapshot;
      latestWorkspaceRootPath.value = workspaceRootPath;
      // 把计划阶段的 runId 一直带到执行阶段(approve / resume 复用)。
      store.setOrchestrationRunId(payload.runId);
      store.setMode('plan');
      store.setPlan(goal, projection.steps, planMetadata);

      return {
        steps: projection.steps,
        planMetadata,
        summary: planMetadata.summary ?? projection.plan?.summary ?? null,
        toolCalls: projection.toolCalls,
        assistantContent: projection.assistantContent,
      };
    } catch (error) {
      store.failPlanning(goal, toErrorMessage(error, '生成计划失败。'));
      throw error;
    } finally {
      store.isPlanning = false;
    }
  };

  const regeneratePlan = async (): Promise<IAiTaskPlanStep[]> => {
    assertValidGoal(store.activeGoal, '当前没有可重新生成的计划目标。');
    return (
      await createPlan(
        store.activeGoal,
        latestContext.value,
        latestWorkspaceRootPath.value,
        store.planId
          ? {
              planId: store.planId,
              ...(store.planThreadId ? { threadId: store.planThreadId } : {}),
            }
          : {},
      )
    ).steps;
  };

  const refreshPlanRecord = async (
    planId = store.planId,
    version = store.planVersion ?? undefined,
  ): Promise<void> => {
    if (!planId) {
      throw new Error('当前没有可查询的计划记录。');
    }
    const payload = await aiService.sidecarPlanQuery({
      planId,
      ...(version ? { version } : {}),
    });
    applyPlanRecordPayload(payload, { replacePlanSnapshot: true });
  };

  const restorePersistedPlanState = async (): Promise<void> => {
    const hasPersistedSnapshot =
      store.steps.length > 0 || Boolean(store.activeRun) || Boolean(store.planId);
    if (!hasPersistedSnapshot) {
      return;
    }
    store.setMode('plan');
    store.isClassifying = false;
    store.isPlanning = false;
    store.isApproving = false;
    if (!store.planId) {
      return;
    }
    await refreshPlanRecord(store.planId, store.planVersion ?? undefined).catch(
      (error: unknown) => {
        logger.warn({
          event: 'ai-agent-plan-persisted-refresh-failed',
          err: error,
          planId: store.planId,
          planVersion: store.planVersion,
        });
      },
    );
  };

  const updateStep = (stepId: string, partial: Partial<IAiTaskPlanStep>): void => {
    const current = store.steps.find((step) => step.id === stepId);
    if (!current) {
      return;
    }
    store.replaceStep(stepId, {
      ...current,
      ...partial,
      id: current.id,
    });
  };

  const removeStep = (stepId: string): void => {
    if (store.steps.length <= MIN_PLAN_STEPS) {
      throw new Error(`计划至少保留 ${MIN_PLAN_STEPS} 步。`);
    }
    store.removeStep(stepId);
  };

  // 原生编排:批准是本地状态切换;实际放行由执行阶段 resume('approve') 完成
  // (host 在 approvePlan() 之后会调用 runPlanToCompletion,在那里 resume)。
  const approvePlan = async (): Promise<void> => {
    assertValidGoal(store.activeGoal, '任务目标不能为空。');
    assertValidPlanSteps(store.steps);
    store.isApproving = true;
    store.errorMessage = '';
    try {
      if (!store.orchestrationRunId) {
        throw new Error('当前没有可执行的编排 run，无法批准。');
      }
      store.setPlanStatus('approved', store.approvedAt ?? new Date().toISOString());
      store.setMode('agent');
    } catch (error) {
      store.errorMessage = toErrorMessage(error, '批准计划失败。');
      throw error;
    } finally {
      store.isApproving = false;
    }
  };

  // 原生编排:拒绝 = resume('reject') 拆掉挂起的 workflow,然后清空本地编排 run。
  const rejectPlan = async (reason?: string): Promise<void> => {
    const orchestrationRunId = store.orchestrationRunId;
    if (!orchestrationRunId) {
      resetPlan();
      return;
    }
    store.isApproving = true;
    store.errorMessage = '';
    try {
      await resumeOrchestration({
        runId: orchestrationRunId,
        decision: 'reject',
        ...(reason ? { reason } : {}),
      });
      store.setOrchestrationRunId(null);
      store.setMode('plan');
    } catch (error) {
      store.errorMessage = toErrorMessage(error, '拒绝计划失败。');
      throw error;
    } finally {
      store.isApproving = false;
    }
  };

  const resetPlan = (): void => {
    store.clearPlan();
    latestContext.value = [];
    latestWorkspaceRootPath.value = null;
  };

  return {
    store,
    classifyTask,
    createPlan,
    regeneratePlan,
    refreshPlanRecord,
    restorePersistedPlanState,
    updateStep,
    removeStep,
    approvePlan,
    rejectPlan,
    resetPlan,
  };
};
