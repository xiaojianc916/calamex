import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildContextCompactionContinuationMessages,
  buildContextCompactionGenerationRequest,
} from './compaction-generation.js';
import {
  COMPACTION_HANDOFF_PROMPT,
  COMPACTION_RESUME_USER_MESSAGE_PREFIX,
} from './session-messages.js';
import type { TMastraChatMessage } from '../shared/types.js';

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
  assert.equal(request.retainedUserMessageByteBudget, 128);
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
    retainedUserMessageByteBudget: 37,
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

test('buildContextCompactionContinuationMessages keeps the active user prompt after the summary', () => {
  const messages: TMastraChatMessage[] = [
    { role: 'user', content: 'old request' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'current request' },
  ];

  const compacted = buildContextCompactionContinuationMessages({
    messages,
    summary: 'Goal: keep working\nNext: answer current request',
  });

  assert.deepEqual(compacted, [
    {
      role: 'user',
      content: `${COMPACTION_RESUME_USER_MESSAGE_PREFIX}\n\nGoal: keep working\nNext: answer current request`,
    },
    { role: 'user', content: 'current request' },
  ]);
});

test('buildContextCompactionContinuationMessages preserves image parts on the active user prompt', () => {
  const activePrompt: TMastraChatMessage = {
    role: 'user',
    content: [
      { type: 'text', text: 'current visual request' },
      { type: 'image', image: 'file:///tmp/screenshot.png' },
    ],
  };
  const compacted = buildContextCompactionContinuationMessages({
    messages: [
      { role: 'user', content: 'old request' },
      { role: 'assistant', content: 'old answer' },
      activePrompt,
    ],
    summary: 'Goal: inspect image context',
  });

  assert.deepEqual(compacted, [
    {
      role: 'user',
      content: `${COMPACTION_RESUME_USER_MESSAGE_PREFIX}\n\nGoal: inspect image context`,
    },
    activePrompt,
  ]);
  assert.notEqual(compacted[1], activePrompt);
});

test('buildContextCompactionContinuationMessages leaves messages unchanged when summary is empty', () => {
  assert.deepEqual(
    buildContextCompactionContinuationMessages({
      messages: createMessages(),
      summary: '   ',
    }),
    createMessages(),
  );
});
