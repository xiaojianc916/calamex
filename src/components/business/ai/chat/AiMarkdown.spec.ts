import { flushPromises, mount } from '@vue/test-utils';
import MarkdownRender from 'markstream-vue';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import AiMarkdown from '@/components/business/ai/chat/AiMarkdown.vue';
import AiMarkdownCodeBlock from '@/components/business/ai/chat/AiMarkdownCodeBlock.vue';

const flushRender = async (): Promise<void> => {
  for (let tickIndex = 0; tickIndex < 4; tickIndex += 1) {
    await nextTick();
    await Promise.resolve();
  }
  await flushPromises();
  await nextTick();
};

describe('AiMarkdown rendering', () => {
  it('renders Markdown content through markstream-vue', async () => {
    const wrapper = mount(AiMarkdown, {
      props: {
        messageId: 'm-markstream',
        content: '前文 **markdown**\n\n- 第一项\n- 第二项',
      },
    });

    await flushRender();

    expect(wrapper.find('.markstream-vue').exists()).toBe(true);
    expect(wrapper.text()).toContain('前文');
    expect(wrapper.text()).toContain('markdown');
    expect(wrapper.text()).toContain('第一项');
  });

  it('keeps unfinished streamed fences visible while the message is streaming', async () => {
    const wrapper = mount(AiMarkdown, {
      props: {
        messageId: 'm-stream',
        content: '前文 **markdown**\n\n```ts\nconst pending = true;',
        streamStatus: 'streaming',
      },
    });

    await flushRender();

    expect(wrapper.text()).toContain('前文');
    expect(wrapper.text()).toContain('const pending = true');

    await wrapper.setProps({
      content: '前文 **markdown**\n\n```ts\nconst pending = true;\n```\n后文 **done**',
      streamStatus: 'completed',
    });
    await flushRender();

    expect(wrapper.text()).toContain('后文');
    expect(wrapper.text()).toContain('done');
  });

  it('开启 markstream 平滑流式输出并关闭与之冲突的淡入动画', async () => {
    const wrapper = mount(AiMarkdown, {
      props: {
        messageId: 'm-smooth-stream',
        content: '正在输出一段中文内容',
        streamStatus: 'streaming',
      },
    });

    await nextTick();

    const streamingRenderer = wrapper.getComponent(MarkdownRender);
    expect(streamingRenderer.props('smoothStreaming')).toBe(true);
    expect(streamingRenderer.props('fade')).toBe(false);
    expect(streamingRenderer.props('typewriter')).toBe(false);
    expect(streamingRenderer.props('maxLiveNodes')).toBe(320);
    expect(streamingRenderer.props('initialRenderBatchSize')).toBe(64);
    expect(streamingRenderer.props('renderBatchSize')).toBe(96);
    expect(streamingRenderer.props('renderBatchDelay')).toBe(0);

    await wrapper.setProps({
      streamStatus: 'completed',
    });
    await nextTick();

    const finalRenderer = wrapper.getComponent(MarkdownRender);
    expect(finalRenderer.props('smoothStreaming')).toBe(true);
    expect(finalRenderer.props('fade')).toBe(false);
    expect(finalRenderer.props('typewriter')).toBe(false);
    expect(finalRenderer.props('maxLiveNodes')).toBe(320);
    expect(finalRenderer.props('initialRenderBatchSize')).toBe(64);
    expect(finalRenderer.props('renderBatchSize')).toBe(96);
    expect(finalRenderer.props('renderBatchDelay')).toBe(0);
  });

  it('renders custom code blocks with copy actions and code content', async () => {
    const wrapper = mount(AiMarkdown, {
      props: {
        messageId: 'm-code-actions',
        content: '```ts\nconst ready = true;\n```',
        streamStatus: 'completed',
      },
    });

    await flushRender();

    expect(wrapper.find('.ai-markdown-code-block').exists()).toBe(true);
    expect(wrapper.find('.ai-markdown-code-block__header').exists()).toBe(true);
    expect(wrapper.findAll('.ai-markdown-code-block__icon-button')).toHaveLength(1);
    expect(wrapper.find('button[aria-label="复制代码"]').exists()).toBe(true);
    expect(wrapper.find('button[aria-label="折叠代码块"]').exists()).toBe(true);
    expect(wrapper.find('.ai-markdown-code-block__copy svg').exists()).toBe(true);
    expect(wrapper.find('.ai-markdown-code-block pre').exists()).toBe(true);
    expect(wrapper.text()).toContain('const ready = true;');

    const toggleButton = wrapper.get('button[aria-label="折叠代码块"]');
    expect(toggleButton.attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('.ai-markdown-code-block').classes()).not.toContain('is-collapsed');

    await toggleButton.trigger('click');
    await nextTick();

    expect(wrapper.find('button[aria-label="展开代码块"]').exists()).toBe(true);
    expect(wrapper.get('.ai-markdown-code-block').classes()).toContain('is-collapsed');

    await wrapper.get('button[aria-label="展开代码块"]').trigger('click');
    await nextTick();

    expect(wrapper.find('button[aria-label="折叠代码块"]').exists()).toBe(true);
    expect(wrapper.get('.ai-markdown-code-block').classes()).not.toContain('is-collapsed');
  });

  it('代码节点原地更新时仍用当前内容渲染代码块', async () => {
    const node = {
      code: '',
      language: 'text',
    };
    const wrapper = mount(AiMarkdownCodeBlock, {
      props: {
        isDark: true,
        loading: false,
        node,
      },
    });

    await flushRender();
    node.code = '第一步：观察地图\n第二步：记录问题';
    await wrapper.setProps({ node });
    await wrapper.get('button[aria-label="折叠代码块"]').trigger('click');
    await nextTick();

    expect(wrapper.text()).toContain('第一步：观察地图');
    expect(wrapper.text()).toContain('第二步：记录问题');
    expect(wrapper.find('button[aria-label="折叠代码块"]').exists()).toBe(true);
    expect(wrapper.get('.ai-markdown-code-block').classes()).not.toContain('is-collapsed');
  });

  it('renders LaTeX formulas through markstream-vue katex support', async () => {
    const wrapper = mount(AiMarkdown, {
      props: {
        messageId: 'm-math',
        content: '行内公式 $E = mc^2$\n\n$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$',
        streamStatus: 'completed',
      },
    });

    await flushRender();

    expect(wrapper.find('.katex').exists()).toBe(true);
    expect(wrapper.find('.katex-display').exists()).toBe(true);
  });

  it('unwraps boxed KaTeX formulas inside AI messages', async () => {
    const wrapper = mount(AiMarkdown, {
      props: {
        messageId: 'm-boxed',
        content:
          '$$\\boxed{\\zeta(s)=2^s\\pi^{s-1}\\sin\\left(\\frac{\\pi s}{2}\\right)\\Gamma(1-s)\\zeta(1-s)}$$',
        streamStatus: 'completed',
      },
    });

    await flushRender();

    expect(wrapper.find('.stretchy.fbox').exists()).toBe(false);
    expect(wrapper.find('.boxpad').exists()).toBe(false);
    expect(wrapper.find('.katex-display').exists()).toBe(true);
    expect(wrapper.text()).toContain('ζ');
  });
});
