import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentExecutionSession } from './agent-session.js';
import { runContextCompaction } from './compaction-runner.js';
import {
  COMPACTION_HANDOFF_PROMPT,
  COMPACTION_RESUME_USER_MESSAGE_PREFIX,
} from './session-messages.js';
import type { TMastraChatMessage } from '../shared/types.js';

async function* streamSummaryDeltas(): AsyncIterable<string> {
  yield 'Goal: continue the refactor\n';
  yield 'Next: preserve the active prompt';
}

const createMessages = (): TMastraChatMessage[] => [
  { role: 'user', content: 'older request' },
  { role: 'assistant', content: 'older answer' },
  { role: 'user', content: 'active request' },
];

test('runContextCompaction streams lifecycle events and returns compacted continuation messages', async () => {
  const deliveredEventTypes: string[] = [];
  const session = createAgentExecutionSession({
    sessionId: 'session-1',
    runId: 'run-1',
    now: () => '2026-01-01T00:00:00.000Z',
  });
  const result = await runContextCompaction({
    session,
    messages: createMessages(),
    retainedUserMessageByteBudget: 64,
    projectedInputTokens: 90_000,
    remainingInputTokens: 30_000,
    options: {
      onEvent: (event) => deliveredEventTypes.push(event.type),
    },
    generateSummary: async (request, context) => {
      assert.equal(context.compactionId.startsWith('context-compaction-'), true);
      assert.equal(request.handoffPrompt, COMPACTION_HANDOFF_PROMPT);
      assert.equal(request.retainedUserMessageByteBudget, 64);
      assert.deepEqual(request.messages.map((message) => message.content), [
        'older request',
        'active request',
        COMPACTION_HANDOFF_PROMPT,
      ]);
      return streamSummaryDeltas();
    },
  });

  assert.equal(result.summary, 'Goal: continue the refactor\nNext: preserve the active prompt');
  assert.equal(result.compaction.status, 'completed');
  assert.deepEqual(result.continuationMessages, [
    {
      role: 'user',
      content: `${COMPACTION_RESUME_USER_MESSAGE_PREFIX}\n\nGoal: continue the refactor\nNext: preserve the active prompt`,
    },
    { role: 'user', content: 'active request' },
  ]);
  assert.deepEqual(session.events.map((event) => (event.type === 'agent_event' ? event.event.type : event.type)), [
    'acontext.context_compaction.started',
    'acontext.context_compaction.updated',
    'acontext.context_compaction.updated',
    'acontext.context_compaction.completed',
  ]);
  assert.deepEqual(deliveredEventTypes, ['agent_event', 'agent_event', 'agent_event', 'agent_event']);
  assert.equal(session.messages[0]?.kind, 'compaction');

  const lastEvent = session.events.at(-1);
  const completedEvent = lastEvent?.type === 'agent_event' ? lastEvent.event : undefined;
  assert.equal(completedEvent?.type, 'acontext.context_compaction.completed');
  if (completedEvent?.type === 'acontext.context_compaction.completed') {
    assert.equal(completedEvent.retainedUserMessageByteBudget, 64);
  }
});

test('runContextCompaction rejects empty summaries instead of recording unusable handoffs', async () => {
  const session = createAgentExecutionSession({
    sessionId: 'session-1',
    runId: 'run-1',
  });

  await assert.rejects(
    runContextCompaction({
      session,
      messages: createMessages(),
      generateSummary: () => '   ',
    }),
    /empty summary/u,
  );

  assert.equal(session.contextCompactions[0]?.status, 'running');
  assert.equal(session.messages.length, 0);
});

test('runContextCompaction respects cancellation before starting generation', async () => {
  const session = createAgentExecutionSession({
    sessionId: 'session-1',
    runId: 'run-1',
  });
  const abortController = new AbortController();
  abortController.abort();

  await assert.rejects(
    runContextCompaction({
      session,
      messages: createMessages(),
      signal: abortController.signal,
      generateSummary: () => 'Goal: should not run',
    }),
    /aborted/u,
  );

  assert.equal(session.contextCompactions.length, 0);
});
