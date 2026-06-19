import { describe, expect, it } from 'vitest';

import type { IAiAgentPatchSummary } from '@/types/ai/patch';
import type { IAiThreadToolCall } from '@/types/ai/thread';

import { attachChangedFileDiffsToToolCalls } from './attach-changed-file-diffs';

const makeToolCall = (overrides: Partial<IAiThreadToolCall> = {}): IAiThreadToolCall => ({
  type: 'tool_call',
  id: 't1',
  createdAt: '2026-06-14T00:00:00.000Z',
  title: '工具调用',
  kind: 'edit',
  status: 'completed',
  content: [],
  ...overrides,
});

const makeSummary = (path: string): IAiAgentPatchSummary => ({
  id: 'patch-1',
  runId: 'run-1',
  stepId: 'step-1',
  files: [{ path, status: 'modified', additions: 1, deletions: 0, diffRef: 'diff-1' }],
  totalAdditions: 1,
  totalDeletions: 0,
  patchRef: 'patch-ref-1',
});

describe('attachChangedFileDiffsToToolCalls', () => {
  it('按路径把内联 diff 挂到标题命中的工具调用上', () => {
    const matched = makeToolCall({ id: 't-edit', title: '编辑 src/foo.ts', kind: 'edit' });
    const other = makeToolCall({ id: 't-read', title: '读取 src/bar.ts', kind: 'read' });
    attachChangedFileDiffsToToolCalls([other, matched], makeSummary('src/foo.ts'), []);
    expect(other.content).toHaveLength(0);
    expect(matched.content).toHaveLength(1);
    expect(matched.content[0]).toMatchObject({
      type: 'diff',
      diff: { filePath: 'src/foo.ts', hunks: [] },
    });
  });

  it('路径无法命中时归到最后一个编辑类工具调用', () => {
    const firstEdit = makeToolCall({ id: 't-edit-1', title: '编辑', kind: 'edit' });
    const read = makeToolCall({ id: 't-read', title: '读取', kind: 'read' });
    const lastEdit = makeToolCall({ id: 't-edit-2', title: '再次编辑', kind: 'edit' });
    attachChangedFileDiffsToToolCalls([firstEdit, read, lastEdit], makeSummary('src/x.ts'), []);
    expect(firstEdit.content).toHaveLength(0);
    expect(read.content).toHaveLength(0);
    expect(lastEdit.content).toHaveLength(1);
  });

  it('空工具调用列表时安全跳过', () => {
    expect(() =>
      attachChangedFileDiffsToToolCalls([], makeSummary('src/foo.ts'), []),
    ).not.toThrow();
  });
});
