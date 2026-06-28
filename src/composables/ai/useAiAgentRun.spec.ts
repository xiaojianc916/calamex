import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAiAgentRun } from '@/composables/ai/useAiAgentRun';
import { useAiAgentStore } from '@/store/aiAgent';
import type { IAiTaskPlanStep } from '@/types/ai';
import type { IAgentSidecarResponsePayload, TAgentUiEvent } from '@/types/ai/sidecar';

// 原生管线:执行 = 单次 sidecarChat(mode='agent') 回合,后端一次跑到完成 /
// 工具审批挂起 / 出错;审批续跑走 sidecarResolveApproval(decision)。
const aiServiceMock = vi.hoisted(() => {
  const sidecarChat = vi.fn();
  const sidecarResolveApproval = vi.fn();

  return {
    sidecarChat,
    sidecarResolveApproval,
    reset(): void {
      sidecarChat.mockReset();
      sidecarResolveApproval.mockReset();
    },
  };
});

vi.mock('@/services/ipc/ai.service', () => ({
  aiService: {
    sidecarChat: aiServiceMock.sidecarChat,
    sidecarResolveApproval: aiServiceMock.sidecarResolveApproval,
  },
}));

vi.mock('@/composables/useSidecarChangedDocumentRefresh', () => ({
  useSidecarChangedDocumentRefresh: () => ({
    refreshSidecarChangedDocuments: vi.fn().mockResolvedValue({
      skippedDirtyNames: [],
      failedNames: [],
    }),
  }),
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

const makeResponse = (
  events: TAgentUiEvent[],
  result: string | null = null,
  sessionId = 'sidecar-run-session-1',
): IAgentSidecarResponsePayload => ({ sessionId, events, result });

const doneEvent = (result: string): TAgentUiEvent => ({ type: 'done', result });

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

const resolveDecisions = (): Array<string | undefined> =>
  aiServiceMock.sidecarResolveApproval.mock.calls.map((call) => call[0]?.decision);

describe('useAiAgentRun', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    aiServiceMock.reset();
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

  it('批准后单次原生回合跑到完成并记录最终回复', async () => {
    aiServiceMock.sidecarChat.mockResolvedValueOnce(makeResponse([doneEvent('计划已完成。')]));

    const agentRun = useAiAgentRun();
    const store = useAiAgentStore();
    const steps = createRunSteps();

    const run = await agentRun.runPlanToCompletion('实现 Step Runtime', steps, {
      context: [],
      workspaceRootPath: 'd:/com.xiaojianc/my_desktop_app',
    });

    expect(aiServiceMock.sidecarChat).toHaveBeenCalledTimes(1);
    expect(aiServiceMock.sidecarChat).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'agent', goal: '实现 Step Runtime' }),
    );
    expect(run.status).toBe('completed');
    expect(store.activeRun?.steps.map((step) => step.status)).toEqual(['done', 'done']);
    expect(store.getStepFinalAnswers(run.id).map((answer) => answer.content)).toEqual([
      '计划已完成。',
    ]);
  });

  it('高风险工具挂起后，确认放行可继续跑到完成', async () => {
    aiServiceMock.sidecarChat.mockResolvedValueOnce(makeResponse([approvalEvent]));
    aiServiceMock.sidecarResolveApproval.mockResolvedValueOnce(makeResponse([doneEvent('已完成。')]));

    const agentRun = useAiAgentRun();
    const store = useAiAgentStore();
    const steps = createRunSteps();

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
    expect(resolveDecisions()).toEqual(['approve']);
    expect(aiServiceMock.sidecarResolveApproval).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'call-run-test', decision: 'approve' }),
    );
  });

  it('取消中的 run 会忽略随后到达的完成结果', async () => {
    const deferred = createDeferred<IAgentSidecarResponsePayload>();
    aiServiceMock.sidecarChat.mockReturnValueOnce(deferred.promise);

    const agentRun = useAiAgentRun();
    const store = useAiAgentStore();
    const steps = createRunSteps();

    const runPromise = agentRun.runPlanToCompletion('实现 Step Runtime', steps, {
      context: [],
      workspaceRootPath: 'd:/com.xiaojianc/my_desktop_app',
    });
    await flushMicrotasks();

    const runId = store.activeRun?.id;
    expect(runId).toBeTruthy();

    await agentRun.cancelRun(runId ?? '');
    deferred.resolve(makeResponse([doneEvent('迟到的完成结果')]));
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
