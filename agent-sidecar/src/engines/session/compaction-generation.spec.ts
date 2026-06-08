import assert from 'node:assert/strict';
import test from 'node:test';

import { COMPACTION_HANDOFF_PROMPT } from './session-messages.js';
import { buildContextCompactionGenerationRequest } from './compaction-generation.js';
import type { TMastraChatMessage } from '../types.js';

const createMessages = (): TMastraChatMessage[] => [
  { role: 'user', content: 'first user request' },
  { role: 'assistant', content: 'assistant context is not retained directly' },
  { role: 'user', content: 'second user request' },
  {
    role: 'user',
    content: [
      { type: 'text', text: 'third user request' },
      { type: 'image', image: 'file:///tmp/screenshot.png' },
    ],
  },
];

test('buildContextCompactionGenerationRequest appends the Zed-style handoff prompt after retained user context', () => {
  const request = buildContextCompactionGenerationRequest({
    messages: createMessages(),
    retainedUserMessageByteBudget: 128,
  });

  assert.equal(request.handoffPrompt, COMPACTION_HANDOFF_PROMPT);
  assert.equal(request.retainedUserMessageCount, 3);
  assert.deepEqual(request.messages.map((message) => message.role), ['user', 'user', 'user', 'user']);
  assert.deepEqual(request.messages.map((message) => message.content), [
    'first user request',
    'second user request',
    'third user request',
    COMPACTION_HANDOFF_PROMPT,
  ]);
});

test('buildContextCompactionGenerationRequest keeps newest user messages within byte budget', () => {
  const request = buildContextCompactionGenerationRequest({
    messages: createMessages(),
    retainedUserMessageByteBudget: 36,
  });

  assert.equal(request.retainedUserMessageCount, 2);
  assert.equal(request.retainedUserMessageByteCount, Buffer.byteLength('second user requestthird user request', 'utf8'));
  assert.deepEqual(request.messages.map((message) => message.content), [
    'second user request',
    'third user request',
    COMPACTION_HANDOFF_PROMPT,
  ]);
});

test('buildContextCompactionGenerationRequest allows a custom handoff prompt for tests and provider quirks', () => {
  const request = buildContextCompactionGenerationRequest({
    messages: [],
    handoffPrompt: 'Summarize as handoff.',
  });

  assert.deepEqual(request.messages, [{ role: 'user', content: 'Summarize as handoff.' }]);
  assert.equal(request.retainedUserMessageCount, 0);
  assert.equal(request.retainedUserMessageByteCount, 0);
});
