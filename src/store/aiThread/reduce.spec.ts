import { describe, expect, it } from 'vitest';

import type { TAiThreadReduceEvent } from '@/store/aiThread/events';
import { nextToolStatus, reduceThread, reduceThreadAll } from '@/store/aiThread/reduce';
import type { IAiThread, IAiThreadAssistantMessageEntry, IAiThreadToolCall } from '@/types/ai/thread';

const ISO = '2026-06-14T09:00:00.000Z';

const createThread = (): IAiThread => ({
  id: 'thread-1',
  title: '重构',
  titleStatus: 'temporary',
  createdAt: ISO,
  updatedAt: ISO,
  entries: [],
});

describe('reduceThread', () => {
  it('回放一整段流：user / 思维+正文交织 / tool / 完成', () => {
    const events: TAiThreadReduceEvent[] = [
      { kind: 'user_message', id: 'u1', createdAt: ISO, blocks: [{ type: 'text', text: '为什么丝滑？' }] },
      { kind: 'assistant_delta', messageId: 'a1', createdAt: ISO, channel: 'thought', text: '思考' },
      { kind: 'assistant_delta', messageId: 'a1', createdAt: ISO, channel: 'thought', text: '中' },
      { kind: 'assistant_delta', messageId: 'a1', createdAt: ISO, channel: 'message', text: '根因' },
      { kind: 'assistant_delta', messageId: 'a1', createdAt: ISO, channel: 'message', text: '在数据模型' },
      { kind: 'tool_started', id: 't1', createdAt: ISO, title: 'Search', toolKind: 'search' },
      { kind: 'tool_progress', id: 't1', appendContent: [{ type: 'content', block: { type: 'text', text: 'hit' } }] },
      { kind: 'tool_completed', id: 't1', ok: true },
      { kind: 'stream_completed' },
    ];

    const result = reduceThreadAll(createThread(), events);

    expect(result.entries.map((e) => e.type)).toEqual([
      'user_message',
      'assistant_message',
      'tool_call',
    ]);

    const assistant = result.entries[1] as IAiThreadAssistantMessageEntry;
    // 同通道连续 delta 合并：2 thought-delta 合 1，2 message-delta 合 1
    expect(assistant.chunks).toHaveLength(2);
    expect(assistant.chunks[0]).toMatchObject({ type: 'thought', block: { text: '思考中' } });
    expect(assistant.chunks[1]).toMatchObject({ type: 'message', block: { text: '根因在数据模型' } });

    const tool = result.entries[2] as IAiThreadToolCall;
    expect(tool.status).toBe('completed');
    expect(tool.content).toHaveLength(1);
  });

  it('不突变输入（纯函数 / 结构共享）', () => {
    const base = createThread();
    const next = reduceThread(base, {
      kind: 'user_message',
      id: 'u1',
      createdAt: ISO,
      blocks: [{ type: 'text', text: 'hi' }],
    });
    expect(base.entries).toHaveLength(0);
    expect(next.entries).toHaveLength(1);
    expect(next).not.toBe(base);
  });

  it('tool_call 按 id upsert，不重复 append', () => {
    let thread = createThread();
    thread = reduceThread(thread, { kind: 'tool_started', id: 't1', createdAt: ISO, title: 'A', toolKind: 'read' });
    thread = reduceThread(thread, { kind: 'tool_progress', id: 't1' });
    thread = reduceThread(thread, { kind: 'tool_started', id: 't1', createdAt: ISO, title: 'A', toolKind: 'read' });
    expect(thread.entries.filter((e) => e.type === 'tool_call')).toHaveLength(1);
  });

  it('终态不可回退：completed 后的 progress 不降级', () => {
    let thread = createThread();
    thread = reduceThread(thread, { kind: 'tool_started', id: 't1', createdAt: ISO, title: 'A', toolKind: 'execute' });
    thread = reduceThread(thread, { kind: 'tool_completed', id: 't1', ok: true });
    thread = reduceThread(thread, { kind: 'tool_progress', id: 't1' });
    expect((thread.entries[0] as IAiThreadToolCall).status).toBe('completed');
  });

  it('stream_cancelled 把所有非终态 tool 收敛为 canceled', () => {
    let thread = createThread();
    thread = reduceThread(thread, { kind: 'tool_started', id: 't1', createdAt: ISO, title: 'A', toolKind: 'execute' });
    thread = reduceThread(thread, { kind: 'tool_started', id: 't2', createdAt: ISO, title: 'B', toolKind: 'search' });
    thread = reduceThread(thread, { kind: 'tool_completed', id: 't2', ok: true });
    thread = reduceThread(thread, { kind: 'stream_cancelled' });
    expect((thread.entries[0] as IAiThreadToolCall).status).toBe('canceled');
    // 已终态的不受影响
    expect((thread.entries[1] as IAiThreadToolCall).status).toBe('completed');
  });

  it('对不存在的 tool 的 progress 被忽略（不创建条目）', () => {
    const thread = reduceThread(createThread(), { kind: 'tool_progress', id: 'ghost' });
    expect(thread.entries).toHaveLength(0);
  });

  it('nextToolStatus 状态机', () => {
    expect(nextToolStatus('pending', 'in_progress')).toBe('in_progress');
    expect(nextToolStatus('in_progress', 'completed')).toBe('completed');
    expect(nextToolStatus('completed', 'in_progress')).toBe('completed');
    expect(nextToolStatus('failed', 'completed')).toBe('failed');
  });
});
