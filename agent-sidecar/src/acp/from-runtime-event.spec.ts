import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAcpProjector } from './from-runtime-event.js';
import { sessionUpdateSchema } from './schema.js';

/** Deterministic, monotonically increasing id factory for assertions. */
const sequentialIds = (): (() => string) => {
  let n = 0;
  return () => `tc-${++n}`;
};

test('message_delta projects to an agent_message_chunk', () => {
  const projector = createAcpProjector(sequentialIds());
  const updates = projector.project({ type: 'message_delta', text: 'hello' });
  assert.deepEqual(updates, [
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
  ]);
  assert.doesNotThrow(() => sessionUpdateSchema.parse(updates[0]));
});

test('an empty message_delta yields no update', () => {
  const projector = createAcpProjector(sequentialIds());
  assert.deepEqual(projector.project({ type: 'message_delta', text: '' }), []);
});

test('tool_start and tool_result share one tool-call id', () => {
  const projector = createAcpProjector(sequentialIds());
  const [start] = projector.project({ type: 'tool_start', toolName: 'grep', input: { q: 'x' } });
  const [end] = projector.project({ type: 'tool_result', toolName: 'grep', output: { hits: 1 } });

  assert.equal(start?.sessionUpdate, 'tool_call');
  assert.equal(end?.sessionUpdate, 'tool_call_update');
  assert.equal((start as { toolCallId: string }).toolCallId, (end as { toolCallId: string }).toolCallId);
  assert.equal((start as { status: string }).status, 'in_progress');
  assert.equal((end as { status: string }).status, 'completed');
  assert.doesNotThrow(() => sessionUpdateSchema.parse(start));
  assert.doesNotThrow(() => sessionUpdateSchema.parse(end));
});

test('concurrent tool_result without a matching start still emits a valid id', () => {
  const projector = createAcpProjector(sequentialIds());
  const [update] = projector.project({ type: 'tool_result', toolName: 'orphan', output: null });
  assert.equal(update?.sessionUpdate, 'tool_call_update');
  assert.match((update as { toolCallId: string }).toolCallId, /^tc-\d+$/);
});

test('events outside the PR-1 spine project to nothing', () => {
  const projector = createAcpProjector(sequentialIds());
  assert.deepEqual(projector.project({ type: 'message_clear' }), []);
  assert.deepEqual(projector.project({ type: 'error', message: 'boom' }), []);
});
