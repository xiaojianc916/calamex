import { describe, expect, it } from 'vitest';

import type { IAiThreadToolCall } from '@/types/ai/thread';

import { toAiThreadToolView } from './tool-view';

const baseToolCall = (overrides: Partial<IAiThreadToolCall> = {}): IAiThreadToolCall => ({
  type: 'tool_call',
  id: 'tool-1',
  createdAt: '2026-06-17T00:00:00.000Z',
  title: 'Read file',
  kind: 'read',
  status: 'pending',
  content: [],
  ...overrides,
});

describe('toAiThreadToolView', () => {
  it('由 kind 派生图标、透传 title、映射展示态', () => {
    const view = toAiThreadToolView(
      baseToolCall({ kind: 'edit', title: 'Edit file', status: 'in_progress' }),
    );
    expect(view.icon).toBe('patch');
    expect(view.title).toBe('Edit file');
    expect(view.status).toBe('running');
  });

  it('协议状态逐一映射到展示态', () => {
    expect(toAiThreadToolView(baseToolCall({ status: 'pending' })).status).toBe('pending');
    expect(toAiThreadToolView(baseToolCall({ status: 'in_progress' })).status).toBe('running');
    expect(toAiThreadToolView(baseToolCall({ status: 'completed' })).status).toBe('succeeded');
    expect(toAiThreadToolView(baseToolCall({ status: 'failed' })).status).toBe('failed');
    expect(toAiThreadToolView(baseToolCall({ status: 'canceled' })).status).toBe('canceled');
  });

  it('未知 kind 兑底为 system 图标', () => {
    expect(toAiThreadToolView(baseToolCall({ kind: 'other' })).icon).toBe('system');
  });

  it('审批队列派生 awaiting-confirmation,仅覆盖未完成态', () => {
    const deps = { isAwaitingApproval: (id: string) => id === 'tool-1' };
    expect(toAiThreadToolView(baseToolCall({ status: 'pending' }), deps).status).toBe(
      'awaiting-confirmation',
    );
    expect(toAiThreadToolView(baseToolCall({ status: 'in_progress' }), deps).status).toBe(
      'awaiting-confirmation',
    );
    expect(toAiThreadToolView(baseToolCall({ status: 'completed' }), deps).status).toBe('succeeded');
  });

  it('content 文本块 → text,并合成稳定 id', () => {
    const view = toAiThreadToolView(
      baseToolCall({ content: [{ type: 'content', block: { type: 'text', text: 'hello' } }] }),
    );
    expect(view.content).toEqual([{ type: 'text', id: 'tool-1:c0', markdown: 'hello' }]);
  });

  it('图片 / 资源链接 / 来源块回退为 markdown,不静默丢弃', () => {
    const view = toAiThreadToolView(
      baseToolCall({
        content: [
          { type: 'content', block: { type: 'image', src: 'img.png', alt: 'shot' } },
          { type: 'content', block: { type: 'resource_link', uri: 'u', title: 'r' } },
          { type: 'content', block: { type: 'source', url: 'https://x', title: 's' } },
        ],
      }),
    );
    expect(view.content.map((c) => c.type)).toEqual(['text', 'text', 'text']);
    expect((view.content[0] as { markdown: string }).markdown).toBe('![shot](img.png)');
    expect((view.content[1] as { markdown: string }).markdown).toBe('[r](u)');
    expect((view.content[2] as { markdown: string }).markdown).toBe('[s](https://x)');
  });

  it('diff 块由 hunks 派生增删行数并透传 hunks', () => {
    const view = toAiThreadToolView(
      baseToolCall({
        content: [
          {
            type: 'diff',
            diff: {
              id: 'd1',
              title: 'edit',
              filePath: 'src/a.ts',
              diffRef: 'ref',
              hunks: [
                {
                  id: 'h1',
                  filePath: 'src/a.ts',
                  diffRef: 'ref',
                  header: '@@ -1 +1 @@',
                  lines: [
                    { id: 'l1', kind: 'add', content: 'a' },
                    { id: 'l2', kind: 'add', content: 'b' },
                    { id: 'l3', kind: 'delete', content: 'c' },
                    { id: 'l4', kind: 'context', content: 'd' },
                  ],
                },
              ],
            },
          },
        ],
      }),
    );
    expect(view.content[0]).toMatchObject({
      type: 'diff',
      id: 'tool-1:c0',
      filePath: 'src/a.ts',
      additions: 2,
      deletions: 1,
    });
  });

  it('terminal 经注册表查询;查不到时回退占位', () => {
    const withSnapshot = toAiThreadToolView(
      baseToolCall({ content: [{ type: 'terminal', terminalId: 't1' }] }),
      {
        resolveTerminal: (id) =>
          id === 't1' ? { title: 'bash', output: 'done', streaming: false } : undefined,
      },
    );
    expect(withSnapshot.content[0]).toEqual({
      type: 'terminal',
      id: 'tool-1:c0',
      title: 'bash',
      output: 'done',
      streaming: false,
    });

    const fallback = toAiThreadToolView(
      baseToolCall({ content: [{ type: 'terminal', terminalId: 't1' }] }),
    );
    expect(fallback.content[0]).toEqual({
      type: 'terminal',
      id: 'tool-1:c0',
      title: 'Terminal',
      output: '',
      streaming: false,
    });
  });

  it('rawInput/rawOutput 前后包夹为 raw 块,对象序列化为 JSON', () => {
    const view = toAiThreadToolView(
      baseToolCall({
        rawInput: { path: 'a.ts' },
        rawOutput: 'ok',
        content: [{ type: 'content', block: { type: 'text', text: 'mid' } }],
      }),
    );
    expect(view.content[0]).toEqual({
      type: 'raw',
      id: 'tool-1:raw-input',
      title: 'Raw Input',
      code: '{\n  "path": "a.ts"\n}',
    });
    expect(view.content[1]).toMatchObject({ type: 'text', markdown: 'mid' });
    expect(view.content[2]).toEqual({
      type: 'raw',
      id: 'tool-1:raw-output',
      title: 'Output',
      code: 'ok',
    });
  });
});
