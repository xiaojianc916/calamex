import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import type { IAiTaskPlanStep } from '@/types/ai';
import type { TAgentPlanStatus } from '@/types/ai/sidecar';

import AiPlan from './AiPlan.vue';

const buildStep = (overrides: Partial<IAiTaskPlanStep> = {}): IAiTaskPlanStep => ({
  id: 's1',
  index: 0,
  title: '步骤一',
  goal: '目标',
  kind: 'edit',
  status: 'pending',
  expectedOutput: '产出',
  tools: [],
  requiresUserApproval: false,
  riskLevel: 'low',
  ...overrides,
});

const buildProps = (overrides: Record<string, unknown> = {}) => ({
  goal: '实现登录页',
  summary: '分两步完成',
  status: 'pending_approval' as TAgentPlanStatus,
  steps: [buildStep({ id: 's1', title: '步骤一' }), buildStep({ id: 's2', index: 1, title: '步骤二' })],
  isPlanning: false,
  isApproving: false,
  canEdit: true,
  canApprove: true,
  approvedAt: null,
  ...overrides,
});

describe('AiPlan', () => {
  it('渲染目标标题与概览', () => {
    const wrapper = mount(AiPlan, { props: buildProps() });

    expect(wrapper.find('.ai-element-plan-title').text()).toBe('实现登录页');
    expect(wrapper.text()).toContain('分两步完成');
  });

  it('canApprove 时呈现批准/重生成/拒绝选项,点击批准触发 approve', async () => {
    const wrapper = mount(AiPlan, { props: buildProps() });

    const options = wrapper.findAll('.approval-prompt__option');
    const labels = options.map((option) => option.text());
    expect(labels.some((text) => text.includes('批准并启动'))).toBe(true);
    expect(labels.some((text) => text.includes('重新生成'))).toBe(true);
    expect(labels.some((text) => text.includes('拒绝'))).toBe(true);

    const approveOption = options.find((option) => option.text().includes('批准并启动'));
    await approveOption?.trigger('click');

    expect(wrapper.emitted('approve')).toHaveLength(1);
  });

  it('快捷键 r 触发重新生成', async () => {
    const wrapper = mount(AiPlan, { props: buildProps() });

    await wrapper.find('.approval-prompt').trigger('keydown', { key: 'r' });

    expect(wrapper.emitted('regenerate')).toHaveLength(1);
  });

  it('Esc 在可拒绝时触发 reject', async () => {
    const wrapper = mount(AiPlan, { props: buildProps() });

    await wrapper.find('.approval-prompt').trigger('keydown', { key: 'Escape' });

    expect(wrapper.emitted('reject')).toHaveLength(1);
  });

  it('不可批准且已拒绝时不呈现批准与拒绝选项', () => {
    const wrapper = mount(AiPlan, {
      props: buildProps({ canApprove: false, status: 'rejected' as TAgentPlanStatus }),
    });

    const labels = wrapper.findAll('.approval-prompt__option').map((option) => option.text());
    expect(labels.some((text) => text.includes('批准并启动'))).toBe(false);
    expect(labels.some((text) => text.includes('拒绝'))).toBe(false);
    expect(labels.some((text) => text.includes('重新生成'))).toBe(true);
  });

  it('canEdit 时编辑步骤标题失焦触发 updateTitle', async () => {
    const wrapper = mount(AiPlan, { props: buildProps() });

    const input = wrapper.findAll('input.ai-element-plan-step-title')[0];
    await input?.setValue('新标题');
    await input?.trigger('blur');

    expect(wrapper.emitted('updateTitle')?.[0]).toEqual(['s1', '新标题']);
  });

  it('步骤数超过下限时删除按钮触发 removeStep', async () => {
    const wrapper = mount(AiPlan, {
      props: buildProps({
        steps: [
          buildStep({ id: 's1', title: '步骤一' }),
          buildStep({ id: 's2', index: 1, title: '步骤二' }),
          buildStep({ id: 's3', index: 2, title: '步骤三' }),
        ],
      }),
    });

    const removeButtons = wrapper.findAll('button[aria-label="删除计划步骤"]');
    await removeButtons[0]?.trigger('click');

    expect(wrapper.emitted('removeStep')?.[0]).toEqual(['s1']);
  });
});
