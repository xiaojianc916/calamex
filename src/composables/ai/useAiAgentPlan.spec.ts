import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAiAgentPlan } from '@/composables/ai/useAiAgentPlan';
import { useAiAgentStore } from '@/store/aiAgent';
import type { IAiAgentRun, IAiTaskPlanStep } from '@/types/ai';
import type {
  IAgentPlan,
  IAgentSidecarResponsePayload,
  TAgentUiEvent,
} from '@/types/ai/sidecar';

// 原生管线:计划生成 = 一次 plan 模式的 sidecarChat 回合,真实投影器
// projectSidecarPlanResponse 把 plan_ready / done 事件映射成计划与 usage。
const aiServiceMock = vi.hoisted(() => {
  const classifyTask = vi.fn();
  const sidecarChat = vi.fn();

  return {
    classifyTask,
    sidecarChat,
    reset(): void {
      classifyTask.mockReset();
      sidecarChat.mockReset();
    },
  };
});

vi.mock('@/services/ipc/ai.service', () => ({
  aiService: {
    classifyTask: aiServiceMock.classifyTask,
    sidecarChat: aiServiceMock.sidecarChat,
  },
}));

const createTaskStep = (
  index: number,
  status: IAiTaskPlanStep['status'] = 'pending',
): IAiTaskPlanStep => ({
  id: `plan-step-${index + 1}`,
  index,
  title: index === 0 ? '恢复上下文' : '继续执行',
  goal: index === 0 ? '恢复上下文' : '继续执行',
  kind: index === 0 ? 'inspect' : 'edit',
  status,
  expectedOutput: index === 0 ? '上下文摘要' : '执行结果',
  tools: index === 0 ? ['read_file'] : ['auto_apply_patch'],
  requiresUserApproval: false,
  riskLevel: 'low',
});

const createPlan = (): IAgentPlan => ({
  goal: '实现计划模式持久化',
  summary: '恢复计划执行 UI。',
  requiresApproval: true,
  steps: [
    {
      id: 'plan-step-1',
      title: '恢复上下文',
      goal: '恢复上下文',
      status: 'pending',
      tools: ['read_project_file'],
      riskLevel: 'low',
      requiresApproval: false,
      expectedOutput: '上下文摘要',
    },
    {
      id: 'plan-step-2',
      title: '继续执行',
      goal: '继续执行',
      status: 'pending',
      tools: ['edit_file'],
      riskLevel: 'medium',
      requiresApproval: true,
      expectedOutput: '执行结果',
    },
  ],
});

const createRun = (steps: IAiTaskPlanStep[]): IAiAgentRun => ({
  id: 'agent-run-persisted-1',
  goal: '实现计划模式持久化',
  status: 'paused',
  steps,
  currentStepId: steps[0]?.id ?? null,
  createdAt: '2026-05-11T10:00:30.000Z',
  updatedAt: '2026-05-11T10:01:00.000Z',
  startedAt: '2026-05-11T10:00:30.000Z',
  completedAt: null,
  errorMessage: null,
});

const makeResponse = (
  events: TAgentUiEvent[],
  result: string | null = null,
  sessionId = 'sidecar-plan-session-1',
): IAgentSidecarResponsePayload => ({ sessionId, events, result });

const planReadyEvent = (): TAgentUiEvent => ({
  type: 'plan_ready',
  planId: 'plan-runtime-1',
  threadId: 'thread-runtime-1',
  version: 1,
  status: 'pending_approval',
  createdAt: '2026-05-11T10:00:00.000Z',
  updatedAt: '2026-05-11T10:01:00.000Z',
  plan: createPlan(),
});

