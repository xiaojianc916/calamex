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

describe('threadEntriesToTimeline · ACP 工具调用单一表示（顶层 tool_call 交错）', () => {
  it('思考段 → 工具 → 回答段：严格按 entries 顺序铺开，工具不被前置', () => {
    const entries: IAiThreadEntry[] = [
      {
        type: 'assistant_message',
        id: 'assistant-1',
        createdAt: '2026-06-23T00:00:01.000Z',
        chunks: [{ type: 'thought', block: { type: 'text', text: '我来写入文件' } }],
      },
      toolCall,
      {
        type: 'assistant_message',
        id: 'assistant-1#1',
        createdAt: '2026-06-23T00:00:02.000Z',
        chunks: [{ type: 'message', block: { type: 'text', text: '完成。' } }],
      },
    ];

    const timeline = threadEntriesToTimeline(entries);

    expect(timeline.map((item) => item.kind)).toEqual(['reasoning', 'tool-call', 'assistant-text']);
    const toolItem = timeline[1];
    expect(toolItem.kind).toBe('tool-call');
    if (toolItem.kind === 'tool-call') {
      expect(toolItem.id).toBe('acp-tool-1');
      expect(toolItem.toolCall).toBe(toolCall);
    }
  });

  it('多个工具按到达顺序各自独立成卡', () => {
    const second: IAiThreadToolCall = { ...toolCall, id: 'acp-tool-2', title: 'Read src/a.ts' };
    const entries: IAiThreadEntry[] = [toolCall, second];
    const timeline = threadEntriesToTimeline(entries);
    expect(timeline.map((item) => item.kind)).toEqual(['tool-call', 'tool-call']);
    expect(timeline.map((item) => (item.kind === 'tool-call' ? item.id : ''))).toEqual([
      'acp-tool-1',
      'acp-tool-2',
    ]);
  });
});
