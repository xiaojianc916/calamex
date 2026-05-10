import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import AiPlanModePanel from '@/components/business/ai/AiPlanModePanel.vue';
import type { IAiAgentPlanVersionSummary, IAiAgentRun, IAiTaskPlanStep } from '@/types/ai';

const createStep = (index: number): IAiTaskPlanStep => ({
  id: `plan-step-${index + 1}`,
  index,
  title: index === 0 ? '收集上下文' : '输出方案',
  goal: index === 0 ? '收集上下文' : '输出方案',
  kind: index === 0 ? 'inspect' : 'summarize',
  status: 'pending',
  expectedOutput: index === 0 ? '影响范围' : '实施计划',
  tools: index === 0 ? ['search_text'] : ['get_diagnostics'],
  requiresUserApproval: false,
  riskLevel: 'low',
});

const createRun = (
  steps: IAiTaskPlanStep[],
  overrides: Partial<IAiAgentRun> = {},
): IAiAgentRun => ({
  id: 'agent-run-1',
  goal: '接入 Agent Plan Mode',
  status: 'running-plan',
  steps,
  currentStepId: null,
  createdAt: '2026-04-29T10:00:00.000Z',
  updatedAt: '2026-04-29T10:00:00.000Z',
  startedAt: '2026-04-29T10:00:00.000Z',
  completedAt: null,
  errorMessage: null,
  ...overrides,
});

const createPlanVersion = (
  version: number,
  status: IAiAgentPlanVersionSummary['status'],
): IAiAgentPlanVersionSummary => ({
  planId: 'plan-audit-1',
  threadId: 'thread-audit-1',
  version,
  status,
  createdAt: '2026-04-29T10:00:00.000Z',
  updatedAt: `2026-04-29T10:0${version}:00.000Z`,
  approvedAt: status === 'approved' ? '2026-04-29T10:02:00.000Z' : null,
  executedAt: null,
  rejectionReason: status === 'rejected' ? '需要调整范围' : null,
  errorMessage: null,
  summary: `第 ${version} 版计划`,
  requiresApproval: true,
  userRequest: '接入 Agent Plan Mode',
});

const mountPanel = (overrides: Partial<InstanceType<typeof AiPlanModePanel>['$props']> = {}) =>
  mount(AiPlanModePanel, {
    props: {
      goal: '接入 Agent Plan Mode',
      steps: [createStep(0), createStep(1), createStep(2)],
      classificationReason: '任务包含多阶段动作或潜在写盘影响，需先计划后执行。',
      errorMessage: '',
      isPlanning: false,
      isApproving: false,
      approvedAt: null,
      activeRun: null,
      isRunActionPending: false,
      ...overrides,
    },
  });

const findButtonByText = (
  wrapper: ReturnType<typeof mountPanel>,
  label: string,
) => {
  const button = wrapper.findAll('button').find((item) => item.text() === label);

  if (!button) {
    throw new Error(`找不到按钮：${label}`);
  }

  return button;
};

