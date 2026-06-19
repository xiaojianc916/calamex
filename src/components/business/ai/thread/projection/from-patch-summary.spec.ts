import { describe, expect, it } from 'vitest';

import type { IAiAgentPatchSummary } from '@/types/ai/patch';

import { patchSummaryToReduceEvents } from './from-patch-summary';

const NOW = '2026-06-19T00:00:00.000Z';

const makeSummary = (overrides: Partial<IAiAgentPatchSummary> = {}): IAiAgentPatchSummary => ({
  id: 'patch-1',
  runId: 'run-1',
  stepId: 'step-1',
  files: [
    {
      path: 'src/a.ts',
      status: 'modified',
      additions: 3,
      deletions: 1,
      diffRef: 'diff-ref-1',
    },
  ],
  totalAdditions: 3,
  totalDeletions: 1,
  patchRef: 'patch-ref-1',
  ...overrides,
});

describe('patchSummaryToReduceEvents', () => {
  it('把摘要直通为一条 changed_files 事件（id 取 summary.id，summary 原样透传）', () => {
    const summary = makeSummary();

    const events = patchSummaryToReduceEvents(summary, { now: NOW });

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.kind).toBe('changed_files');
    if (event?.kind === 'changed_files') {
      expect(event.id).toBe('patch-1');
      expect(event.createdAt).toBe(NOW);
      expect(event.summary).toBe(summary);
    }
  });

  it('createdAt 优先取 appliedAt（首次应用时刻），无 appliedAt 时回退 now', () => {
    const appliedAt = '2026-06-19T01:02:03.000Z';

    const events = patchSummaryToReduceEvents(makeSummary({ appliedAt }), { now: NOW });

    const event = events[0];
    expect(event?.kind).toBe('changed_files');
    if (event?.kind === 'changed_files') {
      expect(event.createdAt).toBe(appliedAt);
    }
  });
});
