import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { projectOrchestrateEvents } from '@/composables/ai/sidecar-orchestrate';
import { useAiAgentRun } from '@/composables/ai/useAiAgentRun';
import { useAiAgentStore } from '@/store/aiAgent';
import type { IAiAgentRun, IAiTaskPlanStep } from '@/types/ai';
import type { TAgentUiEvent } from '@/types/ai/sidecar';

// 部分 mock：保留真实 projectOrchestrateEvents，仅替换两个驱动函数，
// 这样测试里用真实投影器把事件映射成 projection，类型与行为都贴近线上。
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

vi.mock('@/composables/useSidecarChangedDocumentRefresh', () => ({
  useSidecarChangedDocumentRefresh: () => ({
    refreshSidecarChangedDocuments: vi.fn().mockResolvedValue({
      skippedDirtyNames: [],
      failedNames: [],
    }),
  }),
}));

vi.mock('@/services/ipc/ai.service', () => ({
  aiService: {},
}));

const createStep = (
  index: number,
  status: IAiTaskPlanStep['status'] = 'pending',
): IAiTaskPlanStep => ({
  id: `plan-step-${index + 1}`,
  index,
  title: index === 0 ? '收集上下文' : '验证结果',
  goal: index === 0 ? '收集上下文' : '验证结果',
  kind: index === 0 ? 'inspect' : 'verify',
  status,
  expectedOutput: index === 0 ? '影响范围' : '验证结论',
  tools: index === 0 ? ['search_text'] : ['run_test'],
  requiresUserApproval: false,
  riskLevel: 'low',
});

const createRunSteps = (): IAiTaskPlanStep[] => [createStep(0), createStep(1)];

const makeResult = (events: TAgentUiEvent[], runId = 'orch-run-1') => ({
  payload: { runId, result: null },
  events,
  projection: projectOrchestrateEvents(events, runId),
});

// 空事件段 = step_gate（未终态、无审批、无错误）。
const gateResult = (runId = 'orch-run-1') => makeResult([], runId);

const doneEvent = (result: string): TAgentUiEvent => ({ type: 'done', result });
const doneResult = (result: string, runId = 'orch-run-1') =>
  makeResult([doneEvent(result)], runId);

const approvalEvent: TAgentUiEvent = {
  type: 'approval_required',
  request: {
    id: 'call-run-test',
    toolName: 'run_shell_command',
    question: '允许运行测试吗？',
    summary: '步骤请求运行测试。',
    riskLevel: 'medium',
    reversible: true,
    createdAt: '2026-04-29T10:00:00.000Z',
  },
};
const confirmResult = (runId = 'orch-run-1') => makeResult([approvalEvent], runId);

const seedApprovedPlan = (
  store: ReturnType<typeof useAiAgentStore>,
  goal = '实现 Step Runtime',
  steps = createRunSteps(),
): void => {
  store.setPlan(goal, steps, {
    planId: 'plan-runtime-1',
    version: 1,
    status: 'approved',
    summary: '已批准的测试计划。',
    requiresApproval: true,
  });
  store.setPlanStatus('approved', '2026-04-29T10:00:00.000Z');
  store.setOrchestrationRunId('orch-run-1');
};

const decisionsOf = (): Array<string | undefined> =>
  orchestrateMock.resumeOrchestration.mock.calls.map((call) => call[0]?.decision);

describe('useAiAgentRun', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    orchestrateMock.startOrchestration.mockReset();
    orchestrateMock.resumeOrchestration.mockReset();
  });

  it('启动 run 后写入 activ