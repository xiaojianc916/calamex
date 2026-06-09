import { describe, expect, it } from 'vitest';

import type { IAiToolConfirmationRequest } from '@/types/ai';

import { buildToolConfirmationApproval } from './from-tool-confirmation';

const buildConfirmation = (
  overrides: Partial<IAiToolConfirmationRequest> = {},
): IAiToolConfirmationRequest => ({
  id: 'conf-1',
  runId: 'run-1',
  stepId: 'step-1',
  toolName: 'auto_apply_patch',
  question: '是否允许写入文件？',
  summary: '将修改 2 个文件',
  riskLevel: 'medium',
  impact: '编辑 src/a.ts、src/b.ts',
  reversible: true,
  createdAt: '2026-06-08T00:00:00.000Z',
  options: [
    { id: 'allow-once', label: '允许', tone: 'primary' },
    { id: 'view-details', label: '了解更多', tone: 'secondary' },
    { id: 'stop', label: '停止', tone: 'danger' },
  ],
  ...overrides,
});

describe('buildToolConfirmationApproval', () => {
  it('问句映射为标题,过滤 view-details,并分配快捷键与语气', () => {
    const approval = buildToolConfirmationApproval(buildConfirmation());

    expect(approval.title).toBe('是否允许写入文件？');
    expect(approval.options.map((option) => option.id)).toEqual(['allow-once', 'stop']);
    expect(approval.options[0]).toMatchObject({ shortcut: 'y', tone: 'default' });
    expect(approval.options[1]).toMatchObject({ shortcut: 'n', tone: 'danger' });
  });

  it('impact 与 summary 相同时省略 impact', () => {
    const approval = buildToolConfirmationApproval(
      buildConfirmation({ summary: '运行测试', impact: '运行测试' }),
    );

    expect(approval.summary).toBe('运行测试');
    expect(approval.impact).toBeNull();
  });

  it('impact 与 summary 不同时保留 impact', () => {
    const approval = buildToolConfirmationApproval(buildConfirmation());

    expect(approval.summary).toBe('将修改 2 个文件');
    expect(approval.impact).toBe('编辑 src/a.ts、src/b.ts');
  });

  it('问句为空时标题回退到工具名', () => {
    const approval = buildToolConfirmationApproval(buildConfirmation({ question: '   ' }));

    expect(approval.title).toBe('auto_apply_patch');
  });
});
