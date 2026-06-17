import { describe, expect, it } from 'vitest';

import type { IAiToolCall } from '@/types/ai';
import type { TAiThreadToolCallStatus } from '@/types/ai/thread';

import { fromWireToolCall } from './from-wire-tool-call';

const baseToolCall = (overrides: Partial<IAiToolCall> = {}): IAiToolCall => ({
  id: 'tc-1',
  name: 'read_file',
  status: 'succeeded',
  summary: '已查看 a.ts',
  ...overrides,
});

const opts = { createdAt: '2026-06-17T00:00:00.000Z' };

describe('fromWireToolCall', () => {
  it('映射 id / 标题(summary) / createdAt / status / kind,content 恒空', () => {
    const toolCall = fromWireToolCall(baseToolCall({ status: 'running' }), opts);
    expect(toolCall).toEqual({
      type: 'tool_call',
      id: 'tc-1',
      createdAt: '2026-06-17T00:00:00.000Z',
      title: '已查看 a.ts',
      kind: 'read',
      status: 'in_progress',
      content: [],
    });
  });

  it('summary 为空时标题回退到工具名', () => {
    expect(
      fromWireToolCall(baseToolCall({ summary: '   ', name: 'mystery_tool' }), opts).title,
    ).toBe('mystery_tool');
  });

  it('状态映射(denied → canceled)', () => {
    const cases: Array<[IAiToolCall['status'], TAiThreadToolCallStatus]> = [
      ['pending', 'pending'],
      ['running', 'in_progress'],
      ['succeeded', 'completed'],
      ['failed', 'failed'],
      ['denied', 'canceled'],
    ];
    for (const [wire, expected] of cases) {
      expect(fromWireToolCall(baseToolCall({ status: wire }), opts).status).toBe(expected);
    }
  });

  it('未知工具名的 kind 兑底为 other', () => {
    expect(fromWireToolCall(baseToolCall({ name: 'zzz_unknown_tool' }), opts).kind).toBe('other');
  });
});
