import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunStatusBar } from '@/components/ai-elements/run-status';
import type { IAiAgentRun, IAiToolConfirmationRequest } from '@/types/ai';

import AiThreadRunStatusBar from './AiThreadRunStatusBar.vue';

const createRun = (overrides: Partial<IAiAgentRun> = {}): IAiAgentRun => ({
  id: 'run-1',
  goal: '目标',
  status: 'running-step',
  steps: [
    {
      id: 'a',
      index: 0,
      title: '步骤 a',
      goal: '目标',
      kind: 'edit',
      status: 'running',
      expectedOutput: '产物',
      tools: [],
      requiresUserApproval: false,
      riskLevel: 'low',
    },
  ],
  currentStepId: 'a',
  createdAt: '2026-06-08T00:00:00.000Z',
  updatedAt: '2026-06-08T00:00:00.000Z',
  startedAt: '2026-06-08T00:00:00.000Z',
  completedAt: null,
  errorMessage: null,
  ...overrides,
});

const createConfirmation = (
  overrides: Partial<IAiToolConfirmationRequest> = {},
): IAiToolConfirmationRequest => ({
  id: 'conf-1',
  runId: 'run-1',
  stepId: 'step-1',
  toolName: 'auto_apply_patch',
  question: '是否允许写入文件？',
  summary: '将修改 2 个文件',
  riskLevel: 'medium',
  reversible: true,
  createdAt: '2026-06-08T00:00:00.000Z',
  options: [
    { id: 'allow-once', label: '允许', tone: 'primary' },
    { id: 'stop', label: '停止', tone: 'danger' },
  ],
  ...overrides,
});

describe('AiThreadRunStatusBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-08T00:00:05.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('无 run 无确认时不渲染状态条', () => {
    const wrapper = mount(AiThreadRunStatusBar, {
      props: { run: null, confirmation: null },
    });
    expect(wrapper.findComponent(RunStatusBar).exists()).toBe(false);
    wrapper.unmount();
  });

  it('运行中渲染状态条并转发 暂停 / 取消', async () => {
    const wrapper = mount(AiThreadRunStatusBar, {
      props: { run: createRun(), confirmation: null },
    });
    const bar = wrapper.findComponent(RunStatusBar);
    expect(bar.exists()).toBe(true);
    expect(bar.props('phase')).toBe('running');
    expect(bar.props('header')).toBe('执行步骤中');

    await wrapper.get('button[aria-label="暂停"]').trigger('click');
    await wrapper.get('button[aria-label="取消"]').trigger('click');

    expect(wrapper.emitted('pause')).toHaveLength(1);
    expect(wrapper.emitted('cancel')).toHaveLength(1);
    wrapper.unmount();
  });

  it('暂停态转发 继续', async () => {
    const wrapper = mount(AiThreadRunStatusBar, {
      props: { run: createRun({ status: 'paused' }), confirmation: null },
    });

    await wrapper.get('button[aria-label="继续"]').trigger('click');

    expect(wrapper.emitted('resume')).toHaveLength(1);
    wrapper.unmount();
  });

  it('有工具确认时进入确认态并转发决定', async () => {
    const wrapper = mount(AiThreadRunStatusBar, {
      props: {
        run: createRun({ status: 'waiting-for-tool-confirmation' }),
        confirmation: createConfirmation(),
      },
    });
    const bar = wrapper.findComponent(RunStatusBar);
    expect(bar.props('phase')).toBe('awaiting-confirmation');

    const allowButton = wrapper
      .findAll('button')
      .find((button) => button.text().includes('允许'));
    await allowButton?.trigger('click');

    expect(wrapper.emitted('resolve')?.[0]).toEqual(['allow-once']);
    wrapper.unmount();
  });
});
