import { describe, expect, it } from 'vitest';

import type { TAcpToolCall } from '@/types/ai/acp-tool-call';
import type { IAiThread } from '@/types/ai/thread';
import type { TAiThreadReduceEvent } from './events';
import { reduceThread, reduceThreadAll } from './reduce';

const baseThread = (): IAiThread => ({
  id: 't1',
  title: 'T',
  titleStatus: 'temporary',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  entries: [],
});

const acpUpdate = (over: Record<string, unknown>): TAcpToolCall =>
  ({ toolCallId: 'tc1', ...over }) as unknown as TAcpToolCall;

describe('reduce / assistant_tool_call chunk', () => {
  it('在 assistant_message 内建出 tool_call chunk', () => {
    const out = reduceThread(baseThread(), {
      kind: 'assistant_tool_call',
      messageId: 'a1',
      createdAt: '2026-01-01T00:00:01.000Z',
      update: acpUpdate({ title: 'Read file', kind: 'read', status: 'in_progress' }),
    });
    expect(out.entries).toHaveLength(1);
    const entry = out.entries[0];
    if (entry.type !== 'assistant_message') throw new Error('expected assistant_message');
    expect(entry.chunks).toHaveLength(1);
    const chunk = entry.chunks[0];
    if (chunk.type !== 'tool_call') throw new Error('expected tool_call chunk');
    expect(chunk.toolCall.id).toBe('tc1');
    expect(chunk.toolCall.title).toBe('Read file');
    expect(chunk.toolCall.status).toBe('in_progress');
  });

  it('思考 / 工具 / 正文按到达顺序交织在同一 chunks 流', () => {
    const events: TAiThreadReduceEvent[] = [
      {
        kind: 'assistant_delta',
        messageId: 'a1',
        createdAt: 'x',
        channel: 'thought',
        text: '想一下',
      },
      {
        kind: 'assistant_tool_call',
        messageId: 'a1',
        createdAt: 'x',
        update: acpUpdate({ title: 'grep', kind: 'search' }),
      },
      {
        kind: 'assistant_delta',
        messageId: 'a1',
        createdAt: 'x',
        channel: 'message',
        text: '答案',
      },
    ];
    const out = reduceThreadAll(baseThread(), events);
    expect(out.entries).toHaveLength(1);
    const entry = out.entries[0];
    if (entry.type !== 'assistant_message') throw new Error('expected assistant_message');
    expect(entry.chunks.map((c) => c.type)).toEqual(['thought', 'tool_call', 'message']);
  });

  it('同 toolCallId 的 update 原地归并而非新增 chunk', () => {
    const out = reduceThreadAll(baseThread(), [
      {
        kind: 'assistant_tool_call',
        messageId: 'a1',
        createdAt: 'x',
        update: acpUpdate({ title: 'edit', kind: 'edit', status: 'in_progress' }),
      },
      {
        kind: 'assistant_tool_call',
        messageId: 'a1',
        createdAt: 'y',
        update: acpUpdate({ status: 'completed' }),
      },
    ]);
    const entry = out.entries[0];
    if (entry.type !== 'assistant_message') throw new Error('expected assistant_message');
    expect(entry.chunks).toHaveLength(1);
    const chunk = entry.chunks[0];
    if (chunk.type !== 'tool_call') throw new Error('expected tool_call chunk');
    expect(chunk.toolCall.status).toBe('completed');
    expect(chunk.toolCall.title).toBe('edit');
  });

  it('缺 toolCallId 的 update 为 no-op（返回原 thread 引用）', () => {
    const before = baseThread();
    const out = reduceThread(before, {
      kind: 'assistant_tool_call',
      messageId: 'a1',
      createdAt: 'x',
      update: {} as unknown as TAcpToolCall,
    });
    expect(out).toBe(before);
  });
});
