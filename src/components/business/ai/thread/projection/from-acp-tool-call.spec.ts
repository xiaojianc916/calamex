import { describe, expect, it } from 'vitest';
import {
  getAcpToolCallId,
  reduceAcpToolCall,
} from '@/components/business/ai/thread/projection/from-acp-tool-call';
import type { TAcpToolCall, TAcpToolCallUpdate } from '@/types/ai/acp-tool-call';

const NOW = '2026-06-17T00:00:00.000Z';

const toolCall = (extra: Record<string, unknown>): TAcpToolCall =>
  ({ sessionUpdate: 'tool_call', ...extra }) as unknown as TAcpToolCall;

const toolCallUpdate = (extra: Record<string, unknown>): TAcpToolCallUpdate =>
  ({ sessionUpdate: 'tool_call_update', ...extra }) as unknown as TAcpToolCallUpdate;

describe('reduceAcpToolCall — 首帧建条目', () => {
  it('归一 id / title / kind / status，content 默认空', () => {
    const entry = reduceAcpToolCall(
      undefined,
      toolCall({ toolCallId: 't1', title: 'Read file', kind: 'read', status: 'pending' }),
      { now: NOW },
    );
    expect(entry).toMatchObject({
      type: 'tool_call',
      id: 't1',
      createdAt: NOW,
      title: 'Read file',
      kind: 'read',
      status: 'pending',
      content: [],
    });
  });

  it('未知 kind 兑底 other；缺省 title→空串、缺省 status→pending', () => {
    const entry = reduceAcpToolCall(undefined, toolCall({ toolCallId: 't', kind: 'frobnicate' }), {
      now: NOW,
    });
    expect(entry.kind).toBe('other');
    expect(entry.title).toBe('');
    expect(entry.status).toBe('pending');
  });

  it('透传 rawInput / rawOutput', () => {
    const entry = reduceAcpToolCall(
      undefined,
      toolCall({ toolCallId: 't', rawInput: { a: 1 }, rawOutput: 'ok' }),
      { now: NOW },
    );
    expect(entry.rawInput).toEqual({ a: 1 });
    expect(entry.rawOutput).toBe('ok');
  });
});

describe('reduceAcpToolCall — 按 toolCallId 合并', () => {
  it('update 仅覆盖出现的字段，createdAt 保持不变', () => {
    const first = reduceAcpToolCall(
      undefined,
      toolCall({ toolCallId: 't', title: 'Run', kind: 'execute', status: 'pending' }),
      { now: NOW },
    );
    const next = reduceAcpToolCall(
      first,
      toolCallUpdate({ toolCallId: 't', status: 'completed' }),
      {
        now: '2026-06-17T00:01:00.000Z',
      },
    );
    expect(next.status).toBe('completed');
    expect(next.title).toBe('Run');
    expect(next.kind).toBe('execute');
    expect(next.createdAt).toBe(NOW);
  });

  it('content 出现即整体替换，缺省则保留旧值', () => {
    const first = reduceAcpToolCall(
      undefined,
      toolCall({
        toolCallId: 't',
        content: [{ type: 'content', content: { type: 'text', text: 'a' } }],
      }),
      { now: NOW },
    );
    expect(first.content).toHaveLength(1);

    const keep = reduceAcpToolCall(
      first,
      toolCallUpdate({ toolCallId: 't', status: 'in_progress' }),
    );
    expect(keep.content).toBe(first.content);

    const replaced = reduceAcpToolCall(
      first,
      toolCallUpdate({
        toolCallId: 't',
        content: [{ type: 'content', content: { type: 'text', text: 'b' } }],
      }),
    );
    expect(replaced.content).toEqual([{ type: 'content', block: { type: 'text', text: 'b' } }]);
  });
});

