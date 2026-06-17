import { describe, expect, it } from 'vitest';

import type { IAiThreadToolCall, IAiThreadToolCallContent } from '@/types/ai/thread';
import {
  buildAcpThreadToolEntries,
  mapAcpToolCallToThreadEntry,
} from '@/components/business/ai/thread/projection/from-acp-thread-entry';

const toolCall = (overrides: Partial<IAiThreadToolCall> = {}): IAiThreadToolCall => ({
  type: 'tool_call',
  id: 't1',
  createdAt: '2026-06-17T00:00:00.000Z',
  title: 'Read file',
  kind: 'read',
  status: 'pending',
  content: [],
  ...overrides,
});

describe('mapAcpToolCallToThreadEntry — 头部映射', () => {
  it('归一 id / icon / title / status,默认空内容', () => {
    const entry = mapAcpToolCallToThreadEntry('m1', toolCall());
    expect(entry).toMatchObject({
      kind: 'tool-call',
      id: 'm1:acp:t1',
      messageId: 'm1',
      icon: 'file',
      title: 'Read file',
      status: 'pending',
      tags: [],
      content: [],
    });
  });

  it('kind → 图标穷尽映射', () => {
    const iconOf = (kind: IAiThreadToolCall['kind']) =>
      mapAcpToolCallToThreadEntry('m', toolCall({ kind })).icon;
    expect(iconOf('read')).toBe('file');
    expect(iconOf('edit')).toBe('patch');
    expect(iconOf('delete')).toBe('file');
    expect(iconOf('move')).toBe('files');
    expect(iconOf('search')).toBe('catalog');
    expect(iconOf('execute')).toBe('play');
    expect(iconOf('think')).toBe('brain');
    expect(iconOf('fetch')).toBe('globe');
    expect(iconOf('switch_mode')).toBe('plug');
    expect(iconOf('other')).toBe('note');
  });

  it('status → 渲染状态映射', () => {
    const statusOf = (status: IAiThreadToolCall['status']) =>
      mapAcpToolCallToThreadEntry('m', toolCall({ status })).status;
    expect(statusOf('pending')).toBe('pending');
    expect(statusOf('in_progress')).toBe('running');
    expect(statusOf('completed')).toBe('succeeded');
    expect(statusOf('failed')).toBe('failed');
    expect(statusOf('canceled')).toBe('canceled');
  });

  it('标题为空时按 kind 兜底', () => {
    expect(mapAcpToolCallToThreadEntry('m', toolCall({ title: '', kind: 'execute' })).title).toBe(
      'Run',
    );
    expect(mapAcpToolCallToThreadEntry('m', toolCall({ title: '   ', kind: 'other' })).title).toBe(
      'Tool',
    );
  });
});

describe('mapAcpToolCallToThreadEntry — 内容映射', () => {
  it('text / image / resource_link 内容块 → markdown 文本', () => {
    const content: IAiThreadToolCallContent[] = [
      { type: 'content', block: { type: 'text', text: 'hello' } },
      { type: 'content', block: { type: 'image', src: 'https://x/y.png', alt: 'shot' } },
      { type: 'content', block: { type: 'resource_link', uri: 'file:///a.ts', title: 'a.ts' } },
    ];
    const entry = mapAcpToolCallToThreadEntry('m', toolCall({ id: 'tc', content }));
    expect(entry.content).toEqual([
      { type: 'text', id: 'tc:c0', markdown: 'hello' },
      { type: 'text', id: 'tc:c1', markdown: '![shot](https://x/y.png)' },
      { type: 'text', id: 'tc:c2', markdown: '[a.ts](file:///a.ts)' },
    ]);
  });

  it('terminal 内容 → 占位终端,live 时 streaming', () => {
    const content: IAiThreadToolCallContent[] = [{ type: 'terminal', terminalId: 'term-1' }];
    const live = mapAcpToolCallToThreadEntry('m', toolCall({ status: 'in_progress', content }));
    expect(live.content[0]).toEqual({
      type: 'terminal',
      id: 't1:c0',
      title: 'Terminal',
      output: '',
      streaming: true,
    });

    const done = mapAcpToolCallToThreadEntry('m', toolCall({ status: 'completed', content }));
    expect(done.content[0]).toMatchObject({ type: 'terminal', streaming: false });
  });

  it('diff 内容 → 修改文件,按 hunk 行计增删', () => {
    const content: IAiThreadToolCallContent[] = [
      {
        type: 'diff',
        diff: {
          id: 'd',
          title: 'm.ts',
          filePath: 'm.ts',
          diffRef: 'acp-diff:t:m.ts',
          hunks: [
            {
              id: 'h',
              filePath: 'm.ts',
              diffRef: 'acp-diff:t:m.ts',
              header: '@@ -1,3 +1,3 @@',
              lines: [
                { id: 'l1', kind: 'context', content: 'l1' },
                { id: 'l2', kind: 'delete', content: 'l2' },
                { id: 'l3', kind: 'add', content: 'X' },
                { id: 'l4', kind: 'context', content: 'l3' },
              ],
            },
          ],
        },
      },
    ];
    const entry = mapAcpToolCallToThreadEntry('m', toolCall({ content }));
    expect(entry.content[0]).toEqual({
      type: 'diff',
      id: 't1:c0',
      patchSummaryId: 'acp-diff:t:m.ts',
      file: {
        path: 'm.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        diffRef: 'acp-diff:t:m.ts',
      },
    });
  });

  it('diff 全为 @@ -0,0 起始 ⇒ 新建文件', () => {
    const content: IAiThreadToolCallContent[] = [
      {
        type: 'diff',
        diff: {
          id: 'd',
          title: 'new.ts',
          filePath: 'new.ts',
          diffRef: 'acp-diff:t:new.ts',
          hunks: [
            {
              id: 'h',
              filePath: 'new.ts',
              diffRef: 'acp-diff:t:new.ts',
              header: '@@ -0,0 +1,2 @@',
              lines: [
                { id: 'l1', kind: 'add', content: 'a' },
                { id: 'l2', kind: 'add', content: 'b' },
              ],
            },
          ],
        },
      },
    ];
    const entry = mapAcpToolCallToThreadEntry('m', toolCall({ content }));
    expect(entry.content[0]).toMatchObject({
      type: 'diff',
      file: { status: 'added', additions: 2, deletions: 0 },
    });
  });
});

describe('buildAcpThreadToolEntries', () => {
  it('保持入参顺序逐条映射', () => {
    const entries = buildAcpThreadToolEntries('m1', [
      toolCall({ id: 'a' }),
      toolCall({ id: 'b' }),
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(['m1:acp:a', 'm1:acp:b']);
  });

  it('空数组 → 空结果', () => {
    expect(buildAcpThreadToolEntries('m1', [])).toEqual([]);
  });
});
