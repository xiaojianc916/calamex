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
  it('text / image(uri) / image(data) / resource_link / terminal / audio', () => {
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
      {
        type: 'content',
        block: { type: 'resource_link', uri: 'data:audio/mp3;base64,zz', title: 'Audio' },
      },
    ]);
  });
});

describe('reduceAcpToolCall — source / audio 归一（缺口修复）', () => {
  it('http(s) resource_link → source 富块；file:// 等保持 resource_link', () => {
    const entry = reduceAcpToolCall(
      undefined,
      toolCall({
        toolCallId: 't',
        content: [
          {
            type: 'content',
            content: { type: 'resource_link', uri: 'https://acp.dev/spec', title: 'ACP' },
          },
          {
            type: 'content',
            content: { type: 'resource_link', uri: 'file:///a.ts', name: 'a.ts' },
          },
        ],
      }),
      { now: NOW },
    );
    expect(entry.content).toEqual([
      { type: 'content', block: { type: 'source', url: 'https://acp.dev/spec', title: 'ACP' } },
      { type: 'content', block: { type: 'resource_link', uri: 'file:///a.ts', title: 'a.ts' } },
    ]);
  });

  it('audio 退化为 resource_link（data→data: URI / uri 直传），不再静默丢弃', () => {
    const entry = reduceAcpToolCall(
      undefined,
      toolCall({
        toolCallId: 't',
        content: [
          { type: 'content', content: { type: 'audio', data: 'zz', mimeType: 'audio/mp3' } },
          {
            type: 'content',
            content: { type: 'audio', uri: 'https://x/a.mp3', title: 'clip' },
          },
        ],
      }),
      { now: NOW },
    );
    expect(entry.content).toEqual([
      {
        type: 'content',
        block: { type: 'resource_link', uri: 'data:audio/mp3;base64,zz', title: 'Audio' },
      },
      { type: 'content', block: { type: 'resource_link', uri: 'https://x/a.mp3', title: 'clip' } },
    ]);
  });
});

describe('reduceAcpToolCall — diff 归一', () => {
  it('单区段编辑生成行级 hunk（含上下文 + 头部计数）', () => {
    const entry = reduceAcpToolCall(
      undefined,
      toolCall({
        toolCallId: 't',
        content: [
          {
            type: 'diff',
            path: 'a.ts',
            oldText: 'l1\nl2\nOLD\nl4\nl5',
            newText: 'l1\nl2\nNEW\nl4\nl5',
          },
        ],
      }),
      { now: NOW },
    );
    expect(entry.content).toHaveLength(1);
    const item = entry.content[0];
    expect(item.type).toBe('diff');
    if (item.type !== 'diff') return;
    expect(item.diff.filePath).toBe('a.ts');
    expect(item.diff.hunks).toHaveLength(1);
    const hunk = item.diff.hunks[0];
    expect(hunk.header).toBe('@@ -1,5 +1,5 @@');
    expect(hunk.lines.map((line) => `${line.kind}:${line.content}`)).toEqual([
      'context:l1',
      'context:l2',
      'delete:OLD',
      'add:NEW',
      'context:l4',
      'context:l5',
    ]);
  });
});

describe('reduceAcpToolCall — locations 归一', () => {
  it('过滤无 path 项，line 仅接受非负整数；空数组合法', () => {
    const entry = reduceAcpToolCall(
      undefined,
      toolCall({
        toolCallId: 't',
        locations: [
          { path: 'a.ts', line: 10 },
          { path: 'b.ts' },
          { path: 'c.ts', line: -1 },
          { line: 5 },
          'nope',
        ],
      }),
      { now: NOW },
    );
    expect(entry.locations).toEqual([{ path: 'a.ts', line: 10 }, { path: 'b.ts' }, { path: 'c.ts' }]);
  });

  it('locations 缺省则保留旧值', () => {
    const first = reduceAcpToolCall(
      undefined,
      toolCall({ toolCallId: 't', locations: [{ path: 'a.ts' }] }),
      { now: NOW },
    );
    const next = reduceAcpToolCall(first, toolCallUpdate({ toolCallId: 't', status: 'completed' }));
    expect(next.locations).toEqual([{ path: 'a.ts' }]);
  });
});

describe('getAcpToolCallId', () => {
  it('取 toolCallId；缺失或空串返回空串', () => {
    expect(getAcpToolCallId(toolCall({ toolCallId: 't' }))).toBe('t');
    expect(getAcpToolCallId(toolCall({}))).toBe('');
    expect(getAcpToolCallId(toolCall({ toolCallId: '' }))).toBe('');
  });
});
