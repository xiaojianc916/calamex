import { ref } from 'vue';
import {
  mapSidecarPlanToTaskSteps,
  projectSidecarPlanRecordResponse,
  projectSidecarPlanResponse,
  resolveSidecarOfficialUsage,
} from '@/composables/ai/sidecar-events';
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

const getSidecarErrorMessage = (payload: IAgentSidecarResponsePayload): string | null =>
  payload.events.find(
    (event): event is Extract<(typeof payload.events)[number], { type: 'error' }> =>
      event.type === 'error',
  )?.message ?? null;

const assertSidecarSuccess = (payload: IAgentSidecarResponsePayload, fallback: string): void => {
  const errorMessage = getSidecarErrorMessage(payload);
  if (errorMessage) {
    throw new Error(errorMessage);
  }
  if (payload.result === null) {
    throw new Error(fallback);
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
    // 抽 local const,绕过 TS 在 property access 上"函数调用后窄化丢失"的限制。
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
      const payload = await aiService.sidecarPlan({
        goal,
        messages: [
          {
            role: 'user',
            content: goal,
          },
        ],
        workspaceRootPath,
        context: contextSnapshot,
        ...(options.threadId ? { threadId: options.threadId } : {}),
        ...(options.planId ? { planId: options.planId } : {}),
      });

      const usageResolution = resolveSidecarOfficialUsage(payload);
      if (usageResolution.resolved && usageResolution.usage) {
        // usageResolution.usage 与 setLatestOfficialUsage 参数同为
        // IAiLanguageModelUsage,守卫内已窄化为非空,直接传入即类型安全,无需 cast。
        store.setLatestOfficialUsage(usageResolution.usage);
      }

      const projection = projectSidecarPlanResponse(payload, goal);
      if (projection.errorMessage) {
        throw new Error(projection.errorMessage);
      }
      if (!projection.planMetadata) {
        throw new Error('sidecar 未返回计划元数据，无法进入审批流程。');
      }
      // 同上:抽 local const,后续所有调用穿过 store.setPlan / await 都保持非空窄化。
      const planMetadata = projection.planMetadata;

      latestContext.value = contextSnapshot;
      latestWorkspaceRootPath.value = workspaceRootPath;
      store.setMode('plan');
      store.setPlan(projection.goal, projection.steps, planMetadata);
      await refreshPlanRecord(planMetadata.planId, planMetadata.version).catch((error: unknown) => {
        logger.warn({
          event: 'ai-agent-plan-record-refresh-failed',
          err: error,
          planId: planMetadata.planId,
          planVersion: planMetadata.version,
        });
      });

      return {
        steps: projection.steps,
        planMetadata,
        summary: projection.summary,
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

  const approvePlan = async (): Promise<void> => {
    assertValidGoal(store.activeGoal, '任务目标不能为空。');
    assertValidPlanSteps(store.steps);
    store.isApproving = true;
    store.errorMessage = '';
    try {
      if (!store.planId || !store.planVersion) {
        throw new Error('当前计划缺少 planId 或 version，不能批准。');
      }
      const approvedAt = new Date().toISOString();
      const payload = await aiService.sidecarPlanApprove({
        planId: store.planId,
        version: store.planVersion,
      });
      assertSidecarSuccess(payload, 'sidecar 未确认计划审批结果。');
      applyPlanRecordPayload(payload);
      store.setPlanStatus('approved', store.approvedAt ?? approvedAt);
      store.setMode('agent');
    } catch (error) {
      store.errorMessage = toErrorMessage(error, '批准计划失败。');
      throw error;
    } finally {
      store.isApproving = false;
    }
  };

  const rejectPlan = async (reason?: string): Promise<void> => {
    if (!store.planId || !store.planVersion) {
      resetPlan();
      return;
    }
    store.isApproving = true;
    store.errorMessage = '';
    try {
      const payload = await aiService.sidecarPlanReject({
        planId: store.planId,
        version: store.planVersion,
        ...(reason ? { reason } : {}),
      });
      assertSidecarSuccess(payload, 'sidecar 未确认计划拒绝结果。');
      applyPlanRecordPayload(payload);
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
