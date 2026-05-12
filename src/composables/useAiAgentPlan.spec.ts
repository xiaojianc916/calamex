import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAiAgentPlan } from '@/composables/useAiAgentPlan';
import { useAiAgentStore } from '@/store/aiAgent';
import type { IAgentPlan, IAgentPlanRecord, IAgentSidecarResponsePayload } from '@/types/agent-sidecar';
import type { IAiAgentRun, IAiTaskPlanStep } from '@/types/ai';

const aiServiceMock = vi.hoisted(() => {
  const classifyTask = vi.fn();
  const sidecarPlan = vi.fn();
  const sidecarPlanQuery = vi.fn();
  const sidecarPlanApprove = vi.fn();
  const sidecarPlanReject = vi.fn();

  return {
    classifyTask,
    sidecarPlan,
    sidecarPlanQuery,
    sidecarPlanApprove,
    sidecarPlanReject,
    reset(): void {
      classifyTask.mockReset();
      sidecarPlan.mockReset();
      sidecarPlanQuery.mockReset();
      sidecarPlanApprove.mockReset();
      sidecarPlanReject.mockReset();
    },
  };
});

vi.mock('@/services/modules/ai', () => ({
  aiService: {
    classifyTask: aiServiceMock.classifyTask,
    sidecarPlan: aiServiceMock.sidecarPlan,
    sidecarPlanQuery: aiServiceMock.sidecarPlanQuery,
    sidecarPlanApprove: aiServiceMock.sidecarPlanApprove,
    sidecarPlanReject: aiServiceMock.sidecarPlanReject,
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

describe('useAiAgentPlan', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    aiServiceMock.reset();
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
});