describe('reduceAcpToolCall — ContentBlock 归一', () => {
  it('text / image(uri) / image(data) / resource_link / terminal', () => {
    const entry = reduceAcpToolCall(
      undefined,
      toolCall({
        toolCallId: 't',
        content: [
          { type: 'content', content: { type: 'text', text: 'hello' } },
          { type: 'content', content: { type: 'image', uri: 'https://x/y.png' } },
          { type: 'content', content: { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' } },
          {
            type: 'content',
            content: { type: 'resource_link', uri: 'file:///a.ts', name: 'a.ts' },
          },
          { type: 'terminal', terminalId: 'term-1' },
          { type: 'content', content: { type: 'audio', data: 'zz', mimeType: 'audio/mp3' } },
        ],
      }),
      { now: NOW },
    );
    expect(entry.content).toEqual([
      { type: 'content', block: { type: 'text', text: 'hello' } },
      { type: 'content', block: { type: 'image', src: 'https://x/y.png' } },
      { type: 'content', block: { type: 'image', src: 'data:image/jpeg;base64,AAAA' } },
      { type: 'content', block: { type: 'resource_link', uri: 'file:///a.ts', title: 'a.ts' } },
      { type: 'terminal', terminalId: 'term-1' },
    ]);
  });
});

describe('reduceAcpToolCall — diff 归一', () => {
  it('新文件：全部为新增行，oldStart=0', () => {
    const entry = reduceAcpToolCall(
      undefined,
      toolCall({
        toolCallId: 't',
        content: [{ type: 'diff', path: '/repo/new.ts', oldText: null, newText: 'a\nb' }],
      }),
      { now: NOW },
    );
    expect(entry.content).toHaveLength(1);
    const item = entry.content[0];
    expect(item.type).toBe('diff');
    if (item.type !== 'diff') throw new Error('expected diff');
    expect(item.diff.filePath).toBe('/repo/new.ts');
    expect(item.diff.hunks).toHaveLength(1);
    const hunk = item.diff.hunks[0];
    expect(hunk.lines.map((l) => l.kind)).toEqual(['add', 'add']);
    expect(hunk.lines.map((l) => l.content)).toEqual(['a', 'b']);
    expect(hunk.header).toBe('@@ -0,0 +1,2 @@');
  });

  it('单区段修改：前缀/后缀裁剪为 context + delete + add', () => {
    const entry = reduceAcpToolCall(
      undefined,
      toolCall({
        toolCallId: 't',
        content: [{ type: 'diff', path: 'm.ts', oldText: 'l1\nl2\nl3', newText: 'l1\nX\nl3' }],
      }),
      { now: NOW },
    );
    const item = entry.content[0];
    if (item.type !== 'diff') throw new Error('expected diff');
    const hunk = item.diff.hunks[0];
    expect(hunk.lines.map((l) => [l.kind, l.content])).toEqual([
      ['context', 'l1'],
      ['delete', 'l2'],
      ['add', 'X'],
      ['context', 'l3'],
    ]);
    expect(hunk.header).toBe('@@ -1,3 +1,3 @@');
    expect(item.diff.diffRef).toBe('acp-diff:t:m.ts');
  });
});

describe('reduceAcpToolCall — locations 归一', () => {
  it('映射 { path, line }，过滤无 path 项、非对象项与非法行号', () => {
    const entry = reduceAcpToolCall(
      undefined,
      toolCall({
        toolCallId: 't',
        locations: [
          { path: 'src/a.ts', line: 12 },
          { path: 'src/b.ts' },
          { line: 3 },
          null,
          'nope',
          { path: 'src/c.ts', line: -1 },
          { path: 'src/d.ts', line: 1.5 },
        ],
      }),
      { now: NOW },
    );
    expect(entry.locations).toEqual([
      { path: 'src/a.ts', line: 12 },
      { path: 'src/b.ts' },
      { path: 'src/c.ts' },
      { path: 'src/d.ts' },
    ]);
  });

  it('缺省 locations → undefined（首帧不伪造）', () => {
    const entry = reduceAcpToolCall(undefined, toolCall({ toolCallId: 't' }), { now: NOW });
    expect(entry.locations).toBeUndefined();
  });

  it('update：出现即整体替换，缺省保留旧值，空数组清空', () => {
    const first = reduceAcpToolCall(
      undefined,
      toolCall({ toolCallId: 't', locations: [{ path: 'src/a.ts', line: 1 }] }),
      { now: NOW },
    );
    expect(first.locations).toEqual([{ path: 'src/a.ts', line: 1 }]);

    const keep = reduceAcpToolCall(
      first,
      toolCallUpdate({ toolCallId: 't', status: 'in_progress' }),
    );
    expect(keep.locations).toEqual([{ path: 'src/a.ts', line: 1 }]);

    const replaced = reduceAcpToolCall(
      first,
      toolCallUpdate({ toolCallId: 't', locations: [{ path: 'src/b.ts' }] }),
    );
    expect(replaced.locations).toEqual([{ path: 'src/b.ts' }]);

    const cleared = reduceAcpToolCall(first, toolCallUpdate({ toolCallId: 't', locations: [] }));
    expect(cleared.locations).toEqual([]);
  });
});

describe('getAcpToolCallId', () => {
  it('返回 toolCallId，缺失时返回空串', () => {
    expect(getAcpToolCallId(toolCall({ toolCallId: 'abc' }))).toBe('abc');
    expect(getAcpToolCallId(toolCall({}))).toBe('');
  });
});
