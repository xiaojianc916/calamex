import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ThreadToolStatusIcon from '@/components/ai-elements/thread-entry/ThreadToolStatusIcon.vue';
import LucideIcon from '@/components/ui/icon/LucideIcon.vue';

describe('ThreadToolStatusIcon', () => {
  it('成功状态保持 Zed 风格克制，不显示绿色大对勾', () => {
    const wrapper = mount(ThreadToolStatusIcon, { props: { status: 'succeeded' } });

    expect(wrapper.attributes('data-status')).toBe('succeeded');
    expect(wrapper.attributes('aria-label')).toBe('已完成');
    expect(wrapper.find('span[aria-hidden="true"]').exists()).toBe(false);
  });

  it('运行中状态使用克制的旋转加载图标', () => {
    const wrapper = mount(ThreadToolStatusIcon, { props: { status: 'running' } });

    const icon = wrapper.findComponent(LucideIcon);
    expect(icon.props('name')).toBe('loader-circle');
    expect(icon.classes()).toContain('animate-spin');
    expect(icon.classes()).toContain('text-muted-foreground');
  });

  it('失败状态使用警告图标', () => {
    const wrapper = mount(ThreadToolStatusIcon, { props: { status: 'failed' } });

    const icon = wrapper.findComponent(LucideIcon);
    expect(icon.props('name')).toBe('circle-alert');
    expect(icon.classes()).toContain('text-red-500');
  });

  it('为状态提供可访问的中文标签', () => {
    const wrapper = mount(ThreadToolStatusIcon, {
      props: { status: 'awaiting-confirmation' },
    });

    expect(wrapper.attributes('role')).toBe('img');
    expect(wrapper.attributes('aria-label')).toBe('等待确认');
  });

  it('默认回退到等待中状态', () => {
    const wrapper = mount(ThreadToolStatusIcon);

    expect(wrapper.attributes('data-status')).toBe('pending');
    expect(wrapper.attributes('aria-label')).toBe('等待中');
  });
});
