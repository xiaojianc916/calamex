import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import AiPatchPreview from '@/components/business/ai/edit/AiPatchPreview.vue';

import type { IAiPatchSet } from '@/types/ai';

const createPatch = (): IAiPatchSet => ({
  summary: '应用 AI 回复中的代码块',
  files: [
    {
      path: String.raw`\\?\D:\test\demo.c`,
      originalHash: 'fnv64:test',
      hunks: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 2,
          lines: ['-#include <stdio.h>', '+#include <stdbool.h>', ' int main(void) {'],
        },
      ],
    },
  ],
});

describe('AiPatchPreview', () => {
  it('展示路径时会移除 Windows 扩展路径前缀', () => {
    const wrapper = mount(AiPatchPreview, {
      props: {
        patch: createPatch(),
      },
    });

    expect(wrapper.find('.ai-patch-file-name').text()).toContain('demo.c');
    expect(wrapper.find('.ai-patch-file-name').attributes('title')).toContain('D:/test/demo.c');
    expect(wrapper.find('.ai-patch-file-name').attributes('title')).not.toContain('\\\\?\\');
  });

  it('复用现有 Diff hunk 组件渲染增删行', () => {
    const wrapper = mount(AiPatchPreview, {
      props: {
        patch: createPatch(),
      },
    });

    const hunkViewer = wrapper.find('.ai-diff-hunk-viewer');

    expect(hunkViewer.exists()).toBe(true);
    expect(hunkViewer.text()).toContain('@@ -1,2 +1,2 @@');
    expect(hunkViewer.text()).toContain('#include <stdio.h>');
    expect(hunkViewer.text()).toContain('#include <stdbool.h>');
  });

  it('默认以 Codex 风格折叠文件 diff', () => {
    const wrapper = mount(AiPatchPreview, {
      props: {
        patch: createPatch(),
        variant: 'message',
      },
    });

    expect(wrapper.find('.ai-patch-file').attributes('open')).toBeUndefined();
    expect(wrapper.find('.ai-patch-file-summary').text()).toContain('demo.c');
    expect(wrapper.find('.ai-patch-file-summary').text()).toContain('+1');
    expect(wrapper.find('.ai-patch-file-summary').text()).toContain('-1');
  });

  it('点击按钮会输出可由独立 Git Diff 面板打开的预览数据', async () => {
    const wrapper = mount(AiPatchPreview, {
      props: {
        patch: createPatch(),
        workspaceRootPath: 'D:/test',
      },
    });

    await wrapper.find('.ai-patch-diff-button').trigger('click');

    const payload = wrapper.emitted('open-diff')?.[0]?.[0];

    expect(payload).toMatchObject({
      path: 'D:/test/demo.c',
      relativePath: 'demo.c',
      title: 'demo.c · Patch Diff',
      mode: 'worktree',
      originalContent: '#include <stdio.h>\nint main(void) {',
      modifiedContent: '#include <stdbool.h>\nint main(void) {',
      isEmpty: false,
    });
  });
});
