import { describe, expect, it } from 'vitest';

import { buildAcpPermissionApproval, type IAcpPermissionRequest } from './from-acp-permission';

const buildRequest = (overrides: Partial<IAcpPermissionRequest> = {}): IAcpPermissionRequest => ({
  sessionId: 'sess-1',
  toolCallId: 'tool-1',
  options: [
    { optionId: 'allow-once', name: '允许一次', kind: 'allow_once' },
    { optionId: 'allow-always', name: '始终允许', kind: 'allow_always' },
    { optionId: 'reject-once', name: '拒绝一次', kind: 'reject_once' },
    { optionId: 'reject-always', name: '始终拒绝', kind: 'reject_always' },
  ],
  ...overrides,
});

describe('buildAcpPermissionApproval', () => {
  it('逐字保留 optionId 作为决策 id，并按 kind 分配语气与快捷键', () => {
    const approval = buildAcpPermissionApproval(buildRequest());

    expect(approval.options.map((option) => option.id)).toEqual([
      'allow-once',
      'allow-always',
      'reject-once',
      'reject-always',
    ]);
    expect(approval.options[0]).toMatchObject({ label: '允许一次', shortcut: 'y', tone: 'default' });
    expect(approval.options[1]).toMatchObject({ shortcut: 'a', tone: 'default' });
    expect(approval.options[2]).toMatchObject({ shortcut: 'n', tone: 'danger' });
    expect(approval.options[3]).toMatchObject({ tone: 'danger' });
    expect(approval.options[3].shortcut).toBeUndefined();
  });

  it('other kind 透传 name 且不分配快捷键 / 危险语气', () => {
    const approval = buildAcpPermissionApproval(
      buildRequest({ options: [{ optionId: 'custom', name: '自定义', kind: 'other' }] }),
    );

    expect(approval.options[0]).toMatchObject({ id: 'custom', label: '自定义', tone: 'default' });
    expect(approval.options[0].shortcut).toBeUndefined();
  });

  it('未提供标题时回退到通用提示，并归一空 summary / impact', () => {
    const approval = buildAcpPermissionApproval(buildRequest());

    expect(approval.title).toBe('是否允许此工具调用？');
    expect(approval.summary).toBeNull();
    expect(approval.impact).toBeNull();
  });

  it('提供上下文标题与影响时透传；impact 等于 summary 时省略', () => {
    const approval = buildAcpPermissionApproval(buildRequest(), {
      title: '执行命令 rm -rf build',
      summary: '运行 shell 命令',
      impact: '运行 shell 命令',
    });

    expect(approval.title).toBe('执行命令 rm -rf build');
    expect(approval.summary).toBe('运行 shell 命令');
    expect(approval.impact).toBeNull();
  });
});
