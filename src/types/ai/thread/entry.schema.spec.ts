import { describe, expect, it } from 'vitest';

import {
  aiThreadAssistantChunkSchema,
  aiThreadEntrySchema,
  aiThreadSchema,
  aiThreadToolCallSchema,
  aiThreadToolKindSchema,
} from '@/types/ai/thread';

const ISO = '2026-06-14T09:00:00.000Z';

describe('AI thread entry schema', () => {
  it('校验一个完整线程：user / assistant(正文+思维交织) / tool_call / plan', () => {
    const thread = aiThreadSchema.parse({
      id: 'thread-1',
      title: '重构流式渲染',
      titleStatus: 'generated',
      createdAt: ISO,
      updatedAt: ISO,
      entries: [
        {
          type: 'user_message',
          id: 'u1',
          createdAt: ISO,
          content: [{ type: 'text', text: '为什么别人的 UI 那么丝滑？' }],
        },
        {
          type: 'assistant_message',
          id: 'a1',
          createdAt: ISO,
          chunks: [
            { type: 'thought', block: { type: 'text', text: '先检索对比方案' } },
            { type: 'message', block: { type: 'text', text: '根因在数据模型与编排。' } },
            { type: 'message', block: { type: 'source', url: 'https://zed.dev' } },
          ],
        },
        {
          type: 'tool_call',
          id: 'tc1',
          createdAt: ISO,
          title: 'Search code',
          kind: 'search',
          status: 'in_progress',
          content: [
            { type: 'content', block: { type: 'text', text: 'acp_thread.rs' } },
            { type: 'terminal', terminalId: 'term-1' },
          ],
        },
        {
          type: 'plan',
          id: 'p1',
          createdAt: ISO,
          steps: [],
        },
      ],
    });

    expect(thread.entries).toHaveLength(4);
    const assistant = thread.entries[1];
    expect(assistant.type).toBe('assistant_message');
    if (assistant.type === 'assistant_message') {
      // 正文与思维链按到达顺序交织在同一条 chunks 流
      expect(assistant.chunks.map((chunk) => chunk.type)).toEqual([
        'thought',
        'message',
        'message',
      ]);
    }
  });

  it('拒绝非法的工具调用状态', () => {
    expect(() =>
      aiThreadToolCallSchema.parse({
        type: 'tool_call',
        id: 'tc-bad',
        createdAt: ISO,
        title: 'X',
        kind: 'search',
        status: 'running', // 不在五态集合内（应为 in_progress）
        content: [],
      }),
    ).toThrow();
  });

  it('未知工具种类兑底为 other', () => {
    expect(aiThreadToolKindSchema.parse('totally-unknown-kind')).toBe('other');
  });

  it('chunk 判别联合按 type 区分 message / thought', () => {
    const thought = aiThreadAssistantChunkSchema.parse({
      type: 'thought',
      block: { type: 'text', text: '思考中' },
    });
    expect(thought.type).toBe('thought');
  });

  it('entry 联合拒绝未知 type', () => {
    expect(() => aiThreadEntrySchema.parse({ type: 'mystery', id: 'x', createdAt: ISO })).toThrow();
  });
});
