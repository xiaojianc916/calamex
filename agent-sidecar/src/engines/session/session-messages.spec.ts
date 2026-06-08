import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPACTION_HANDOFF_PROMPT,
  COMPACTION_RESUME_USER_MESSAGE_PREFIX,
  buildMastraMessagesFromSessionMessages,
  createAgentSessionCompactionMessage,
  createAgentSessionMessagesFromRuntimeInput,
} from './session-messages.js';
import type { IAgentRuntimeInput } from '../contracts/runtime-input.js';

const imageDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
const carrierLine = `AI_SDK_IMAGE_PART_JSON:${JSON.stringify({
  type: 'image',
  image: imageDataUrl,
  mediaType: 'image/png',
})}`;

const createInput = (overrides: Partial<IAgentRuntimeInput> = {}): IAgentRuntimeInput => ({
  mode: 'agent',
  goal: '完善 AI 架构',
  messages: [
    {
      role: 'assistant',
      content: '上一轮已经完成 session turn。',
    },
    {
      role: 'user',
      content: '继续。',
    },
  ],
  ...overrides,
});

test('createAgentSessionMessagesFromRuntimeInput creates replayable user and assistant messages', () => {
  const sessionMessages = createAgentSessionMessagesFromRuntimeInput(createInput());

  assert.deepEqual(sessionMessages.map((message) => message.kind), ['assistant', 'user']);
  assert.equal(sessionMessages[1]?.source, 'prompt');
  assert.equal(sessionMessages[1]?.id, 'runtime-message:1');
});

test('session messages are the source for Mastra request messages', () => {
  const sessionMessages = createAgentSessionMessagesFromRuntimeInput(createInput());
  const mastraMessages = buildMastraMessagesFromSessionMessages(sessionMessages);

  assert.deepEqual(mastraMessages, [
    {
      role: 'assistant',
      content: '上一轮已经完成 session turn。',
    },
    {
      role: 'user',
      content: '目标：完善 AI 架构\n继续。',
    },
  ]);
});

test('createAgentSessionMessagesFromRuntimeInput keeps image parts on the final user message', () => {
  const sessionMessages = createAgentSessionMessagesFromRuntimeInput(createInput({
    context: [
      {
        id: 'image-1',
        kind: 'image-attachment',
        label: '图片附件 · screenshot.png',
        path: 'screenshot.png',
        range: null,
        contentPreview: carrierLine,
        redacted: false,
      },
    ],
  }));

  const finalMessage = sessionMessages.at(-1);

  assert.equal(finalMessage?.kind, 'user');
  assert.deepEqual(finalMessage?.kind === 'user' ? finalMessage.content : null, [
    {
      type: 'text',
      text: '目标：完善 AI 架构\n继续。',
    },
    {
      type: 'image',
      image: imageDataUrl,
      mediaType: 'image/png',
    },
  ]);
});

test('compaction messages replay as Zed-style user handoff context', () => {
  const compactionMessage = createAgentSessionCompactionMessage({
    id: 'compaction-1',
    summary: 'Goal: 完善 AI 架构\nNext: 继续落地。',
  });

  const mastraMessages = buildMastraMessagesFromSessionMessages([
    compactionMessage,
    {
      id: 'runtime-message:1',
      kind: 'user',
      source: 'prompt',
      content: '继续。',
    },
  ]);

  assert.equal(compactionMessage.source, 'compaction');
  assert.equal(mastraMessages[0]?.role, 'user');
  assert.equal(
    mastraMessages[0]?.content,
    `${COMPACTION_RESUME_USER_MESSAGE_PREFIX}\n\nGoal: 完善 AI 架构\nNext: 继续落地。`,
  );
  assert.equal(mastraMessages[1]?.content, '继续。');
});

test('compaction handoff prompt keeps the Zed-required sections', () => {
  for (const section of ['Goal', 'State', 'Context', 'Next', 'Pitfalls']) {
    assert.match(COMPACTION_HANDOFF_PROMPT, new RegExp(`\\b${section}\\b`, 'u'));
  }
});
