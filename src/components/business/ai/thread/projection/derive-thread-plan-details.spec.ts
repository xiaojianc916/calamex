import { describe, expect, it } from 'vitest';

import type { IAiTaskPlanStep } from '@/types/ai';

import {
  deriveThreadPlanDetails,
  type IThreadPlanDetailsInput,
  THREAD_PLAN_MAX_APPROVABLE_STEPS,
  THREAD_PLAN_MIN_APPROVABLE_STEPS,
} from './derive-thread-plan-details';

const createStep = (id: string): IAiTaskPlanStep => ({
  id,
  index: 0,
  title: `步骤 ${id}`,
  goal: '目标',
  kind: 'edit',
  status: 'pending',
  expectedOutput: '产物',
  tools: [],
  requiresUserApproval: false,
  riskLevel: 'low',
});

const createInput = (
  overrides: Partial<IThreadPlanDetailsInput> = {},
): IThreadPlanDetailsInput => ({
  summary: '计划摘要',
  status: 'draft',
  steps: [createStep('a'), createStep('b'), createStep('c')],
  isPlanning: false,
  isApproving: false,
  isClassifying: false,
  approvedAt: null,
  hasActiveRun: false,
  ...overrides,
});

describe('deriveThreadPlanDetails', () => {
  it('草稿态且步骤数合规时可批准且可编辑', () => {
    const details = deriveThreadPlanDetails(createInput());
    expect(details.canApprove).toBe(true);
    expect(details.canEdit).toBe(true);
  });

  it('原样透传摘要 / 状态 / 步骤 / 进行态 / 批准时间', () => {
    const steps = [createStep('a'), createStep('b')];
    const details = deriveThreadPlanDetails(
      createInput({
        summary: null,
        status: 'pending_approval',
        steps,
        isPlanning: true,
        isApproving: true,
        approvedAt: '2026-06-08T00:00:00.000Z',
      }),
    );
    expect(details.summary).toBeNull();
    expect(details.status).toBe('pending_approval');
    expect(details.steps).toEqual(steps);
    expect(details.isPlanning).toBe(true);
    expect(details.isApproving).toBe(true);
    expect(details.approvedAt).toBe('2026-06-08T00:00:00.000Z');
  });

  it('返回的步骤是输入的浅拷贝,不与输入共享引用', () => {
    const input = createInput();
    const details = deriveThreadPlanDetails(input);
    expect(details.steps).not.toBe(input.steps);
    expect(details.steps).toEqual([...input.steps]);
  });

  it('pending_approval 可批准但不可编辑(非草稿态)', () => {
    const details = deriveThreadPlanDetails(createInput({ status: 'pending_approval' }));
    expect(details.canApprove).toBe(true);
    expect(details.canEdit).toBe(false);
  });

  it('状态为 null 视为草稿态,可批准且可编辑', () => {
    const details = deriveThreadPlanDetails(createInput({ status: null }));
    expect(details.canApprove).toBe(true);
    expect(details.canEdit).toBe(true);
  });

  it('步骤数低于下限时不可批准', () => {
    const steps = Array.from({ length: THREAD_PLAN_MIN_APPROVABLE_STEPS - 1 }, (_, index) =>
      createStep(`s${index}`),
    );
    expect(deriveThreadPlanDetails(createInput({ steps })).canApprove).toBe(false);
  });

  it('步骤数高于上限时不可批准', () => {
    const steps = Array.from({ length: THREAD_PLAN_MAX_APPROVABLE_STEPS + 1 }, (_, index) =>
      createStep(`s${index}`),
    );
    expect(deriveThreadPlanDetails(createInput({ steps })).canApprove).toBe(false);
  });

  it('已有活动 run 时既不可批准也不可编辑', () => {
    const details = deriveThreadPlanDetails(createInput({ hasActiveRun: true }));
    expect(details.canApprove).toBe(false);
    expect(details.canEdit).toBe(false);
  });

  it('已批准时既不可批准也不可编辑', () => {
    const details = deriveThreadPlanDetails(
      createInput({ approvedAt: '2026-06-08T00:00:00.000Z' }),
    );
    expect(details.canApprove).toBe(false);
    expect(details.canEdit).toBe(false);
  });

  it('生成 / 批准 / 分类进行中时不可编辑但仍可批准', () => {
    expect(deriveThreadPlanDetails(createInput({ isPlanning: true })).canEdit).toBe(false);
    expect(deriveThreadPlanDetails(createInput({ isApproving: true })).canEdit).toBe(false);
    expect(deriveThreadPlanDetails(createInput({ isClassifying: true })).canEdit).toBe(false);
    expect(deriveThreadPlanDetails(createInput({ isPlanning: true })).canApprove).toBe(true);
  });

  it('被拒绝状态既不可批准也不可编辑', () => {
    const details = deriveThreadPlanDetails(createInput({ status: 'rejected' }));
    expect(details.canApprove).toBe(false);
    expect(details.canEdit).toBe(false);
  });
});
