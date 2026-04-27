import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AiMarkdown from '@/components/business/ai/AiMarkdown.vue';
import { createStreamingFenceParser } from '@/composables/useStreamingFenceParser';

const highlightAiCode = vi.fn(async () => '<pre class="shiki"><code>highlighted</code></pre>');

vi.mock('@/composables/useShikiHighlighter', () => ({
  useShikiHighlighter: () => ({ highlightAiCode }),
}));

describe('AiMarkdown streaming fence rendering', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    highlightAiCode.mockClear();
  });

  it('renders an open fence as plaintext block without Shiki highlighting', async () => {
    const parser = createStreamingFenceParser('m-stream');
    const snapshot = parser.append('前文 **markdown**\n\n```ts\nconst pending = true;');

    const wrapper = mount(AiMarkdown, {
      props: {
        messageId: 'm-stream',
        content: '前文 **markdown**\n\n```ts\nconst pending = true;',
        stableContent: snapshot.stableContent,
        openBlock: snapshot.openBlock,
        canApplyCode: true,
      },
      global: {
        plugins: [createPinia()],
      },
    });

    expect(wrapper.html()).toContain('<strong>markdown</strong>');
    expect(wrapper.text()).toContain('const pending = true;');
    expect(wrapper.text()).toContain('正在生成…');
    expect(wrapper.find('pre.shiki').exists()).toBe(false);
    expect(highlightAiCode).not.toHaveBeenCalled();
  });
});
