import { describe, expect, it } from 'vitest';

import type { IAiPatchSet } from '@/types/ai';
import {
  buildAiAgentPatchSummaryFromAedDiffs,
  buildAiAgentPatchSummaryFromApplyResult,
  buildAiAedPatchRef,
  countAiPatchFileLineStats,
  parseAiAedPatchRef,
} from '@/utils/ai-patch-summary';

const createPatch = (): IAiPatchSet => ({
  summary: '更新 Agent 计划面板',
  files: [
    {
      path: 'D:/workspace/src/App.vue',
      originalHash: 'fnv64:app',
      hunks: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 3,
          lines: [
            '--- a/src/App.vue',
            '+++ b/src/App.vue',
            ' const a = 1;',
            '-const oldValue = true;',
            '+const nextValue = true;',
            '+const enabled = true;',
          ],
        },
      ],
    },
    {
      path: 'D:/workspace/src/unused.ts',
      originalHash: 'fnv64:unused',
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ['-export const unused = true;', '+export const unused = false;'],
        },
      ],
    },
  ],
});

describe('ai-patch-summary utils', () => {
  it('counts additions and deletions while ignoring diff headers', () => {
    const patch = createPatch();
    const firstFile = patch.files[0];

    expect(firstFile).toBeDefined();
    if (!firstFile) {
      return;
    }

    expect(countAiPatchFileLineStats(firstFile)).toEqual({
      additions: 2,
      deletions: 1,
    });
  });

  it('builds an AED patch ref without storing patch body', () => {
    expect(buildAiAedPatchRef('thread:1')).toBe('aed-patch:thread%3A1');
    expect(parseAiAedPatchRef('aed-patch:thread%3A1')).toBe('thread:1');
    expect(parseAiAedPatchRef('patch:thread%3A1')).toBeNull();
  });

  it('converts AED create, delete and modify diffs into the same changed-files summary', () => {
    const summary = buildAiAgentPatchSummaryFromAedDiffs({
      taskId: 'thread:1',
      runId: 'run-1',
      stepId: 'step-2',
      appliedAt: '2026-04-29T10:00:00.000Z',
      diffs: [
        {
          taskId: 'thread:1',
          path: 'D:/workspace/src/new.ts',
          operationId: 'op-create',
          kind: 'create',
          additions: 2,
          deletions: 0,
          hunks: [
            {
              hunkIndex: 0,
              oldStart: 0,
              oldLines: 0,
              newStart: 1,
              newLines: 2,
              lines: ['+export const created = true;', '+export const ready = true;'],
            },
          ],
        },
        {
          taskId: 'thread:1',
          path: 'D:/workspace/src/old.ts',
          operationId: 'op-delete',
          kind: 'delete',
          additions: 0,
          deletions: 1,
          hunks: [
            {
              hunkIndex: 0,
              oldStart: 1,
              oldLines: 1,
              newStart: 0,
              newLines: 0,
              lines: ['-export const removed = true;'],
            },
          ],
        },
        {
          taskId: 'thread:1',
          path: 'D:/workspace/src/app.ts',
          operationId: 'op-modify',
          kind: 'modify',
          additions: 1,
          deletions: 1,
          hunks: [
            {
              hunkIndex: 0,
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ['-const oldValue = true;', '+const nextValue = true;'],
            },
          ],
        },
      ],
    });

    expect(summary).toMatchObject({
      runId: 'run-1',
      stepId: 'step-2',
      totalAdditions: 3,
      totalDeletions: 2,
      patchRef: 'aed-patch:thread%3A1',
    });
    expect(summary?.files.map((file) => file.status)).toEqual(['added', 'deleted', 'modified']);
  });

  it('converts successful apply result into an Agent patch summary', () => {
    const summary = buildAiAgentPatchSummaryFromApplyResult({
      patch: createPatch(),
      applyResult: {
        appliedFiles: [
          {
            path: String.raw`\\?\D:\workspace\src\App.vue`,
            byteSize: 128,
          },
        ],
      },
      taskId: 'thread:1',
      runId: 'run-1',
      stepId: 'step-2',
      appliedAt: '2026-04-29T10:00:00.000Z',
    });

    expect(summary).toMatchObject({
      runId: 'run-1',
      stepId: 'step-2',
      totalAdditions: 2,
      totalDeletions: 1,
      patchRef: 'aed-patch:thread%3A1',
      appliedAt: '2026-04-29T10:00:00.000Z',
    });
    expect(summary?.files).toEqual([
      {
        path: 'D:/workspace/src/App.vue',
        status: 'modified',
        additions: 2,
        deletions: 1,
        diffRef: 'aed-diff:thread%3A1:D%3A%2Fworkspace%2Fsrc%2FApp.vue',
      },
    ]);
  });

  it('returns null when there is no active Agent run metadata or applied file', () => {
    expect(buildAiAgentPatchSummaryFromApplyResult({
      patch: createPatch(),
      applyResult: { appliedFiles: [] },
      taskId: 'thread-1',
      runId: 'run-1',
      stepId: 'step-1',
      appliedAt: '2026-04-29T10:00:00.000Z',
    })).toBeNull();

    expect(buildAiAgentPatchSummaryFromApplyResult({
      patch: createPatch(),
      applyResult: {
        appliedFiles: [
          {
            path: 'D:/workspace/src/App.vue',
            byteSize: 128,
          },
        ],
      },
      taskId: '',
      runId: 'run-1',
      stepId: 'step-1',
      appliedAt: '2026-04-29T10:00:00.000Z',
    })).toBeNull();
  });
});
