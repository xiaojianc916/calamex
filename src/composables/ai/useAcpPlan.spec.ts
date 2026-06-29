import { describe, expect, it } from 'vitest';

import type { TAcpPlan } from '@/types/ai/acp-tool-call';

import { useAcpPlan } from './useAcpPlan';

const makePlan = (entries: unknown): TAcpPlan =>
  ({ sessionUpdate: 'plan', entries }) as unknown as TAcpPlan;

describe('useAcpPlan', () => {
  it('全量快照整份替换（后到覆盖前者）', () => {
    const plan = useAcpPlan();
    plan.applyPlanUpdate(
      makePlan([
        { content: 'A', status: 'completed' },
        { content: 'B', status: 'in_progress' },
      ]),
    );
    expect(plan.hasPlan.value).toBe(true);
    expect(plan.steps.value.map((step) => [step.title, step.status])).toEqual([
      ['A', 'done'],
      ['B', 'running'],
    ]);

    plan.applyPlanUpdate(makePlan([{ content: 'C', status: 'pending' }]));
    expect(plan.steps.value.map((step) => step.title)).toEqual(['C']);
  });

  it('空快照合法清空（agent 主动清计划）', () => {
    const plan = useAcpPlan();
    plan.applyPlanUpdate(makePlan([{ content: 'A', status: 'pending' }]));
    plan.applyPlanUpdate(makePlan([]));
    expect(plan.steps.value).toEqual([]);
    expect(plan.hasPlan.value).toBe(false);
  });

  it('坏帧（entries 非数组）no-op，保留既有快照', () => {
    const plan = useAcpPlan();
    plan.applyPlanUpdate(makePlan([{ content: 'A', status: 'pending' }]));
    plan.applyPlanUpdate(makePlan(undefined));
    plan.applyPlanUpdate(makePlan('nope' as unknown));
    expect(plan.steps.value.map((step) => step.title)).toEqual(['A']);
  });

  it('reset 清空', () => {
    const plan = useAcpPlan();
    plan.applyPlanUpdate(makePlan([{ content: 'A', status: 'pending' }]));
    plan.reset();
    expect(plan.steps.value).toEqual([]);
    expect(plan.hasPlan.value).toBe(false);
  });
});
