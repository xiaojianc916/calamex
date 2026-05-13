import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import AiDiffHunkViewer from '@/components/business/ai/AiDiffHunkViewer.vue';
import type { IAiDiffHunkPreview } from '@/types/ai';

const createHunk = (): IAiDiffHunkPreview => ({
  id: 'hunk-1',
  filePath: 'src/agent/runtime.ts',
  diffRef: 'diff:runtime',
  header: '@@ -1,1 +1,1 @@',
  lines: [
    {
      id: 'line-1',
      kind: 'delete',
      content: "- const mode = 'chat'",
      oldLineNumber: 1,
    },
    {
      id: 'line-2',
      kind: 'add',
      content: "+ const mode = 'agent'",
      newLineNumber: 1,
    },
  ],
});

describe('AiDiffHunkViewer', () => {
  it('渲染小段 hunk 预览', () => {
    const wrapper = mount(AiDiffHunkViewer, {
      props: {
        hunk: createHunk(),
      },
    });

    expect(wrapper.text()).toContain('@@ -1,1 +1,1 @@');
    expect(wrapper.find('.ai-diff-hunk-line.is-add').exists()).toBe(true);
    expect(wrapper.find('.ai-diff-hunk-line.is-delete').exists()).toBe(true);
  });
});
