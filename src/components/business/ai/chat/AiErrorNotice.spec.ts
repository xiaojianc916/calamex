import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AiErrorNotice from '@/components/business/ai/chat/AiErrorNotice.vue';

describe('AiErrorNotice', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('在报错为空时不渲染任何内容', () => {
    const wrapper = mount(AiErrorNotice, { props: { message: '   ' } });

    expect(wrapper.find('.ai-error-notice').exists()).toBe(false);
  });

  it('在两条分隔线中间渲染告警图标和报错文案', () => {
    const wrapper = mount(AiErrorNotice, {
      props: { message: 'AGENT_SIDECAR_UNAVAILABLE: 节点未就绪' },
    });

    expect(wrapper.find('.ai-error-notice').exists()).toBe(true);
    expect(wrapper.findAll('.ai-error-notice__line')).toHaveLength(2);
    expect(wrapper.find('.lucide-circle-alert').exists()).toBe(true);
    expect(wrapper.find('.ai-error-notice__text').text()).toBe(
      'AGENT_SIDECAR_UNAVAILABLE: 节点未就绪',
    );
  });

  it('点击时复制完整报错信息', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const longMessage = `${'错误详情 '.repeat(40)}END`;
    const wrapper = mount(AiErrorNotice, { props: { message: longMessage } });

    await wrapper.get('.ai-error-notice__body').trigger('click');

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(longMessage);
  });
});
