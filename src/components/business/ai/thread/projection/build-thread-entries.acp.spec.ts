import { describe, expect, it } from 'vitest';

import type { IAiChatMessage, IAiToolCall } from '@/types/ai';
import type { IAiThreadToolCall } from '@/types/ai/thread';
import { buildThreadEntries } from '@/components/business/ai/thread/projection/build-thread-entries';

const acpCall = (overrides: Partial<IAiThreadToolCall> = {}): IAiThreadToolCall => ({
  type: 'tool_call',
  id: 't1',
  createdAt: '2026-06-17T00:00:00.000Z',
  title: 'Read file',
  kind: 'read',
  status: 'completed',
  content: [],
  ...overrides,
});

const wireCall = (overrides: Partial<IAiToolCall> = {}): IAiToolCall =>
  ({
    id: 'wt',
    name: 'read_file',
    summary: '',
    status: 'succeeded',
    ...overrides,
  }) as unknown as IAiToolCall;

const assistantMessage = (overrides: Partial<IAiChatMessage> = {}): IAiChatMessage =>
  ({ id: 'm1', role: 'assistant', content: '', ...overrides }) as unknown as IAiChatMessage;

const toolCallIds = (entries: ReturnType<typeof buildThreadEntries>): string[] =>
  entries.filter((entry) => entry.kind === 'tool-call').map((entry) => entry.id);

describe('buildThreadEntries — ACP 工具调用分支', () => {
  it('无运行时事件 / wire 调用时,从 acpToolCalls 投影出工具调用条目(保序)', () => {
    const entries = buildThreadEntries([
      assistantMessage({ acpToolCalls: [acpCall({ id: 'a' }), acpCall({ id: 'b' })] }),
    ]);
    expect(toolCallIds(entries)).toEqual(['m1:acp:a', 'm1:acp:b']);
  });

  it('acpToolCalls 优先于 wire toolCalls', () => {
    const entries = buildThreadEntries([
      assistantMessage({
        acpToolCalls: [acpCall({ id: 'a' })],
        toolCalls: [wireCall()],
      }),
    ]);
    const ids = toolCallIds(entries);
    expect(ids).toEqual(['m1:acp:a']);
    expect(ids.some((id) => id.startsWith('m1:tool:'))).toBe(false);
  });

  it('空 acpToolCalls 回退到 wire toolCalls 分支', () => {
    const entries = buildThreadEntries([
      assistantMessage({ acpToolCalls: [], toolCalls: [wireCall({ id: 'w1' })] }),
    ]);
    expect(toolCallIds(entries)).toEqual(['m1:tool:w1']);
  });

  it('助手文本与 ACP 工具调用条目并存(工具在前,文本在后)', () => {
    const entries = buildThreadEntries([
      assistantMessage({ content: 'done', acpToolCalls: [acpCall({ id: 'a' })] }),
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(['tool-call', 'assistant-text']);
  });
});
