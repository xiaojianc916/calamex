import { describe, expect, it } from 'vitest';
import { buildReversePatchSet } from '@/composables/ai/useAiAssistant.patch';
import type { IAiAgentPatchSummary, IAiPatchSet } from '@/types/ai';

const createSummary = (paths: readonly string[]): IAiAgentPatchSummary => ({
  id: 'summary-1',
  runId: 'run-1',
  stepId: 'step-1',
  files: paths.map((path) => ({
    path,
    status: 'modified',
    additions: 1,
    deletions: 1,
    diffRef: `diff:${path}`,
  })),
  totalAdditions: paths.length,
  totalDeletions: paths.length,
  patchRef: 'patch-ref-1',
});

const createPatch = (files: ReadonlyArray<{ path: string; lines?: string[] }>): IAiPatchSet => ({
  summary: 'AI 修改',
  files: files.map((file) => ({
    path: file.path,
    originalHash: `hash:${file.path}`,
    hunks: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        lines: file.lines ?? [' context', '+added', '-removed'],
      },
    ],
  })),
});

describe('buildReversePatchSet', () => {
  it('仅保留同时出现在补丁与 summary 中的文件（路径归一化匹配）', () => {
    const patch = createPatch([
      { path: 'a.txt' },
      { path: 'src/b.txt' },
      { path: 'C:/Repo/Foo.ts' },
      { path: 'unmatched.txt' },
    ]);
    // summary 用等价但写法不同的路径，验证归一化匹配与 Windows 盘符大小写折叠。
    const summary = createSummary(['./a.txt', 'src/b.txt', 'c:/repo/foo.ts']);

    const reverse = buildReversePatchSet([patch], summary);

    expect(reverse).not.toBeNull();
    expect(reverse?.files.map((file) => file.path)).toEqual([
      'a.txt',
      'src/b.txt',
      'C:/Repo/Foo.ts',
    ]);
    expect(reverse?.summary).toBe('回滚 3 个文件的 AI 修改');
  });

  it('反转 hunk 的起止与增删行', () => {
    const patch = createPatch([{ path: 'a.txt', lines: [' ctx', '+新增', '-删除'] }]);
    const summary = createSummary(['a.txt']);

    const reverse = buildReversePatchSet([patch], summary);
    const hunk = reverse?.files[0]?.hunks[0];

    expect(hunk).toMatchObject({
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 1,
      lines: [' ctx', '-新增', '+删除'],
    });
  });

  it('没有交集时返回 null', () => {
    const patch = createPatch([{ path: 'x.txt' }]);
    const summary = createSummary(['y.txt']);

    expect(buildReversePatchSet([patch], summary)).toBeNull();
  });

  it('补丁为空时返回 null', () => {
    expect(buildReversePatchSet(undefined, createSummary(['a.txt']))).toBeNull();
  });
});
