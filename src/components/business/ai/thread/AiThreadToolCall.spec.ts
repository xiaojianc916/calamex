import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import CodeBlock from '@/components/ai-elements/code-block/CodeBlock.vue';
import { Terminal } from '@/components/ai-elements/terminal';
import { ThreadEntryDisclosure } from '@/components/ai-elements/thread-entry';
import AiMarkdown from '@/components/business/ai/chat/AiMarkdown.vue';
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
  CodeBlock: true,
};

const baseEntry = (content: TAiThreadToolContent[]): IAiThreadToolCallEntry => ({
  kind: 'tool-call',
  id: 't1',
  messageId: 'm1',
  icon: 'file',
  title: '读取文件',
  tags: ['src/a.ts'],
  status: 'succeeded',
  content,
});

describe('AiThreadToolCall', () => {
  it('渲染标题、主标签与文本内容', () => {
    const wrapper = mount(AiThreadToolCall, {
      props: { entry: baseEntry([{ type: 'text', id: 'c1', markdown: 'done' }]), open: true },
      global: { stubs },
    });

    expect(wrapper.text()).toContain('读取文件');
    expect(wrapper.text()).toContain('src/a.ts');
    expect(wrapper.findComponent(AiMarkdown).exists()).toBe(true);
  });

  it('无内容时作为静态行并禁用展开', () => {
    const wrapper = mount(AiThreadToolCall, {
      props: { entry: baseEntry([]), open: false },
      global: { stubs },
    });

    expect(wrapper.findComponent(ThreadEntryDisclosure).props('disabled')).toBe(true);
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

  it('按补丁解析并内联渲染 diff hunks', () => {
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
    expect(wrapper.findAllComponents(CodeBlock).length).toBe(1);
  });
});
