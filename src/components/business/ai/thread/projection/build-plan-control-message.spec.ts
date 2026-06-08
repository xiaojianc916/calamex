import { describe, expect, it } from 'vitest';

import type { IAiContextReference } from '@/types/ai/context';

import {
  buildPlanControlMessage,
  type IPlanControlMessageInput,
  PLAN_CONTROL_MESSAGE_ID,
} from './build-plan-control-message';

const createReference = (id: string): IAiContextReference => ({
  id,
  kind: 'current-file',
  label: `引用 ${id}`,
  path: `src/${id}.ts`,
  range: null,
  contentPreview: '',
  redacted: false,
});

const createInput = (
  overrides: Partial<IPlanControlMessageInput> = {},
): IPlanControlMessageInput => ({
  goal: '重构时间线渲染',
  references: [],
  isAwaitingApproval: true,
  createdAt: '2026-06-08T00:00:00.000Z',
  ...overrides,
});

describe('buildPlanControlMessage', () => {
  it('非等待批准阶段时返回 null', () => {
    expect(buildPlanControlMessage(createInput({ isAwaitingApproval: false }))).toBeNull();
  });

  it('目标为空白时返回 null', () => {
    expect(buildPlanControlMessage(createInput({ goal: '   ' }))).toBeNull();
  });

  it('等待批准时产出承载 agentConfirmation 的合成 assistant 消息', () => {
    const message = buildPlanControlMessage(createInput());
    expect(message).not.toBeNull();
    expect(message?.id).toBe(PLAN_CONTROL_MESSAGE_ID);
    expect(message?.role).toBe('assistant');
    expect(message?.content).toBe('');
    expect(message?.createdAt).toBe('2026-06-08T00:00:00.000Z');
    expect(message?.references).toEqual([]);
    expect(message?.agentConfirmation?.status).toBe('pending');
    expect(message?.agentConfirmation?.goal).toBe('重构时间线渲染');
  });

  it('目标去除首尾空白后写入 agentConfirmation', () => {
    const message = buildPlanControlMessage(createInput({ goal: '  优化状态条  ' }));
    expect(message?.agentConfirmation?.goal).toBe('优化状态条');
  });

  it('引用被拷贝进 agentConfirmation,不与输入共享数组引用', () => {
    const references = [createReference('a'), createReference('b')];
    const message = buildPlanControlMessage(createInput({ references }));
    expect(message?.agentConfirmation?.references).toEqual(references);
    expect(message?.agentConfirmation?.references).not.toBe(references);
  });
});
