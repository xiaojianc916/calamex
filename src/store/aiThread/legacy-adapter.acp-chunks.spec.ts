import { describe, expect, it } from 'vitest';

import type { IAiChatMessage } from '@/types/ai';
import type { IAiThreadAssistantChunk } from '@/types/ai/thread';
import { legacyMessageToEntries, threadEntriesToMessages } from './legacy-adapter';

const chunks: IAiThreadAssistantChunk[] = [
  { type: 'thought', block: { type: 'text', text: '想一下' } },
  {
    type: 'tool_call',
    toolCall: {
      type: 'tool_call',
      id: 'tc1',
      createdAt: 'x',
      title: 'Read',
      kind: 'read',
      status: 'completed',
      content: [],
    },
  },
  { type: 'message', block: { type: 'text', text: '答案' } },
];

describe('legacy-adapter / chunks roundtrip with tool_call', () => {
  it('message.chunks 经 legacyMessageToEntries 原样还原到 assistant_message.chunks', () => {
    const message: IAiChatMessage = {
      role: 'assistant',
      id: 'a1',
      content: '答案',
      createdAt: 'x',
      references: [],
      chunks,
    };
    const entries = legacyMessageToEntries(message);
    const assistant = entries.find((entry) => entry.type === 'assistant_message');
    if (!assistant || assistant.type !== 'assistant_message')
      throw new Error('expected assistant_message');
    expect(assistant.chunks.map((c) => c.type)).toEqual(['thought', 'tool_call', 'message']);
  });

  it('chunks 经 threadEntriesToMessages -> legacyMessageToEntries 往返保真', () => {
    const messages = threadEntriesToMessages([
      { type: 'assistant_message', id: 'a1', createdAt: 'x', chunks },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.chunks?.map((c) => c.type)).toEqual(['thought', 'tool_call', 'message']);
    const roundTrip = legacyMessageToEntries(messages[0]!);
    const assistant = roundTrip.find((entry) => entry.type === 'assistant_message');
    if (!assistant || assistant.type !== 'assistant_message')
      throw new Error('expected assistant_message');
    expect(assistant.chunks.map((c) => c.type)).toEqual(['thought', 'tool_call', 'message']);
  });
});
