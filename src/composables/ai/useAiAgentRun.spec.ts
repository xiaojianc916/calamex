import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { projectOrchestrateEvents } from '@/composables/ai/sidecar-orchestrate';
import { useAiAgentRun } from '@/composables/ai/useAiAgentRun';
import { useAiAgentStore } from '@/store/aiAgent';
import type { IAiTaskPlanStep } from '@/types/ai';
import type { TAgentUiEvent } from '@/types/ai/sidecar';

// 部分 mock：保留真实 projectOrchestrateEvents，仅替换两个驱动函数，
// 这样测试里用真实投影器把事件映射成 projection，类型与行为都贴近线上。
const orchestrateMock = vi.hoisted(() => ({
  startOrchestration: vi.fn(),
  resumeOrchestration: vi.fn(),
}));

vi.mock('@/composables/ai/sidecar-orchestrate', async (importActual) => {
  const actual = await importActual<typeof import('@/composables/ai/sidecar-orchestrate')>();
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

const createDeferred = <T>() => {
  let resolveValue: ((value: T) => void) | undefined;
  let rejectValue: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });

  return {
    promise,
    resolve(value: T): void {
      if (!resolveValue) throw new Error('deferred resolve is not ready');
      resolveValue(value);
    },
    reject(reason?: unknown): void {
      if (!rejectValue) throw new Error('deferred reject is not ready');
      rejectValue(reason);
    },
  };
};

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

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
const doneResult = (result: string, runId = 'orch-run-1') => makeResult([doneEvent(result)], runId);

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

  it('启动 run 后写入 activeRun 并把首步置为执行中', async () => {
    const agentRun = useAiAgentRun();
    const store = useAiAgentStore();
    const steps = createRunSteps();

    const createdRun = await agentRun.runPlan('实现 Step Runtime', steps);

    expect(createdRun.goal).toBe('实现 Step Runtime');
    expect(store.mode).toBe('agent');
    expect(store.activeRunId).toBe(createdRun.id);
    expect(store.activeRun?.status).toBe('running-step');
    expect(store.activeRun?.currentStepId).toBe('plan-step-1');
    expect(store.activeRun?.steps[0]?.status).toBe('running');
  });

  it('单步模式：首次点击清计划审批门、再次点击推进一步', async () => {
    orchestrateMock.resumeOrchestration
      .mockResolvedValueOnce(gateResult())
      .mockResolvedValueOnce(gateResult());

    const agentRun = useAiAgentRun();
    const store = useAiAgentStore();
    const steps = createRunSteps();
    seedApprovedPlan(store, '实现 Step Runtime', steps);
    const run = await agentRun.runPlan('实现 Step Runtime', steps);

    await agentRun.runStepWithSidecar(run.id, {
      goal: '实现 Step Runtime',
      context: [],
      workspaceRootPath: 'd:/com.xiaojianc/my_desktop_app',
    });

    // 首次 = resume('approve')，只清计划门、不执行步骤。
    expect(store.activeRun?.steps[0]?.status).toBe('running');
    expect(store.activeRun?.currentStepId).toBe('plan-step-1');

    await agentRun.runStepWithSidecar(run.id, {
      goal: '实现 Step Runtime',
      context: [],
      workspaceRootPath: 'd:/com.xiaojianc/my_desktop_app',
    });

    // 再次 = resume('continue')，执行第 1 步并推进游标。
    expect(store.activeRun?.steps[0]?.status).toBe('done');
    expect(store.activeRun?.steps[1]?.status).toBe('running');
    expect(store.activeRun?.currentStepId).toBe('plan-step-2');

    expect(decisionsOf()).toEqual(['approve', 'continue']);
    expect(orchestrateMock.resumeOrchestration.mock.calls[0]?.[0]?.runId).toBe('orch-run-1');
  });

  it('批准后自动连续执行所有步骤直到完成', async () => {
    orchestrateMock.resumeOrchestration
      .mockResolvedValueOnce(gateResult())
      .mockResolvedValueOnce(gateResult())
      .mockResolvedValueOnce(doneResult('计划已完成。'));

    const agentRun = useAiAgentRun();
    const store = useAiAgentStore();
    const steps = createRunSteps();
    seedApprovedPlan(store, '实现 Step Runtime', steps);

    const run = await agentRun.runPlanToCompletion('实现 Step Runtime', steps, {
      context: [],
      workspaceRootPath: 'd:/com.xiaojianc/my_desktop_app',
    });

    expect(orchestrateMock.resumeOrchestration).toHaveBeenCalledTimes(3);
    expect(decisionsOf()).toEqual(['approve', 'continue', 'continue']);
    expect(run.status).toBe('completed');
    expect(store.activeRun?.steps.map((step) => step.status)).toEqual(['done', 'done']);
    expect(store.getStepFinalAnswers(run.id).map((answer) => answer.content)).toEqual([
      '计划已完成。',
    ]);
  });

  it('高风险工具挂起后，确认放行可继续跑到完成', async () => {
    orchestrateMock.resumeOrchestration
      .mockResolvedValueOnce(gateResult())
      .mockResolvedValueOnce(confirmResult())
      .mockResolvedValueOnce(gateResult())
      .mockResolvedValueOnce(doneResult('已完成。'));

    const agentRun = useAiAgentRun();
    const store = useAiAgentStore();
    const steps = createRunSteps();
    seedApprovedPlan(store, '实现 Step Runtime', steps);

    const waitingRun = await agentRun.runPlanToCompletion('实现 Step Runtime', steps, {
      context: [],
      workspaceRootPath: 'd:/com.xiaojianc/my_desktop_app',
    });

    expect(waitingRun.status).toBe('waiting-for-tool-confirmation');
    const confirmationId = store.pendingToolConfirmation?.id;
    expect(confirmationId).toBe('call-run-test');
    expect(agentRun.hasSidecarStepToolConfirmation(confirmationId ?? '')).toBe(true);

    const finalRun = await agentRun.resolveSidecarStepToolConfirmation(
      confirmationId ?? '',
      'allow-once',
    );

    expect(store.pendingToolConfirmation).toBeNull();
    expect(finalRun.status).toBe('completed');
    expect(decisionsOf()).toEqual(['approve', 'continue', 'approve', 'continue']);
  });

  it('取消中的 run 会忽略随后到达的完成结果', async () => {
    const deferred = createDeferred<ReturnType<typeof doneResult>>();
    orchestrateMock.resumeOrchestration.mockReturnValueOnce(deferred.promise);

    const agentRun = useAiAgentRun();
    const store = useAiAgentStore();
    const steps = createRunSteps();
    seedApprovedPlan(store, '实现 Step Runtime', steps);

    const runPromise = agentRun.runPlanToCompletion('实现 Step Runtime', steps, {
      context: [],
      workspaceRootPath: 'd:/com.xiaojianc/my_desktop_app',
    });
    await flushMicrotasks();

    const runId = store.activeRun?.id;
    expect(runId).toBeTruthy();

    orchestrateMock.resumeOrchestration.mockResolvedValueOnce(doneResult('取消确认完成。'));
    await agentRun.cancelRun(runId ?? '');
    deferred.resolve(doneResult('迟到的完成结果'));
    await runPromise;

    expect(store.activeRun?.status).toBe('cancelled');
    expect(store.activeRun?.steps[0]?.status).toBe('cancelled');
    expect(store.getStepFinalAnswers(runId ?? '')).toHaveLength(0);
  });

  it('暂停、继续、取消 run 都在本地回写 store', async () => {
    const agentRun = useAiAgentRun();
    const run = await agentRun.runPlan('实现 Step Runtime', createRunSteps());

    await agentRun.pauseRun(run.id);
    expect(agentRun.store.activeRun?.status).toBe('paused');

    await agentRun.resumeRun(run.id);
    expect(agentRun.store.activeRun?.status).toBe('running-step');

    await agentRun.cancelRun(run.id);
    expect(agentRun.store.activeRun?.status).toBe('cancelled');
  });

  it('解析未注册的工具确认会抛出错误', async () => {
    const agentRun = useAiAgentRun();
    await agentRun.runPlan('实现 Step Runtime', createRunSteps());

    await expect(
      agentRun.resolveToolConfirmation('agent-run-1', 'confirmation-1', 'skip'),
    ).rejects.toThrow('未找到对应的工具确认');
  });
});
