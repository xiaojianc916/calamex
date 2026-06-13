import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import AiWebPreviewSidebar from '@/components/business/ai/shell/AiWebPreviewSidebar.vue';

describe('AiWebPreviewSidebar', () => {
  it('renders the default empty preview scaffold', () => {
    const wrapper = mount(AiWebPreviewSidebar);

    expect(wrapper.get('[data-testid="ai-web-preview-sidebar"]').exists()).toBe(true);
    expect(wrapper.get('input').element).toBeInstanceOf(HTMLInputElement);
    expect(wrapper.find('iframe').exists()).toBe(false);
    expect(wrapper.text()).toContain(
      '\u8f93\u5165\u5730\u5740\u540e\u5373\u53ef\u5728\u8fd9\u91cc\u9884\u89c8\u9875\u9762',
    );
    expect(wrapper.get('[data-testid="web-preview-console"]').text()).toContain('Console');
  });

  it('emits close-sidebar from the close navigation button', async () => {
    const wrapper = mount(AiWebPreviewSidebar);

    await wrapper.get('[aria-label="Close sidebar"]').trigger('click');

    expect(wrapper.emitted('close-sidebar')?.length).toBe(1);
  });

  it('updates the preview url from the location field', async () => {
    const wrapper = mount(AiWebPreviewSidebar);

    await wrapper.get('input').setValue('https://example.com');
    await wrapper.get('form').trigger('submit');

    expect(wrapper.emitted('url-change')?.[0]).toEqual(['https://example.com']);
    expect(wrapper.find('iframe').exists()).toBe(false);
    expect(wrapper.get('.ai-web-preview-body__host').exists()).toBe(true);
  });

  it('disables back and forward until navigation reports availability', () => {
    const wrapper = mount(AiWebPreviewSidebar);

    expect((wrapper.get('[aria-label="Go back"]').element as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((wrapper.get('[aria-label="Go forward"]').element as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('collapses the console body but keeps the header bar', async () => {
    const wrapper = mount(AiWebPreviewSidebar);

    expect(wrapper.get('[data-testid="web-preview-console"]').exists()).toBe(true);
    expect(wrapper.find('.ai-web-preview-console__empty').exists()).toBe(false);

    await wrapper.get('[data-testid="web-preview-console-toggle"]').trigger('click');

    expect(wrapper.get('[data-testid="web-preview-console"]').exists()).toBe(true);
    expect(wrapper.find('.ai-web-preview-console__empty').exists()).toBe(true);
    expect(wrapper.get('[data-testid="web-preview-console"]').text()).toContain('暂无应用日志');
  });
});
