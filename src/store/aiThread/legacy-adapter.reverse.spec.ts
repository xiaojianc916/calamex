import { describe, expect, it } from 'vitest';

import type { IAiConversationThread } from '@/store/aiConversation';
import type { IAiChatMessage } from '@/types/ai';

import {
  legacyMessageToEntries,
  legacyThreadToThread,
  threadEntriesToMessages,
  threadToLegacyThread,
} from './legacy-adapter';

const userMessage: IAiChatMessage = {
  role: 'user',
  id: 'u1',
  content: 'hello',
  createdAt: '2026-01-01T00:00:00.000Z',
  references: [],
};

const assistantMessage: IAiChatMessage = {
  role: 'assistant',
  id: 'a1',
  content: 'world',
  createdAt: '2026-01-01T00:00:01.000Z',
  references: [],
  toolCalls: [
    { id: 't1', name: 'read_file', summary: '读取文件', status: 'succeeded', detailItems: ['x'] },
  ],
};

describe('threadEntriesToMessages', () => {
  it('round-trips user + assistant content and tool calls', () => {
    const entries = [userMessage, assistantMessage].flatMap(legacyMessageToEntries);
    const messages = threadEntriesToMessages(entries);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0]!.content).toBe('hello');
    expect(messages[1]!.content).toBe('world');
    expect(messages[1]!.id).toBe('a1');
    expect(messages[1]!.toolCalls?.[0]?.id).toBe('t1');
    expect(messages[1]!.toolCalls?.[0]?.status).toBe('succeeded');
  });

  it('skips non-message entries without throwing', () => {
    const entries = legacyMessageToEntries(userMessage);
    expect(threadEntriesToMessages(entries)).toHaveLength(1);
  });
});

describe('threadToLegacyThread', () => {
  it('inverts legacyThreadToThread meta + content', () => {
    const thread: IAiConversationThread = {
      id: 'th1',
      title: 'T',
      titleStatus: 'temporary',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:02.000Z',
      messages: [userMessage, assistantMessage],
    };
    const back = threadToLegacyThread(legacyThreadToThread(thread));
    expect(back.id).toBe('th1');
    expect(back.title).toBe('T');
    expect(back.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(back.messages[1]!.content).toBe('world');
  });
});
