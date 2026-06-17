import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import CodeBlock from '@/components/ai-elements/code-block/CodeBlock.vue';
import { Terminal } from '@/components/ai-elements/terminal';
import AiMarkdown from '@/components/business/ai/chat/AiMarkdown.vue';
import { AiDiffHunkViewer } from '@/components/business/ai/edit';
import type { IAiThreadToolCall, IAiThreadToolCallContent } from '@/types/ai/thread';
import AiThreadToolCall from './AiThreadToolCall.vue';
import type { IAiThreadToolCallEntry } from './projection';

const stubs = {
  AiMarkdown: true,
  Terminal: true,
  TerminalHeader: true,
  TerminalTitle: true,
  TerminalContent: true,
  AiDiffHunkViewer: true,
  CodeBlock: true,
};

const makeToolCall = (overrides: Partial<IAiThreadToolCall> = {}): IAiThreadToolCall => ({
  type: 'tool_call',
  id: 't1',
  createdAt: '2026-04-28T10:00:00.000Z',
  title: 'Search files for regex shikiLanguage',
  kind: 'search',
  status: 'completed',
  content: [],
  ...overrides,
});

const makeEntry = (
  toolCall: IAiThreadToolCall,
  extra: Partial<IAiThreadToolCallEntry> = {},
): IAiThreadToolCallEntry => ({
  kind: 'tool-call',
  id: 't1',
  messageId: 'm1',
  toolCall,
  terminals: {},
  awaiting: false,
  ...extra,
});

const withContent = (content: IAiThreadToolCallContent[]): IAiThreadToolCallEntry =>
  makeEntry(makeToolCall({ content }));

describe('AiThreadToolCall', () => {
  it('渲染 Zed 风格工具行标题与文本内容', () => {
    const wrapper = mount(AiThreadToolCall, {
      props: {
        entry: withContent([{ type: 'content', block: { type: 'text', text: 'done' } }]),
        open: true,
      },
      global: { stubs },
    });

    expect(wrapper.classes()).toContain('ai-thread-tool-call');
    expect(wrapper.attributes('data-state')).toBe('open');
    expect(wrapper.text()).toContain('Search files for regex shikiLanguage');
    expect(wrapper.findComponent(AiMarkdown).exists()).toBe(true);
  });

  it('以单段式渲染工具标题(Zed label)', () => {
    const wrapper = mount(AiThreadToolCall, {
      props: { entry: makeEntry(makeToolCall()), open: false },
      global: { stubs },
    });

    expect(wrapper.find('.ai-thread-tool-call__action').text()).toBe(
      'Search files for regex shikiLanguage',
    );
  });

  it('渲染 Raw Input / Output 展开块', () => {
    const wrapper = mount(AiThreadToolCall, {
      props: {
        entry: makeEntry(makeToolCall({ rawInput: '{"regex":"abc"}', rawOutput: 'matches' })),
        open: true,
      },
      global: { stubs },
    });

    expect(wrapper.text()).toContain('Raw Input:');
    expect(wrapper.text()).toContain('Output:');
    expect(wrapper.findAllComponents(CodeBlock).length).toBe(2);
  });

  it('点击 header 时切换展开状态', async () => {
    const wrapper = mount(AiThreadToolCall, {
      props: { entry: makeEntry(makeToolCall({ rawInput: '{}' })), open: false },
      global: { stubs },
    });

    await wrapper.find('.ai-thread-tool-call__header').trigger('click');

    expect(wrapper.emitted('update:open')?.[0]).toEqual([true]);
  });

  it('无内容时作为静态工具块并禁用 header', async () => {
    const wrapper = mount(AiThreadToolCall, {
      props: { entry: makeEntry(makeToolCall()), open: false },
      global: { stubs },
    });

    expect(wrapper.find('.ai-thread-tool-call__header').attributes('disabled')).toBeDefined();

    await wrapper.find('.ai-thread-tool-call__header').trigger('click');

    expect(wrapper.emitted('update:open')).toBeUndefined();
  });

  it('渲染终端内容', () => {
    const wrapper = mount(AiThreadToolCall, {
      props: {
        entry: makeEntry(makeToolCall({ content: [{ type: 'terminal', terminalId: 'term-1' }] }), {
          terminals: { 'term-1': { title: '$ ls', output: 'a.txt', streaming: false } },
        }),
        open: true,
      },
      global: { stubs },
    });

    expect(wrapper.findComponent(Terminal).exists()).toBe(true);
  });

  it('diff 内容自带内联 hunk 时直接渲染', () => {
    const wrapper = mount(AiThreadToolCall, {
      props: {
        entry: withContent([
          {
            type: 'diff',
            diff: {
              id: 'd2',
              title: 'src/b.ts',
              filePath: 'src/b.ts',
              diffRef: 'd2',
              hunks: [
                {
                  id: 'hb1',
                  filePath: 'src/b.ts',
                  diffRef: 'd2',
                  header: '@@ -1,2 +1,2 @@',
                  lines: [
                    { id: 'lb1', kind: 'delete', content: 'old', oldLineNumber: 1 },
                    { id: 'lb2', kind: 'add', content: 'new', newLineNumber: 1 },
                  ],
                },
              ],
            },
          },
        ]),
        open: true,
      },
      global: { stubs },
    });

    expect(wrapper.text()).toContain('src/b.ts');
    expect(wrapper.findAllComponents(AiDiffHunkViewer).length).toBe(1);
  });

  it('Mastra HITL 等待确认时派生 awaiting-confirmation 状态', () => {
    const wrapper = mount(AiThreadToolCall, {
      props: {
        entry: makeEntry(makeToolCall({ status: 'pending' }), { awaiting: true }),
        open: false,
      },
      global: { stubs },
    });

    expect(wrapper.find('[data-status="awaiting-confirmation"]').exists()).toBe(true);
  });
});