const doneWithUsageEvent = (): TAgentUiEvent => ({
  type: 'done',
  result: '计划已生成。',
  usage: {
    inputTokens: 23,
    inputTokenDetails: {
      noCacheTokens: 23,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    outputTokens: 7,
    outputTokenDetails: {
      textTokens: 6,
      reasoningTokens: 1,
    },
    totalTokens: 30,
    cachedInputTokens: 0,
    reasoningTokens: 1,
  },
});

describe('useAiAgentPlan', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    aiServiceMock.reset();
  });

  it('恢复持久化计划状态时保留暂停 run，且不再回查服务端', async () => {
    const store = useAiAgentStore();
    const agentPlan = useAiAgentPlan();
    const runSteps = [createTaskStep(0), createTaskStep(1)];
    const run = createRun(runSteps);

    store.setPlan('实现计划模式持久化', runSteps, {
      planId: 'plan-persisted-1',
      threadId: 'thread-persisted-1',
      version: 1,
      status: 'executing',
      approvedAt: '2026-05-11T10:00:30.000Z',
      executedAt: null,
      rejectionReason: null,
      errorMessage: null,
      summary: '恢复计划执行 UI。',
      requiresApproval: true,
    });
    store.upsertRun(run);

    await agentPlan.restorePersistedPlanState();

    expect(store.mode).toBe('plan');
    expect(store.activeGoal).toBe('实现计划模式持久化');
    expect(store.activeRunId).toBe(run.id);
    expect(store.activeRun?.status).toBe('paused');
    expect(store.activeRun?.currentStepId).toBe('plan-step-1');
    expect(store.steps).toEqual(runSteps);
    expect(store.planStatus).toBe('executing');
    expect(aiServiceMock.sidecarChat).not.toHaveBeenCalled();
  });

  it('生成计划：调用 plan 模式原生回合，记录 usage 并进入 plan 模式', async () => {
    const store = useAiAgentStore();
    const agentPlan = useAiAgentPlan();

    aiServiceMock.sidecarChat.mockResolvedValueOnce(
      makeResponse([planReadyEvent(), doneWithUsageEvent()]),
    );

    const result = await agentPlan.createPlan(
      '实现计划模式持久化',
      [],
      'd:/com.xiaojianc/my_desktop_app',
    );

    expect(aiServiceMock.sidecarChat).toHaveBeenCalledWith(
      expect.objectContaining({ goal: '实现计划模式持久化', mode: 'plan' }),
    );
    expect(store.mode).toBe('plan');
    expect(result.planMetadata.version).toBe(1);
    expect(result.planMetadata.status).toBe('pending_approval');
    expect(result.steps).toHaveLength(2);
    expect(store.latestOfficialUsageResolved).toBe(true);
    expect(store.latestOfficialUsage).toMatchObject({
      inputTokens: 23,
      outputTokens: 7,
      totalTokens: 30,
    });
  });

  it('批准计划只切换本地状态，不触发任何服务端调用', async () => {
    const store = useAiAgentStore();
    const agentPlan = useAiAgentPlan();
    const steps = [createTaskStep(0), createTaskStep(1)];

    store.setPlan('实现计划模式持久化', steps, {
      planId: 'plan-runtime-1',
      version: 1,
      status: 'pending_approval',
      summary: '待批准计划。',
      requiresApproval: true,
    });

    await agentPlan.approvePlan();

    expect(store.planStatus).toBe('approved');
    expect(store.mode).toBe('agent');
    expect(aiServiceMock.sidecarChat).not.toHaveBeenCalled();
  });

  it('拒绝计划直接丢弃本地草稿', async () => {
    const store = useAiAgentStore();
    const agentPlan = useAiAgentPlan();
    const steps = [createTaskStep(0), createTaskStep(1)];

    store.setPlan('实现计划模式持久化', steps, {
      planId: 'plan-runtime-1',
      version: 1,
      status: 'pending_approval',
      summary: '待批准计划。',
      requiresApproval: true,
    });

    await agentPlan.rejectPlan('暂不执行');

    expect(store.steps).toHaveLength(0);
    expect(aiServiceMock.sidecarChat).not.toHaveBeenCalled();
  });
});
