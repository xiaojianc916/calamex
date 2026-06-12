import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import AiWebPreviewSidebar from '@/components/business/ai/shell/AiWebPreviewSidebar.vue';

describe('AiWebPreviewSidebar', () => {
  it('renders the default empty preview scaffold', () => {
    const wrapper = mount(AiWebPreviewSidebar);

    expect(wrapper.get('[data-testid="ai-web-preview-sidebar"]').exists()).toBe(true);
    expect(wrapper.get('input').element).toBeInstanceOf(HTMLInputElement);
    expect(wrapper.find('iframe').exists()).toBe(false);
    expect(wrapper.text()).toContain('输入地址后即可在这里预览页面');
    expect(wrapper.get('[data-testid="web-preview-console"]').text()).toContain(
      'Page loaded successfully',
    );
  });

  it('emits close-sidebar from the leftmost navigation button', async () => {
    const wrapper = mount(AiWebPreviewSidebar);

    await wrapper.get('[aria-label="Close sidebar"]').trigger('click');

    expect(wrapper.emitted('close-sidebar')?.length).toBe(1);
  });

  it('updates the preview url from the location field', async () => {
    const wrapper = mount(AiWebPreviewSidebar);

    await wrapper.get('input').setValue('https://example.com');
    await wrapper.get('form').trigger('submit');

    expect(wrapper.emitted('url-change')?.[0]).toEqual(['https://example.com']);
    expect(wrapper.get('iframe').attributes('src')).toBe('https://example.com');
  });

  it('collapses the console when maximize is toggled', async () => {
    const wrapper = mount(AiWebPreviewSidebar);

    await wrapper.get('[aria-label="Maximize"]').trigger('click');

    expect(wrapper.find('[data-testid="web-preview-console"]').exists()).toBe(false);
  });
});
