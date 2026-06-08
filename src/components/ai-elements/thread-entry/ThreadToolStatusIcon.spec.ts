import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ThreadToolStatusIcon from '@/components/ai-elements/thread-entry/ThreadToolStatusIcon.vue';

describe('ThreadToolStatusIcon', () => {
  it('成功状态使用对勾图标与成功色，并暴露状态属性', () => {
    const wrapper = mount(ThreadToolStatusIcon, { props: { status: 'succeeded' } });

    expect(wrapper.attributes('data-status')).toBe('succeeded');

    const icon = wrapper.find('span[aria-hidden="true"]');
    expect(icon.classes()).toContain('icon-[lucide--circle-check]');
    expect(icon.classes()).toContain('text-emerald-500');
  });

  it('运行中状态使用旋转的加载图标', () => {
    const wrapper = mount(ThreadToolStatusIcon, { props: { status: 'running' } });

    const icon = wrapper.find('span[aria-hidden="true"]');
    expect(icon.classes()).toContain('icon-[lucide--loader-circle]');
    expect(icon.classes()).toContain('animate-spin');
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
