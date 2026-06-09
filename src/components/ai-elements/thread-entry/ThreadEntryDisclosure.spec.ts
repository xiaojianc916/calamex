import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ThreadEntryDisclosure from '@/components/ai-elements/thread-entry/ThreadEntryDisclosure.vue';

describe('ThreadEntryDisclosure', () => {
  it('渲染标题文本与具名插槽', () => {
    const wrapper = mount(ThreadEntryDisclosure, {
      props: { title: '读取文件', open: false },
      slots: {
        leading: '<i class="leading-stub" />',
        meta: '<span class="meta-stub">12ms</span>',
      },
    });

    expect(wrapper.text()).toContain('读取文件');
    expect(wrapper.find('.leading-stub').exists()).toBe(true);
    expect(wrapper.find('.meta-stub').exists()).toBe(true);
    expect(wrapper.find('.thread-entry-disclosure__chevron').exists()).toBe(true);
  });

  it('点击触发器时向外 emit 展开状态', async () => {
    const wrapper = mount(ThreadEntryDisclosure, {
      props: { title: '执行命令', open: false },
    });

    await wrapper.find('button').trigger('click');

    expect(wrapper.emitted('update:open')?.[0]).toEqual([true]);
  });

  it('展开时渲染折叠内容插槽', () => {
    const wrapper = mount(ThreadEntryDisclosure, {
      props: { title: '执行命令', open: true },
      slots: { content: '<div class="content-stub">终端输出</div>' },
    });

    expect(wrapper.find('.content-stub').exists()).toBe(true);
    expect(wrapper.text()).toContain('终端输出');
  });

  it('leadingChevron 时折叠箭头渲染在行首', () => {
    const wrapper = mount(ThreadEntryDisclosure, {
      props: { title: '读取文件', open: false, leadingChevron: true },
      slots: { leading: '<i class="leading-stub" />' },
    });

    const chevron = wrapper.find('.thread-entry-disclosure__chevron');

    expect(chevron.exists()).toBe(true);
    expect(chevron.classes()).toContain('thread-entry-disclosure__chevron--leading');
  });

  it('禁用时不渲染折叠箭头与折叠区，且点击不再 emit', async () => {
    const wrapper = mount(ThreadEntryDisclosure, {
      props: { title: '上下文整理', open: false, disabled: true },
      slots: { content: '<div class="content-stub">不应展开</div>' },
    });

    expect(wrapper.find('.thread-entry-disclosure__chevron').exists()).toBe(false);
    expect(wrapper.find('.content-stub').exists()).toBe(false);

    await wrapper.find('button').trigger('click');

    expect(wrapper.emitted('update:open')).toBeUndefined();
  });
});
