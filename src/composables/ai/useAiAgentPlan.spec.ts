import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { projectOrchestrateEvents } from '@/composables/ai/sidecar-orchestrate';
import { useAiAgentPlan } from '@/composables/ai/useAiAgentPlan';
import { useAiAgentStore } from '@/store/aiAgent';
import type { IAiAgentRun, IAiTaskPlanStep } from '@/types/ai';
import type {
  IAgentPlan,
  IAgentPlanRecord,
  IAgentSidecarResponsePayload,
  TAgentUiEvent,
} from '@/types/ai/sidecar';

// 部分 mock：保留真实 projectOrchestrateEvents，仅替换两个驱动函数。
const orchestrateMock = vi.hoisted(() => ({
  startOrchestration: vi.fn(),
  resumeOrchestration: vi.fn(),
}));

vi.mock('@/composables/ai/sidecar-orchestrate', async (importActual) => {
  const actual =
    await importActual<typeof import('@/composables/ai/sidecar-orchestrate')>();
  return {
    ...actual,
    startOrchestration: orchestrateMock.startOrchestration,
    resumeOrchestration: orchestrateMock.resumeOrchestration,
  };
});

const aiServiceMock = vi.hoisted(() => {
  const classifyTask = vi.fn();
  const sidecarPlanQuery = vi.fn();

  return {
    classifyTask,
    sidecarPlanQuery,
    reset(): void {
      classifyTask.mockReset();
      sidecarPlanQuery.mockReset();
    },
  };
});

vi.mock('@/services/ipc/ai.service', () => ({
  aiService: {
    classifyTask: aiServiceMock.classifyTask,
    sidecarPlanQuery: aiServiceMock.sidecarPlanQuery,
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

const createPlanRecord = (): IAgentPlanRecord => ({
  planId: 'plan-persisted-1',
  threadId: 'thread-persisted-1',
  version: 1,
  status: 'executing',
  userRequest: '实现计划模式持久化',
  plan: createPlan(),
  createdAt: '2026-05-11T10:00:00.000Z',
  updatedAt: '2026-05-11T10:02:00.000Z',
  approvedAt: '2026-05-11T10:00:30.000Z',
  executedAt: null,
  rejectionReason: null,
  errorMessage: null,
});

const createPlanRecordResponse = (): IAgentSidecarResponsePayload => {
  const record = createPlanRecord();

  return {
    sessionId: 'sidecar-plan-query-session-1',
    events: [
      {
        type: 'plan_record',
        record,
        versions: [record],
      },
      {
        type: 'done',
        result: 'sidecar plan record ready',
      },
    ],
    result: 'sidecar plan record ready',
  };
};

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

const makeResult = (events: TAgentUiEvent[], runId = 'orch-plan-run-1') => ({
  payload: { runId, result: null },
  events,
  projection: projectOrchestrateEvents(events, runId),
});

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
    orchestrateMock.startOrchestration.mockReset();
    orchestrateMock.resumeOrchestration.mockReset();
  });

  it('刷新回查计划记录时保留已恢复的暂停 run', async () => {
    const store = useAiAgentStore();
    const agentPlan = useAiAgentPlan();
    const runSteps = [createTaskStep(0), createTaskStep(1)];
    const run = createRun(runSteps);

    aiServiceMock.sidecarPlanQuery.mockResolvedValue(createPlanRecordResponse());
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

    expect(aiServiceMock.sidecarPlanQuery).toHaveBeenCalledWith({
      planId: 'plan-persisted-1',
      version: 1,
    });
    expect(store.mode).toBe('plan');
    expect(store.activeGoal).toBe('实现计划模式持久化');
    expect(store.activeRunId).toBe(run.id);
    expect(store.activeRun?.status).toBe('paused');
    expect(store.activeRun?.currentStepId).toBe('plan-step-1');
    expect(store.steps).toEqual(runSteps);
    expect(store.planStatus).toBe('executing');
  });

  it('生成计划后启动编排，记录 runId、usage 并进入 plan 模式', async () => {
    const store = useAiAgentStore();
    const agentPlan = useAiAgentPlan();

    orchestrateMock.startOrchestration.mockResolvedValueOnce(
      makeResult([planReadyEvent(), doneWithUsageEvent()]),
    );

    const result = await agentPlan.createPlan(
      '实现计划模式持久化',
      [],
      'd:/com.xiaojianc/my_desktop_app',
    );

    expect(orchestrateMock.startOrchestration).toHaveBeenCalledWith(
      expect.objectContaining({ goal: '实现计划模式持久化' }),
    );
    expect(store.orchestrationRunId).toBe('orch-plan-run-1');
    expect(store.mode).toBe('plan');
    expect(store.planVersion).toBe(1);
    expect(store.planStatus).toBe('pending_approval');
    expect(result.steps).toHaveLength(2);
    expect(store.latestOfficialUsageResolved).toBe(true);
    expect(store.latestOfficialUsage).toMatchObject({
      inputTokens: 23,
      outputTokens: 7,
      totalTokens: 30,
    });
  });

  it('批准计划只切换本地状态，不触发服务端 resume', async () => {
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
    store.setOrchestrationRunId('orch-plan-run-1');

    await agentPlan.approvePlan();

    expect(store.planStatus).toBe('approved');
    expect(store.mode).toBe('agent');
    expect(orchestrateMock.resumeOrchestration).not.toHaveBeenCalled();
  });

  it('拒绝计划调用 resume(reject) 并清空编排 runId', async () => {
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
    store.setOrchestrationRunId('orch-plan-run-1');

    orchestrateMock.resumeOrchestration.mockResolvedValueOnce(
      makeResult([{ type: 'done', result: '计划已拒绝。' }]),
    );

    await agentPlan.rejectPlan('暂不执行');

    expect(orchestrateMock.resumeOrchestration).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'orch-plan-run-1',
        decision: 'reject',
        reason: '暂不执行',
      }),
    );
    expect(store.orchestrationRunId).toBeNull();
    expect(store.mode).toBe('plan');
  });
});
