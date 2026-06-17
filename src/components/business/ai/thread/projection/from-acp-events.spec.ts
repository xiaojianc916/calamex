import { describe, expect, it } from 'vitest';

import type { TAgentUiEvent } from '@/types/ai/sidecar';
import type { TAcpToolCall, TAcpToolCallUpdate } from '@/types/ai/acp-tool-call';
import {
  applyAcpUiEvent,
  createAcpToolCallAccumulator,
  reduceAcpUiEventsToToolCalls,
  selectAcpToolCalls,
} from '@/components/business/ai/thread/projection/from-acp-events';

const NOW = '2026-06-17T00:00:00.000Z';

const toolCallEvent = (extra: Record<string, unknown>): TAgentUiEvent => ({
  type: 'tool_call',
  acpUpdate: { sessionUpdate: 'tool_call', ...extra } as unknown as TAcpToolCall,
});

const toolCallUpdateEvent = (extra: Record<string, unknown>): TAgentUiEvent => ({
  type: 'tool_call_update',
  acpUpdate: { sessionUpdate: 'tool_call_update', ...extra } as unknown as TAcpToolCallUpdate,
});

describe('reduceAcpUiEventsToToolCalls', () => {
  it('空输入 → 空数组', () => {
    expect(reduceAcpUiEventsToToolCalls([])).toEqual([]);
  });

  it('忽略非 ACP 事件', () => {
    const events: TAgentUiEvent[] = [
      { type: 'message_delta', text: 'hi' },
      { type: 'tool_start', toolName: 'read_file', input: { path: 'a.ts' } },
    ];
    expect(reduceAcpUiEventsToToolCalls(events)).toEqual([]);
  });

  it('单条 tool_call 建条目', () => {
    const calls = reduceAcpUiEventsToToolCalls(
      [toolCallEvent({ toolCallId: 't1', title: 'Read', kind: 'read', status: 'pending' })],
      { now: NOW },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: 't1', kind: 'read', status: 'pending', createdAt: NOW });
  });

  it('tool_call 后接 tool_call_update 按 toolCallId 合并', () => {
    const calls = reduceAcpUiEventsToToolCalls(
      [
        toolCallEvent({ toolCallId: 't', title: 'Run', kind: 'execute', status: 'pending' }),
        toolCallUpdateEvent({ toolCallId: 't', status: 'completed' }),
      ],
      { now: NOW },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      id: 't',
      title: 'Run',
      kind: 'execute',
      status: 'completed',
      createdAt: NOW,
    });
  });

  it('保持首次出现顺序，update 不重排', () => {
    const calls = reduceAcpUiEventsToToolCalls([
      toolCallEvent({ toolCallId: 'a' }),
      toolCallEvent({ toolCallId: 'b' }),
      toolCallUpdateEvent({ toolCallId: 'a', status: 'completed' }),
    ]);
    expect(calls.map((call) => call.id)).toEqual(['a', 'b']);
  });

  it('缺 toolCallId 的事件被跳过', () => {
    const calls = reduceAcpUiEventsToToolCalls([toolCallEvent({ title: 'no id' })]);
    expect(calls).toEqual([]);
  });
});

describe('applyAcpUiEvent — 不可变与 no-op', () => {
  it('非 ACP 事件返回同一引用', () => {
    const acc = createAcpToolCallAccumulator();
    const next = applyAcpUiEvent(acc, { type: 'message_delta', text: 'x' });
    expect(next).toBe(acc);
  });

  it('缺 toolCallId 返回同一引用', () => {
    const acc = createAcpToolCallAccumulator();
    const next = applyAcpUiEvent(acc, toolCallEvent({ title: 'no id' }));
    expect(next).toBe(acc);
  });

  it('应用后返回新累加器，不修改入参', () => {
    const acc = createAcpToolCallAccumulator();
    const next = applyAcpUiEvent(acc, toolCallEvent({ toolCallId: 't' }), { now: NOW });
    expect(next).not.toBe(acc);
    expect(acc.order).toEqual([]);
    expect(acc.byId.size).toBe(0);
    expect(selectAcpToolCalls(next).map((call) => call.id)).toEqual(['t']);
  });

  it('createdAt 跨多次增量 apply 保持稳定', () => {
    let acc = createAcpToolCallAccumulator();
    acc = applyAcpUiEvent(acc, toolCallEvent({ toolCallId: 't', status: 'pending' }), { now: NOW });
    acc = applyAcpUiEvent(acc, toolCallUpdateEvent({ toolCallId: 't', status: 'completed' }), {
      now: '2026-06-17T00:05:00.000Z',
    });
    const calls = selectAcpToolCalls(acc);
    expect(calls[0]?.createdAt).toBe(NOW);
    expect(calls[0]?.status).toBe('completed');
  });
});
