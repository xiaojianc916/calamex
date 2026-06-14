import { describe, expect, it } from 'vitest';

import { inferToolKind, legacyMessageToEntries, legacyThreadToThread } from '@/store/aiThread/legacy-adapter';
import type { IAiChatMessage } from '@/types/ai';
import type { IAiConversationThread } from '@/store/aiConversation';
import type { IAiThreadAssistantMessageEntry, IAiThreadToolCall, IAiThreadUserMessageEntry } from '@/types/ai/thread';

const ISO = '2026-06-14T09:00:00.000Z';

const userMessage = (overrides: Partial<IAiChatMessage> = {}): IAiChatMessage => ({
  id: 'u1',
  role: 'user',
  content: '你好',
  createdAt: ISO,
  references: [],
  ...overrides,
});

describe('legacyMessageToEntries', () => {
  it('user 消息 -> user_message + text block', () => {
    const entries = legacyMessageToEntries(userMessage());
    expect(entries).toHaveLength(1);
    const entry = entries[0] as IAiThreadUserMessageEntry;
    expect(entry.type).toBe('user_message');
    expect(entry.content).toEqual([{ type: 'text', text: '你好' }]);
  });

  it('空 user 消息 -> 空 content 数组', () => {
    const entries = legacyMessageToEntries(userMessage({ content: '   ' }));
    expect((entries[0] as IAiThreadUserMessageEntry).content).toEqual([]);
  });

  it('assistant + toolCalls -> tool_call(在前) + assistant_message(在后)', () => {
    const message: IAiChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: '最终回答',
      createdAt: ISO,
      references: [],
      toolCalls: [
        {
          id: 't1',
          name: 'search_code',
          status: 'succeeded',
          summary: 'Search code',
          targetPreview: 'src/**',
          detailItems: ['hit a', 'hit b'],
          elapsedMs: 1200,
        },
      ],
    };
    const entries = legacyMessageToEntries(message);
    expect(entries.map((e) => e.type)).toEqual(['tool_call', 'assistant_message']);

    const tool = entries[0] as IAiThreadToolCall;
    expect(tool.id).toBe('t1');
    expect(tool.status).toBe('completed');
    expect(tool.kind).toBe('search');
    expect(tool.title).toBe('Search code');
    expect(tool.content).toHaveLength(3); // targetPreview + 2 detailItems

    const assistant = entries[1] as IAiThreadAssistantMessageEntry;
    expect(assistant.chunks).toEqual([{ type: 'message', block: { type: 'text', text: '最终回答' } }]);
  });

  it('状态映射覆盖全部 5 种 legacy 状态', () => {
    const statuses = ['pending', 'running', 'succeeded', 'failed', 'denied'] as const;
    const expected = ['pending', 'in_progress', 'completed', 'failed', 'canceled'];
    const got = statuses.map((status) => {
      const entries = legacyMessageToEntries({
        id: `a-${status}`,
        role: 'assistant',
        content: '',
        createdAt: ISO,
        references: [],
        toolCalls: [{ id: `tc-${status}`, name: 'x', status, summary: 's' }],
      });
      return (entries[0] as IAiThreadToolCall).status;
    });
    expect(got).toEqual(expected);
  });

  it('inferToolKind 启发式', () => {
    expect(inferToolKind('read_file')).toBe('read');
    expect(inferToolKind('apply_patch')).toBe('edit');
    expect(inferToolKind('run_command')).toBe('execute');
    expect(inferToolKind('web_fetch')).toBe('fetch');
    expect(inferToolKind('totally_unknown')).toBe('other');
  });
});

describe('legacyThreadToThread', () => {
  it('沿用元信息, 展平 messages 为 entries', () => {
    const thread: IAiConversationThread = {
      id: 'th1',
      title: '标题',
      titleStatus: 'generated',
      createdAt: ISO,
      updatedAt: ISO,
      messages: [
        userMessage(),
        { id: 'a1', role: 'assistant', content: '回答', createdAt: ISO, references: [] },
      ],
    };
    const result = legacyThreadToThread(thread);
    expect(result.id).toBe('th1');
    expect(result.title).toBe('标题');
    expect(result.titleStatus).toBe('generated');
    expect(result.entries.map((e) => e.type)).toEqual(['user_message', 'assistant_message']);
  });
});
