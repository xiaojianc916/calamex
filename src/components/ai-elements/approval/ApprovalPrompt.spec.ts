import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';

import ApprovalPrompt from './ApprovalPrompt.vue';
import type { IApprovalPromptOption } from './types';

const baseOptions: IApprovalPromptOption[] = [
  { id: 'approve', label: '允许执行', shortcut: 'y' },
  { id: 'stop', label: '停止并说明', shortcut: 'n', tone: 'danger' },
];

describe('ApprovalPrompt', () => {
  it('渲染标题与全部可选项标签', () => {
    const wrapper = mount(ApprovalPrompt, {
      props: { title: '是否允许执行此操作？', options: baseOptions },
    });

    expect(wrapper.find('.approval-prompt__title').text()).toBe('是否允许执行此操作？');
    const options = wrapper.findAll('.approval-prompt__option');
    expect(options).toHaveLength(2);
    expect(options[0]?.text()).toContain('允许执行');
    expect(options[1]?.text()).toContain('停止并说明');
  });

  it('提供 reason 时渲染原因行，未提供时不渲染', () => {
    const withReason = mount(ApprovalPrompt, {
      props: { title: 't', options: baseOptions, reason: '将写入工作区文件' },
    });
    expect(withReason.find('.approval-prompt__reason').exists()).toBe(true);
    expect(withReason.find('.approval-prompt__reason-text').text()).toBe('将写入工作区文件');

    const withoutReason = mount(ApprovalPrompt, {
      props: { title: 't', options: baseOptions },
    });
    expect(withoutReason.find('.approval-prompt__reason').exists()).toBe(false);
  });

  it('渲染 context 插槽内容', () => {
    const wrapper = mount(ApprovalPrompt, {
      props: { title: 't', options: baseOptions },
      slots: { context: '<code class="ctx-stub">$ ls</code>' },
    });
    expect(wrapper.find('.ctx-stub').exists()).toBe(true);
  });

  it('点击可选项触发对应 select', async () => {
    const wrapper = mount(ApprovalPrompt, {
      props: { title: 't', options: baseOptions },
    });
    await wrapper.findAll('.approval-prompt__option')[0]?.trigger('click');

    const events = wrapper.emitted('select');
    expect(events).toBeTruthy();
    expect(events?.[0]).toEqual(['approve']);
  });

  it('方向键移动高亮后 Enter 选中', async () => {
    const wrapper = mount(ApprovalPrompt, {
      props: { title: 't', options: baseOptions },
    });
    const root = wrapper.find('.approval-prompt');

    await root.trigger('keydown', { key: 'ArrowDown' });
    expect(wrapper.findAll('.approval-prompt__option')[1]?.classes()).toContain('is-active');

    await root.trigger('keydown', { key: 'Enter' });
    const events = wrapper.emitted('select');
    expect(events?.[0]).toEqual(['stop']);
  });

  it('快捷键可直接选中匹配项', async () => {
    const wrapper = mount(ApprovalPrompt, {
      props: { title: 't', options: baseOptions },
    });
    await wrapper.find('.approval-prompt').trigger('keydown', { key: 'n' });

    const events = wrapper.emitted('select');
    expect(events?.[0]).toEqual(['stop']);
  });

  it('Esc 触发 cancel', async () => {
    const wrapper = mount(ApprovalPrompt, {
      props: { title: 't', options: baseOptions },
    });
    await wrapper.find('.approval-prompt').trigger('keydown', { key: 'Escape' });

    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });

  it('disabled 时 tabindex 为 -1 且点击不触发 select', async () => {
    const wrapper = mount(ApprovalPrompt, {
      props: { title: 't', options: baseOptions, disabled: true },
    });
    expect(wrapper.find('.approval-prompt').attributes('tabindex')).toBe('-1');

    await wrapper.findAll('.approval-prompt__option')[0]?.trigger('click');
    expect(wrapper.emitted('select')).toBeUndefined();
  });

  it('为带快捷键的可选项渲染快捷键 chip', () => {
    const wrapper = mount(ApprovalPrompt, {
      props: { title: 't', options: baseOptions },
    });
    const chips = wrapper.findAll('.approval-prompt__kbd');
    expect(chips).toHaveLength(2);
    expect(chips[0]?.text()).toBe('y');
    expect(chips[1]?.text()).toBe('n');
  });

  it('可选项变化时高亮重置回首项', async () => {
    const wrapper = mount(ApprovalPrompt, {
      props: { title: 't', options: baseOptions },
    });
    await wrapper.find('.approval-prompt').trigger('keydown', { key: 'ArrowDown' });
    expect(wrapper.findAll('.approval-prompt__option')[1]?.classes()).toContain('is-active');

    await wrapper.setProps({ options: [{ id: 'only', label: '唯一项' }] });
    await nextTick();
    expect(wrapper.findAll('.approval-prompt__option')[0]?.classes()).toContain('is-active');
  });
});
