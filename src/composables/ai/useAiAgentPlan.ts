import { ref } from 'vue';
import {
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
import { toErrorMessage } from '@/utils/error/error';

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

      // 唯一标准管线:计划生成 = 一次 plan 模式的原生回合(sidecarChat mode='plan'),
      // 后端跑 plan workflow 并以 plan_ready 事件带回结构化计划。无服务端挂起 run、无分步
      // resume 闸门——批准/拒绝是纯本地状态切换,实际执行由 agent 回合(useAiAgentRun)承载。
      const response = await aiService.sidecarChat({
        mode: 'plan',
        goal,
        messages: [],
        context: contextSnapshot,
        workspaceRootPath,
        ...(options.threadId ? { threadId: options.threadId } : {}),
        ...(options.planId ? { planId: options.planId } : {}),
      });

      const projection = projectSidecarPlanResponse(response, goal);
      const officialUsage = resolveSidecarOfficialUsage(response);
      if (officialUsage.usage) {
        store.setLatestOfficialUsage(officialUsage.usage);
      }
      if (projection.errorMessage) {
        throw new Error(projection.errorMessage);
      }
      if (!projection.planMetadata) {
        throw new Error('Plan 模式未返回计划元数据，无法进入审批流程。');
      }
      const planMetadata = projection.planMetadata;

      latestContext.value = contextSnapshot;
      latestWorkspaceRootPath.value = workspaceRootPath;
      store.setMode('plan');
      store.setPlan(goal, projection.steps, planMetadata);

      return {
        steps: projection.steps,
        planMetadata,
        summary: planMetadata.summary ?? projection.summary ?? null,
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

  // 计划状态完全以本地持久化快照为准。暂停中的执行 run 是步骤的权威来源,优先对齐到它。
  const refreshPlanRecord = async (
    planId = store.planId,
    _version = store.planVersion ?? undefined,
  ): Promise<void> => {
    if (!planId) {
      return;
    }
    const activeRun = store.activeRun;
    if (activeRun) {
      store.activeGoal = activeRun.goal;
      store.steps = activeRun.steps;
    }
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
    await refreshPlanRecord(store.planId, store.planVersion ?? undefined);
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

  // 批准 = 本地状态切换(approved + agent 模式);实际放行由执行阶段的 agent 回合完成。
  const approvePlan = async (): Promise<void> => {
    assertValidGoal(store.activeGoal, '任务目标不能为空。');
    assertValidPlanSteps(store.steps);
    store.isApproving = true;
    store.errorMessage = '';
    try {
      store.setPlanStatus('approved', store.approvedAt ?? new Date().toISOString());
      store.setMode('agent');
    } catch (error) {
      store.errorMessage = toErrorMessage(error, '批准计划失败。');
      throw error;
    } finally {
      store.isApproving = false;
    }
  };

  // 拒绝 = 直接丢弃本地计划草稿(无服务端挂起 run 需拆除)。
  const rejectPlan = async (_reason?: string): Promise<void> => {
    void _reason;
    resetPlan();
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
