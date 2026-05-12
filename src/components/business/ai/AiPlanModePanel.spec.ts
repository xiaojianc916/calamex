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

describe('AiPlanModePanel', () => {
  it('分类阶段不在输入框上方渲染计划生成文案', () => {
    const wrapper = mountPanel({
      steps: [],
      isClassifying: true,
    });

    expect(wrapper.text()).toContain('执行进度');
    expect(wrapper.text()).not.toContain('正在判断是否需要计划');
    expect(wrapper.find('.ai-plan-step-queue').exists()).toBe(false);
  });

  it('只展示执行步骤和进度，不承载计划审批动作', async () => {
    const wrapper = mountPanel();

    expect(wrapper.text()).toContain('执行进度(0/3)');
    expect(wrapper.text()).toContain('收集上下文');
    expect(wrapper.text()).toContain('输出方案');
    expect(wrapper.find('input[aria-label="编辑计划步骤标题"]').exists()).toBe(false);
    expect(wrapper.findAll('button').some((button) => button.text() === '批准并启动')).toBe(false);
  });

  it('收起执行进度后隐藏步骤队列', async () => {
    const steps = [createStep(0), createStep(1), createStep(2)];
    const wrapper = mountPanel({
      steps,
      approvedAt: '2026-04-29T10:00:00.000Z',
      activeRun: createRun(steps),
    });

    expect(wrapper.get('.ai-plan-title-button').attributes('aria-expanded')).toBe('true');
    expect(wrapper.find('.ai-plan-body').exists()).toBe(true);
    expect(wrapper.text()).toContain('收集上下文');

    await wrapper.get('.ai-plan-title-button').trigger('click');

    expect(wrapper.get('.ai-plan-title-button').attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('.ai-plan-body').exists()).toBe(false);
    expect(wrapper.text()).toContain('执行进度(0/3)');
    expect(wrapper.text()).not.toContain('收集上下文');

    await wrapper.get('.ai-plan-title-button').trigger('click');

    expect(wrapper.get('.ai-plan-title-button').attributes('aria-expanded')).toBe('true');
    expect(wrapper.find('.ai-plan-body').exists()).toBe(true);
  });

  it('计划运行后隐藏审批按钮并展示运行状态', async () => {
    const steps = [createStep(0), createStep(1), createStep(2)];
    const wrapper = mountPanel({
      steps,
      approvedAt: '2026-04-29T10:00:00.000Z',
      activeRun: createRun(steps),
    });

    expect(wrapper.text()).toContain('运行中');
    expect(wrapper.findAll('button').some((button) => button.text() === '已批准')).toBe(false);
  });

  it('执行队列不提供本地编辑和删除入口', async () => {
    const wrapper = mountPanel();

    expect(wrapper.find('input[aria-label="编辑计划步骤标题"]').exists()).toBe(false);
    expect(wrapper.find('.ai-plan-step-remove').exists()).toBe(false);
  });

  it('持久化后的待审批计划仍只显示只读执行队列', () => {
    const wrapper = mountPanel({
      planStatus: 'pending_approval',
    });

    expect(wrapper.find('input[aria-label="编辑计划步骤标题"]').exists()).toBe(false);
    expect(wrapper.find('.ai-plan-step-remove').exists()).toBe(false);
  });

  it('不在紧凑队列中展示计划审计元数据和版本记录', () => {
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

    expect(wrapper.text()).not.toContain('plan-audit');
    expect(wrapper.text()).not.toContain('v2');
    expect(wrapper.text()).not.toContain('拒绝原因：需要调整范围');
    expect(wrapper.text()).not.toContain('v1 · 已批准');
  });

  it('运行中只展示状态、步骤和进度', async () => {
    const steps = [createStep(0), createStep(1), createStep(2)];
    const wrapper = mountPanel({
      steps,
      approvedAt: '2026-04-29T10:00:00.000Z',
      activeRun: createRun(steps),
    });

    expect(wrapper.text()).toContain('运行中');
    expect(wrapper.text()).toContain('执行进度(0/3)');
    expect(wrapper.text()).toContain('收集上下文');
    expect(wrapper.text()).not.toContain('暂停');
    expect(wrapper.text()).not.toContain('取消');

    expect(wrapper.emitted('runStep')).toBeUndefined();
    expect(wrapper.emitted('pauseRun')).toBeUndefined();
    expect(wrapper.emitted('cancelRun')).toBeUndefined();
  });

  it('暂停态展示可继续状态并触发继续执行', async () => {
    const steps = [createStep(0), createStep(1), createStep(2)];
    const wrapper = mountPanel({
      steps,
      approvedAt: '2026-04-29T10:00:00.000Z',
      activeRun: createRun(steps, {
        status: 'paused',
        currentStepId: steps[0]?.id ?? null,
      }),
    });

    expect(wrapper.text()).toContain('可继续');

    await wrapper.get('button[aria-label="继续执行计划"]').trigger('click');

    expect(wrapper.emitted('resumeRun')).toHaveLength(1);
  });

  it('有工具确认待处理时仍不把确认卡塞进执行队列', () => {
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

    expect(wrapper.findAll('button').some((button) => button.text() === '执行下一步')).toBe(false);
    expect(wrapper.text()).not.toContain('允许 Agent 使用 run_test 吗？');
  });

  it('不在执行队列中展示当前 Web 工具活动', () => {
    const wrapper = mountPanel({
      webActivity: {
        id: 'web-activity-1',
        state: 'searching',
        label: '正在搜索…',
        queryPreview: 'Tauri docs',
        stepId: 'plan-step-1',
      },
    });

    expect(wrapper.text()).not.toContain('Tauri docs');
    expect(wrapper.find('.ai-web-activity-spinner').exists()).toBe(false);
  });

  it('不在执行队列中展示当前普通工具活动', () => {
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

    expect(wrapper.text()).not.toContain('正在读取当前文件…');
    expect(wrapper.find('.ai-plan-status-icon').exists()).toBe(false);
  });
});
