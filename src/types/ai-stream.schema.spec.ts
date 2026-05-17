import { describe, expect, it } from 'vitest';

import { aiAgentStreamEventSchema } from '@/types/ai-stream.schema';

describe('AI Agent stream schema', () => {
  it('validates patch.summary event without patch body', () => {
    const parsed = aiAgentStreamEventSchema.parse({
      event: 'patch.summary',
      seq: 1,
      runId: 'run-1',
      summary: {
        id: 'patch-summary-1',
        runId: 'run-1',
        stepId: 'step-1',
        files: [{
          path: 'src/App.vue',
          status: 'modified',
          additions: 3,
          deletions: 1,
          diffRef: 'aed-diff:thread-1:src%2FApp.vue',
        }],
        totalAdditions: 3,
        totalDeletions: 1,
        patchRef: 'aed-patch:thread-1',
      },
    });

    expect(parsed.event).toBe('patch.summary');
    expect('patch' in parsed).toBe(false);
  });

  it('rejects unknown stream event names', () => {
    const parsed = aiAgentStreamEventSchema.safeParse({
      event: 'patch.raw',
      seq: 1,
      runId: 'run-1',
    });

    expect(parsed.success).toBe(false);
  });

  it('validates tool.confirmation event for inline confirmation UI', () => {
    const parsed = aiAgentStreamEventSchema.parse({
      event: 'tool.confirmation',
      seq: 2,
      runId: 'run-1',
      confirmation: {
        id: 'confirmation-1',
        runId: 'run-1',
        stepId: 'step-1',
        toolName: 'run_test',
        question: '允许 Agent 使用 run_test 吗？',
        summary: '步骤请求运行测试。',
        riskLevel: 'medium',
        reversible: true,
        createdAt: '2026-04-29T10:00:00.000Z',
        options: [
          { id: 'allow-once', label: '允许', tone: 'primary' },
          { id: 'stop', label: '拒绝', tone: 'danger' },
        ],
      },
    });

    expect(parsed.event).toBe('tool.confirmation');
  });

  it('accepts Rust tool.activity event with nullable optional fields', () => {
    const parsed = aiAgentStreamEventSchema.parse({
      event: 'tool.activity',
      seq: 3,
      runId: 'agent-tool-loop-1',
      activity: {
        id: 'activity-read-current-file',
        stepId: 'tool-call-step:read_current_file:call-1',
        toolName: 'read_current_file',
        state: 'running',
        label: '正在读取当前文件…',
        targetPreview: null,
        startedAt: '2026-04-29T10:00:00.000Z',
        elapsedMs: null,
      },
    });

    expect(parsed.event).toBe('tool.activity');
    expect(parsed.activity.targetPreview).toBeUndefined();
    expect(parsed.activity.elapsedMs).toBeUndefined();
  });
});
