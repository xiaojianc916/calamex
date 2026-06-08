import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import AiPlanModeThread from '@/components/business/ai/plan/AiPlanModeThread.vue';
import type { IAiAgentRun, IAiTaskPlanStep } from '@/types/ai';

class ResizeObserverMock {
  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock);

const createStep = (index: number, overrides: Partial<IAiTaskPlanStep> = {}): IAiTaskPlanStep => ({
  id: `plan-step-${index + 1}`,
  index,
  title: index === 0 ? '收集上下文' : '修改代码',
  goal: index === 0 ? '确认现有实现和风险' : '落地高质量改动',
  kind: index === 0 ? 'inspect' : 'edit',
  status: 'pending',
  expectedOutput: index === 0 ? '影响范围' : '代码提交',
  tools: index === 0 ? ['search_text'] : ['auto_apply_patch'],
  requiresUserApproval: false,
  riskLevel: 'low',
  ...overrides,
});

const createRun = (steps: IAiTaskPlanStep[], overrides: Partial<IAiAgentRun> = {}): IAiAgentRun => ({
  id: 'agent-run-1',
  goal: '重构 Agent UI',
  status: 'running-plan',
  steps,
  currentStepId: steps[1]?.id ?? null,
  createdAt: '2026-04-29T10:00:00.000Z',
  updatedAt: '2026-04-29T10:00:00.000Z',
  startedAt: '2026-04-29T10:00:00.000Z',
  completedAt: null,
  errorMessage: null,
  ...overrides,
});

const mountThread = (overrides: Partial<InstanceType<typeof AiPlanModeThread>['$props']> = {}) =>
  mount(AiPlanModeThread, {
    props: {
      goal: '重构 Agent UI',
      summary: '先规划，再执行。',
      status: 'pending_approval',
      steps: [createStep(0), createStep(1), createStep(2)],
      isClassifying: false,
      isPlanning: false,
      isApproving: false,
      canEdit: true,
      canApprove: true,
      approvedAt: null,
      activeRun: null,
      ...overrides,
    },
    global: {
      stubs: {
        AiErrorNotice: {
          props: ['message'],
          template: '<div class="error-stub" v-text="message" />',
        },
      },
    },
  });

describe('AiPlanModeThread', () => {
  it('renders a dedicated Plan empty state without ChatThread bubbles', () => {
    const wrapper = mountThread({ steps: [], status: null, summary: null });

    expect(wrapper.find('.ai-plan-mode-thread').exists()).toBe(true);
    expect(wrapper.text()).toContain('Plan 尚未开始');
    expect(wrapper.find('.ai-chat-list').exists()).toBe(false);
  });

  it('renders plan approval as structured Plan surface', () => {
    const wrapper = mountThread();

    expect(wrapper.find('.ai-plan-thread-activity').exists()).toBe(true);
    expect(wrapper.text()).toContain('等待确认计划');
    expect(wrapper.text()).toContain('步骤');
    expect(wrapper.text()).toContain('收集上下文');
    expect(wrapper.text()).toContain('修改代码');
    expect(wrapper.find('.ai-plan-thread-confirmation').exists()).toBe(true);
    expect(wrapper.find('.ai-plan-thread-confirmation.is-standalone').exists()).toBe(true);
  });

  it('renders active run progress as the Plan run panel', () => {
    const steps = [
      createStep(0, { status: 'done' }),
      createStep(1, { status: 'running' }),
      createStep(2, { status: 'pending' }),
    ];
    const wrapper = mountThread({
      steps,
      approvedAt: '2026-04-29T10:00:00.000Z',
      activeRun: createRun(steps),
    });

    expect(wrapper.text()).toContain('计划执行中');
    expect(wrapper.text()).toContain('修改代码');
    expect(wrapper.text()).toContain('完成');
    expect(wrapper.find('.ai-plan-thread-run-panel').exists()).toBe(true);
    expect(wrapper.find('.ai-plan-thread-readonly').exists()).toBe(false);
    expect(wrapper.find('.ai-plan-thread-confirmation').exists()).toBe(false);
  });

  it('forwards plan confirmation actions without going through chat slots', async () => {
    const wrapper = mountThread();

    await wrapper.get('button[aria-label="删除计划步骤"]').trigger('click');

    expect(wrapper.emitted('removeStep')).toEqual([['plan-step-1']]);
  });

  it('renders plan errors in the plan surface', () => {
    const wrapper = mountThread({ errorMessage: '计划生成失败：上下文不足。' });

    expect(wrapper.find('.error-stub').exists()).toBe(true);
    expect(wrapper.text()).toContain('计划生成失败：上下文不足。');
  });
});
