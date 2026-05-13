import { mount, type VueWrapper } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import AiChangedFilesSummary from '@/components/business/ai/AiChangedFilesSummary.vue';
import type { IAiAgentPatchSummary, IAiPatchSet } from '@/types/ai';

const createPatchSummary = (
  overrides: Partial<IAiAgentPatchSummary> = {},
): IAiAgentPatchSummary => ({
  id: 'patch-summary-1',
  runId: 'run-1',
  stepId: 'step-1',
  totalAdditions: 12,
  totalDeletions: 4,
  patchRef: 'patch:run-1:step-1',
  appliedAt: '2026-04-29T10:00:00.000Z',
  files: [
    {
      path: 'src/agent/runtime.ts',
      status: 'modified',
      additions: 12,
      deletions: 4,
      diffRef: 'diff:runtime',
      rollbackRef: 'rollback:runtime',
    },
  ],
  ...overrides,
});

const createMultiFilePatchSummary = (): IAiAgentPatchSummary =>
  createPatchSummary({
    id: 'patch-summary-2',
    totalAdditions: 20,
    totalDeletions: 7,
    patchRef: 'patch:run-1:step-2',
    files: [
      {
        path: 'src/agent/runtime.ts',
        status: 'modified',
        additions: 12,
        deletions: 4,
        diffRef: 'diff:runtime',
        rollbackRef: 'rollback:runtime',
      },
      {
        path: 'src/agent/new-file.ts',
        status: 'added',
        additions: 8,
        deletions: 0,
        diffRef: 'diff:new-file',
        rollbackRef: 'rollback:new-file',
      },
      {
        path: 'src/agent/old-file.ts',
        status: 'deleted',
        additions: 0,
        deletions: 3,
        diffRef: 'diff:old-file',
        rollbackRef: 'rollback:old-file',
      },
    ],
  });

const mountSummary = (
  summary: IAiAgentPatchSummary,
  variant: 'panel' | 'message' = 'message',
  patches: readonly IAiPatchSet[] = [],
  options: { isReverting?: boolean } = {},
): VueWrapper<InstanceType<typeof AiChangedFilesSummary>> =>
  mount(AiChangedFilesSummary, {
    props: { summary, variant, patches, ...options },
  });

describe('AiChangedFilesSummary', () => {
  it('默认以 Codex 风格折叠展示最终变更汇总', () => {
    const wrapper = mountSummary(createPatchSummary());

    expect(wrapper.find('section.ai-changed-files-summary').exists()).toBe(true);
    expect(wrapper.find('.ai-changed-file-item').classes()).not.toContain('is-open');
    expect(wrapper.find('.ai-changed-files-header').text()).toContain('1 个文件已更改');
    expect(wrapper.find('.ai-changed-files-header').text()).toContain('+12');
    expect(wrapper.find('.ai-changed-files-header').text()).toContain('-4');
    expect(wrapper.find('.ai-changed-files-actions').text()).toContain('撤销');
    expect(wrapper.find('.ai-changed-files-actions').text()).toContain('审核');
    expect(wrapper.text()).not.toContain('patch:run-1:step-1');
  });

  it('展示每个文件路径与新增删除统计', () => {
    const summary = createMultiFilePatchSummary();
    const wrapper = mountSummary(summary);

    expect(wrapper.find('.ai-changed-files-header').text()).toContain('3 个文件已更改');
    expect(wrapper.find('.ai-changed-files-header').text()).toContain('+20');
    expect(wrapper.find('.ai-changed-files-header').text()).toContain('-7');
    for (const file of summary.files) {
      expect(wrapper.text()).toContain(file.path);
      expect(wrapper.text()).toContain(`+${file.additions}`);
      expect(wrapper.text()).toContain(`-${file.deletions}`);
    }
  });

  it('展开文件行时用真实 patch hunk 渲染下拉 diff', async () => {
    const summary = createPatchSummary();
    const wrapper = mountSummary(summary, 'message', [
      {
        summary: '更新 runtime',
        files: [
          {
            path: 'src/agent/runtime.ts',
            originalHash: 'fnv64:test',
            hunks: [
              {
                oldStart: 110,
                oldLines: 2,
                newStart: 110,
                newLines: 2,
                lines: [
                  " const mode = 'chat';",
                  "+const mode = 'agent';",
                ],
              },
            ],
          },
        ],
      },
    ]);

    await wrapper.find('.ai-changed-file-summary').trigger('click');

    expect(wrapper.find('.ai-changed-file-diff').exists()).toBe(true);
    expect(wrapper.text()).toContain('110');
    expect(wrapper.text()).toContain("const mode = 'agent';");
  });

  it('panel 形态点击文件行时按文件 emit viewDiff', async () => {
    const summary = createMultiFilePatchSummary();
    const wrapper = mountSummary(summary, 'panel');

    const rows = wrapper.findAll('.ai-changed-file-summary');
    expect(rows).toHaveLength(summary.files.length);

    for (const row of rows) {
      await row.trigger('click');
    }

    expect(wrapper.emitted('viewDiff')).toEqual(
      summary.files.map((file) => [file.diffRef, file.path]),
    );
  });

  it('message 形态文件行不触发查看 diff', async () => {
    const wrapper = mountSummary(createPatchSummary(), 'message');

    await wrapper.find('.ai-changed-file-summary').trigger('click');
    expect(wrapper.emitted('viewDiff')).toBeUndefined();
  });

  it('点击撤销时 emit 当前 summary id，回滚中或已回滚时禁用', async () => {
    const wrapper = mountSummary(createPatchSummary());

    await wrapper.find('button.ai-changed-files-action').trigger('click');

    expect(wrapper.emitted('undo')).toEqual([['patch-summary-1']]);

    await wrapper.setProps({ isReverting: true });
    expect(wrapper.find('button.ai-changed-files-action').attributes('disabled')).toBeDefined();

    await wrapper.setProps({
      isReverting: false,
      summary: createPatchSummary({ revertedAt: '2026-05-03T10:02:00.000Z' }),
    });
    expect(wrapper.find('button.ai-changed-files-action').text()).toContain('已撤销');
    expect(wrapper.find('button.ai-changed-files-action').attributes('disabled')).toBeDefined();
  });

  it('summary props 变更后响应式刷新展示内容', async () => {
    const wrapper = mountSummary(createPatchSummary());

    expect(wrapper.text()).toContain('src/agent/runtime.ts');

    await wrapper.setProps({
      summary: createPatchSummary({
        totalAdditions: 1,
        totalDeletions: 1,
        files: [
          {
            path: 'src/agent/another.ts',
            status: 'modified',
            additions: 1,
            deletions: 1,
            diffRef: 'diff:another',
            rollbackRef: 'rollback:another',
          },
        ],
      }),
    });

    expect(wrapper.find('.ai-changed-files-header').text()).toContain('+1');
    expect(wrapper.find('.ai-changed-files-header').text()).toContain('-1');
    expect(wrapper.text()).toContain('src/agent/another.ts');
    expect(wrapper.text()).not.toContain('src/agent/runtime.ts');
  });
});
