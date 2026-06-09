import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import CodeBlock from '@/components/ai-elements/code-block/CodeBlock.vue';
import { Terminal } from '@/components/ai-elements/terminal';
import AiMarkdown from '@/components/business/ai/chat/AiMarkdown.vue';
import { AiDiffHunkViewer } from '@/components/business/ai/edit';
import type { IAiPatchSet } from '@/types/ai';
import AiThreadToolCall from './AiThreadToolCall.vue';
import type { IAiThreadToolCallEntry, TAiThreadToolContent } from './projection';

vi.mock('@/components/business/ai/edit/patch-preview', () => ({
  buildAiPatchPreviewFiles: () => [
    {
      path: 'src/a.ts',
      displayPath: 'src/a.ts',
      hunks: [
        {
          id: 'h1',
          filePath: 'src/a.ts',
          diffRef: 'd1',
          header: '@@ -1 +1 @@',
          lines: [{ id: 'l1', kind: 'add', content: 'const a = 1;', newLineNumber: 1 }],
        },
      ],
    },
  ],
  formatAiPatchDisplayPath: (path: string) => path,
}));

const stubs = {
  AiMarkdown: true,
  Terminal: true,
  TerminalHeader: true,
  TerminalTitle: true,
  TerminalContent: true,
  AiDiffHunkViewer: true,
  CodeBlock: true,
};

const baseEntry = (content: TAiThreadToolContent[]): IAiThreadToolCallEntry => ({
  kind: 'tool-call',
  id: 't1',
  messageId: 'm1',
  icon: 'search',
  title: 'Search files for regex shikiLanguage',
  tags: [],
  status: 'succeeded',
  content,
});

describe('AiThreadToolCall', () => {
  it('渲染 Zed 风格工具行标题与文本内容', () => {
    const wrapper = mount(AiThreadToolCall, {
      props: { entry: baseEntry([{ type: 'text', id: 'c1', markdown: 'done' }]), open: true },
      global: { stubs },
    });

    expect(wrapper.classes()).toContain('ai-thread-tool-call');
    expect(wrapper.attributes('data-state')).toBe('open');
    expect(wrapper.text()).toContain('Search files for regex shikiLanguage');
    expect(wrapper.findComponent(AiMarkdown).exists()).toBe(true);
  });

  it('渲染 Raw Input / Output 展开块', () => {
    const wrapper = mount(AiThreadToolCall, {
      props: {
        entry: baseEntry([
          { type: 'raw', id: 'raw-input', title: 'Raw Input', code: '{"regex":"abc"}' },
          { type: 'raw', id: 'raw-output', title: 'Output', code: 'matches' },
        ]),
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
      props: {
        entry: baseEntry([{ type: 'raw', id: 'raw-input', title: 'Raw Input', code: '{}' }]),
        open: false,
      },
      global: { stubs },
    });

    await wrapper.find('.ai-thread-tool-call__header').trigger('click');

    expect(wrapper.emitted('update:open')?.[0]).toEqual([true]);
  });

  it('无内容时作为静态工具块并禁用 header', async () => {
    const wrapper = mount(AiThreadToolCall, {
      props: { entry: baseEntry([]), open: false },
      global: { stubs },
    });

    expect(wrapper.find('.ai-thread-tool-call__header').attributes('disabled')).toBeDefined();

    await wrapper.find('.ai-thread-tool-call__header').trigger('click');

    expect(wrapper.emitted('update:open')).toBeUndefined();
  });

  it('渲染终端内容', () => {
    const wrapper = mount(AiThreadToolCall, {
      props: {
        entry: baseEntry([
          { type: 'terminal', id: 'c1', title: '$ ls', output: 'a.txt', streaming: false },
        ]),
        open: true,
      },
      global: { stubs },
    });

    expect(wrapper.findComponent(Terminal).exists()).toBe(true);
  });

  it('按补丁解析并复用 diff 卡片渲染 hunks', () => {
    const patch: IAiPatchSet = {
      summary: 'x',
      files: [
        {
          path: 'src/a.ts',
          originalHash: 'h',
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+const a = 1;'] }],
        },
      ],
    };
    const wrapper = mount(AiThreadToolCall, {
      props: {
        entry: baseEntry([
          {
            type: 'diff',
            id: 'c1',
            file: {
              path: 'src/a.ts',
              status: 'modified',
              additions: 1,
              deletions: 0,
              diffRef: 'd1',
            },
            patchSummaryId: 'sum1',
          },
        ]),
        open: true,
        patches: [patch],
        workspaceRootPath: null,
      },
      global: { stubs },
    });

    expect(wrapper.text()).toContain('src/a.ts');
    expect(wrapper.findAllComponents(AiDiffHunkViewer).length).toBe(1);
  });
});
