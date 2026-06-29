import { describe, expect, it } from 'vitest';

import type { TAcpPlan } from '@/types/ai/acp-tool-call';

import { mapAcpPlanToTaskSteps } from './from-acp-plan';

const makePlan = (entries: unknown): TAcpPlan =>
  ({ sessionUpdate: 'plan', entries }) as unknown as TAcpPlan;

describe('mapAcpPlanToTaskSteps', () => {
  it('按顺序把 ACP plan entries 归一为线程步骤（含状态映射）', () => {
    const steps = mapAcpPlanToTaskSteps(
      makePlan([
        { content: '读取代码', priority: 'high', status: 'completed' },
        { content: '修改实现', priority: 'medium', status: 'in_progress' },
        { content: '运行测试', priority: 'low', status: 'pending' },
      ]),
    );

    expect(steps.map((step) => [step.index, step.title, step.status])).toEqual([
      [0, '读取代码', 'done'],
      [1, '修改实现', 'running'],
      [2, '运行测试', 'pending'],
    ]);
    expect(steps[0]?.id).toBe('acp-plan-step:0');
    expect(steps[0]?.tools).toEqual([]);
    expect(steps[0]?.requiresUserApproval).toBe(false);
  });

  it('content 空白时回退占位标题', () => {
    const steps = mapAcpPlanToTaskSteps(makePlan([{ content: '   ', status: 'pending' }]));
    expect(steps[0]?.title).toBe('步骤 1');
  });

  it('entries 缺失 / 非数组时返回空数组', () => {
    expect(mapAcpPlanToTaskSteps(makePlan(undefined))).toEqual([]);
    expect(mapAcpPlanToTaskSteps(makePlan('nope' as unknown))).toEqual([]);
  });

  it('跳过非对象 entry', () => {
    expect(mapAcpPlanToTaskSteps(makePlan([null, 42, 'x']))).toEqual([]);
  });

  it('未知 status 兜底为 pending', () => {
    const steps = mapAcpPlanToTaskSteps(makePlan([{ content: 'x', status: 'weird' }]));
    expect(steps[0]?.status).toBe('pending');
  });
});
