import { describe, expect, it } from 'vitest';

import type { IAiThreadEntry, IAiThreadToolCall } from '@/types/ai/thread';

import { threadEntriesToTimeline } from './thread-entries-to-timeline';

const toolCall: IAiThreadToolCall = {
  type: 'tool_call',
  id: 'acp-tool-1',
  createdAt: '2026-06-23T00:00:00.000Z',
  title: 'Write src/main.ts',
  kind: 'edit',
  status: 'completed',
  content: [],
};

describe('threadEntriesToTimeline · ACP acpToolCalls 展开', () => {
  it('把 assistant.acpToolCalls 展开为 tool-call，且排在 assistant-text 之前', () => {
    const entries: IAiThreadEntry[] = [
      {
        type: 'assistant_message',
        id: 'assistant-1',
        createdAt: '2026-06-23T00:00:01.000Z',
        chunks: [{ type: 'message', block: { type: 'text', text: '完成。' } }],
        acpToolCalls: [toolCall],
      },
    ];

    const timeline = threadEntriesToTimeline(entries);

    expect(timeline.map((item) => item.kind)).toEqual(['tool-call', 'assistant-text']);
    const toolItem = timeline[0];
    expect(toolItem.kind).toBe('tool-call');
    if (toolItem.kind === 'tool-call') {
      expect(toolItem.id).toBe('acp-tool-1');
      expect(toolItem.messageId).toBe('assistant-1');
      expect(toolItem.toolCall).toBe(toolCall);
    }
  });

  it('无 acpToolCalls 时只产出 assistant-text（不回归）', () => {
    const entries: IAiThreadEntry[] = [
      {
        type: 'assistant_message',
        id: 'assistant-2',
        createdAt: '2026-06-23T00:00:02.000Z',
        chunks: [{ type: 'message', block: { type: 'text', text: '你好。' } }],
      },
    ];

    expect(threadEntriesToTimeline(entries).map((item) => item.kind)).toEqual(['assistant-text']);
  });
});