describe('AiPlanModePanel', () => {
  it('在分类阶段先显示输入框上方的计划生成状态', () => {
    const wrapper = mountPanel({
      steps: [],
      isClassifying: true,
    });

    expect(wrapper.text()).toContain('待办事项');
    expect(wrapper.text()).toContain('正在判断是否需要计划');
    expect(wrapper.find('.ai-plan-status-icon').exists()).toBe(true);
  });

  it('展示计划步骤并支持批准计划', async () => {
    const wrapper = mountPanel();

    expect(wrapper.text()).toContain('待办事项(0/3)');
    const titleInputs = wrapper.findAll<HTMLInputElement>('input[aria-label="编辑计划步骤标题"]');
    expect(titleInputs[0]?.element.value).toBe('收集上下文');
    expect(titleInputs[1]?.element.value).toBe('输出方案');

    await wrapper.find('.ai-plan-button.is-primary').trigger('click');

    expect(wrapper.emitted('approve')).toHaveLength(1);
  });

  it('收起待办事项框后隐藏计划内容和运行按钮', async () => {
    const steps = [createStep(0), createStep(1), createStep(2)];
    const wrapper = mountPanel({
      steps,
      approvedAt: '2026-04-29T10:00:00.000Z',
      activeRun: createRun(steps),
    });

    expect(wrapper.get('.ai-plan-title-button').attributes('aria-expanded')).toBe('true');
    expect(wrapper.find('.ai-plan-body').exists()).toBe(true);
    expect(wrapper.text()).toContain('执行下一步');

    await wrapper.get('.ai-plan-title-button').trigger('click');

    expect(wrapper.get('.ai-plan-title-button').attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('.ai-plan-body').exists()).toBe(false);
    expect(wrapper.text()).toContain('待办事项(0/3)');
    expect(wrapper.text()).not.toContain('执行下一步');

    await wrapper.get('.ai-plan-title-button').trigger('click');

    expect(wrapper.get('.ai-plan-title-button').attributes('aria-expanded')).toBe('true');
    expect(wrapper.find('.ai-plan-body').exists()).toBe(true);
  });

  it('计划已批准后禁用批准按钮并展示待执行说明', async () => {
    const steps = [createStep(0), createStep(1), createStep(2)];
    const wrapper = mountPanel({
      steps,
      approvedAt: '2026-04-29T10:00:00.000Z',
      activeRun: createRun(steps),
    });

    const approveButton = findButtonByText(wrapper, '已批准');

    expect(wrapper.text()).toContain('运行中');
    expect(approveButton.attributes('disabled')).toBeDefined();
  });

  it('编辑标题和删除步骤时向外抛出事件', async () => {
    const wrapper = mountPanel();
    const input = wrapper.find('input[aria-label="编辑计划步骤标题"]');

    await input.setValue('重新收集上下文');
    await input.trigger('keydown.enter');

    expect(wrapper.emitted('updateStepTitle')).toEqual([
      ['plan-step-1', '重新收集上下文'],
    ]);

    await wrapper.find('.ai-plan-step-remove').trigger('click');

    expect(wrapper.emitted('removeStep')).toEqual([
      ['plan-step-1'],
    ]);
  });

  it('持久化后的待审批计划禁用本地编辑以避免审批快照偏离', () => {
    const wrapper = mountPanel({
      planStatus: 'pending_approval',
    });
    const input = wrapper.find('input[aria-label="编辑计划步骤标题"]');

    expect(input.attributes('disabled')).toBeDefined();
    expect(wrapper.find('.ai-plan-step-remove').attributes('disabled')).toBeDefined();
  });

  it('展示计划审计元数据和版本记录', () => {
    const wrapper = mountPanel({
      planId: 'plan-audit-123456789',
      planVersion: 2,
      planThreadId: 'thread-audit-1',
      planStatus: 'rejected',
      planUpdatedAt: '2026-04-29T10:02:00.000Z',
      planRejectionReason: '需要调整范围',
      planVersions: [
        createPlanVersion(2, 'rejected'),
        createPlanVersion(1, 'approved'),
      ],
    });

    expect(wrapper.text()).toContain('计划');
    expect(wrapper.text()).toContain('v2');
    expect(wrapper.text()).toContain('已拒绝');
    expect(wrapper.text()).toContain('拒绝原因：需要调整范围');
    expect(wrapper.text()).toContain('v1 · 已批准');
  });

  it('展示运行状态并支持推进、暂停、取消 run', async () => {
    const steps = [createStep(0), createStep(1), createStep(2)];
    const wrapper = mountPanel({
      steps,
      approvedAt: '2026-04-29T10:00:00.000Z',
      activeRun: createRun(steps),
    });

    expect(wrapper.text()).toContain('运行中');
    expect(wrapper.text()).toContain('0/3 步');

    await findButtonByText(wrapper, '执行下一步').trigger('click');
    await findButtonByText(wrapper, '暂停').trigger('click');
    await findButtonByText(wrapper, '取消').trigger('click');

    expect(wrapper.emitted('runStep')).toHaveLength(1);
    expect(wrapper.emitted('pauseRun')).toHaveLength(1);
    expect(wrapper.emitted('cancelRun')).toHaveLength(1);
  });

  it('有工具确认待处理时禁用继续执行按钮', () => {
    const steps = [createStep(0), createStep(1), createStep(2)];
    const wrapper = mountPanel({
      steps,
      approvedAt: '2026-04-29T10:00:00.000Z',
      activeRun: createRun(steps),
      toolConfirmation: {
        id: 'provider-confirmation-1',
        runId: 'agent-run-1',
        stepId: 'plan-step-1',
        toolName: 'run_test',
        question: '允许 Agent 使用 run_test 吗？',
        summary: '步骤请求运行测试。',
        riskLevel: 'medium',
        reversible: true,
        createdAt: '2026-04-29T10:00:00.000Z',
        options: [],
      },
    });

    expect(findButtonByText(wrapper, '执行下一步').attributes('disabled')).toBeDefined();
  });

  it('在计划下方展示当前 Web 工具活动', () => {
    const wrapper = mountPanel({
      webActivity: {
        id: 'web-activity-1',
        state: 'searching',
        label: '正在搜索…',
        queryPreview: 'Tauri docs',
        stepId: 'plan-step-1',
      },
    });

    expect(wrapper.text()).toContain('Tauri docs');
    expect(wrapper.find('.ai-web-activity-spinner').exists()).toBe(true);
  });

  it('在计划下方实时展示当前普通工具活动', () => {
    const wrapper = mountPanel({
      toolActivity: {
        id: 'tool-activity-1',
        stepId: 'plan-step-1',
        toolName: 'read_current_file',
        state: 'running',
        label: '正在读取当前文件…',
        startedAt: '2026-04-29T10:00:00.000Z',
      },
    });

    expect(wrapper.text()).toContain('正在读取当前文件…');
    expect(wrapper.find('.ai-plan-status-icon').exists()).toBe(true);
  });
});
