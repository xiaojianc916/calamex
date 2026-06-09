import { describe, expect, it } from 'vitest';

import type { IAiTaskPlanStep, IAiToolConfirmationRequest, TAiAgentRunStatus } from '@/types/ai';

import { deriveRunStatus, describeAgentRunStatus, type IRunStatusInput } from './derive-run-status';

const createStep = (id: string, status: IAiTaskPlanStep['status']): IAiTaskPlanStep => ({
  id,
  index: 0,
  title: `步骤 ${id}`,
  goal: '目标',
  kind: 'edit',
  status,
  expectedOutput: '产物',
  tools: [],
  requiresUserApproval: false,
  riskLevel: 'low',
});

const createConfirmation = (
  overrides: Partial<IAiToolConfirmationRequest> = {},
): IAiToolConfirmationRequest => ({
  id: 'confirm-1',
  runId: 'run-1',
  stepId: 'step-1',
  toolName: 'auto_apply_patch',
  question: '允许写入文件?',
  summary: '将写入 src/app.ts',
  riskLevel: 'medium',
  reversible: true,
  createdAt: '2026-06-08T00:00:00.000Z',
  options: [
    { id: 'allow-once', label: '允许', tone: 'primary' },
    { id: 'stop', label: '停止', tone: 'danger' },
  ],
  ...overrides,
});

const createInput = (overrides: Partial<IRunStatusInput> = {}): IRunStatusInput => ({
  run: null,
  confirmation: null,
  ...overrides,
});

describe('describeAgentRunStatus', () => {
  it('覆盖全部 run 状态文案', () => {
    const expected: Record<TAiAgentRunStatus, string> = {
      'waiting-for-plan-approval': '等待批准',
      'running-plan': '运行中',
      'running-step': '执行步骤中',
      'waiting-for-tool-confirmation': '等待工具确认',
      paused: '可继续',
      completed: '已完成',
      failed: '失败',
      cancelled: '已取消',
    };
    for (const [status, label] of Object.entries(expected)) {
      expect(describeAgentRunStatus(status as TAiAgentRunStatus)).toBe(label);
    }
  });
});

describe('deriveRunStatus', () => {
  it('无 run 无确认时不呈现状态条', () => {
    expect(deriveRunStatus(createInput())).toBeNull();
  });

  it('有可见工具确认时进入 awaiting-confirmation 并禁用运行控制', () => {
    const confirmation = createConfirmation();
    const result = deriveRunStatus(
      createInput({
        run: {
          status: 'waiting-for-tool-confirmation',
          steps: [createStep('a', 'done'), createStep('b', 'running')],
        },
        confirmation,
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.phase).toBe('awaiting-confirmation');
    expect(result?.header).toBe('允许写入文件?');
    expect(result?.detail).toBe('将写入 src/app.ts');
    expect(result?.confirmation).toBe(confirmation);
    expect(result?.progress).toEqual({ done: 1, total: 2 });
    expect(result?.canPause).toBe(false);
    expect(result?.canResume).toBe(false);
    expect(result?.canCancel).toBe(false);
  });

  it('确认存在但无 run 时进度为 null', () => {
    const result = deriveRunStatus(createInput({ confirmation: createConfirmation() }));
    expect(result?.phase).toBe('awaiting-confirmation');
    expect(result?.progress).toBeNull();
  });

  it('确认摘要为空白时 detail 归 null', () => {
    const result = deriveRunStatus(
      createInput({ confirmation: createConfirmation({ summary: '   ' }) }),
    );
    expect(result?.detail).toBeNull();
  });

  it('暂停态:仅可继续 / 取消', () => {
    const result = deriveRunStatus(
      createInput({ run: { status: 'paused', steps: [createStep('a', 'done')] } }),
    );
    expect(result?.phase).toBe('paused');
    expect(result?.header).toBe('可继续');
    expect(result?.detail).toBeNull();
    expect(result?.progress).toEqual({ done: 1, total: 1 });
    expect(result?.canPause).toBe(false);
    expect(result?.canResume).toBe(true);
    expect(result?.canCancel).toBe(true);
  });

  it('运行中(running-plan):可暂停 / 取消,细节为当前运行步骤', () => {
    const result = deriveRunStatus(
      createInput({
        run: {
          status: 'running-plan',
          steps: [createStep('a', 'done'), createStep('b', 'running')],
        },
      }),
    );
    expect(result?.phase).toBe('running');
    expect(result?.header).toBe('运行中');
    expect(result?.detail).toBe('步骤 b');
    expect(result?.progress).toEqual({ done: 1, total: 2 });
    expect(result?.canPause).toBe(true);
    expect(result?.canResume).toBe(false);
    expect(result?.canCancel).toBe(true);
  });

  it('运行中(running-step)无运行步骤时 detail 归 null', () => {
    const result = deriveRunStatus(
      createInput({
        run: { status: 'running-step', steps: [createStep('a', 'pending')] },
      }),
    );
    expect(result?.phase).toBe('running');
    expect(result?.header).toBe('执行步骤中');
    expect(result?.detail).toBeNull();
  });

  it('等待计划批准且无确认时不呈现(交由时间线内联审批)', () => {
    expect(
      deriveRunStatus(createInput({ run: { status: 'waiting-for-plan-approval', steps: [] } })),
    ).toBeNull();
  });

  it.each<TAiAgentRunStatus>([
    'completed',
    'failed',
    'cancelled',
  ])('终态 %s 不呈现状态条', (status) => {
    expect(
      deriveRunStatus(createInput({ run: { status, steps: [createStep('a', 'done')] } })),
    ).toBeNull();
  });
});
