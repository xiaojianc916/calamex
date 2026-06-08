import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentExecutionSession } from './agent-session.js';

test('AgentExecutionSession creates stable session/run ids and stores pushed events', () => {
  const delivered: string[] = [];
  const session = createAgentExecutionSession({
    sessionId: 'session-1',
    runId: 'run-1',
    agentId: 'agent-1',
    now: () => '2026-01-01T00:00:00.000Z',
  });

  const event = session.pushRuntimeEvent({
    type: 'agent.debug',
    visibility: 'debug',
    level: 'info',
    name: 'test',
  }, {
    onEvent: (outputEvent) => delivered.push(outputEvent.type),
  });

  assert.equal(session.sessionId, 'session-1');
  assert.equal(session.requestedRunId, 'run-1');
  assert.equal(event.type, 'agent_event');
  assert.equal(event.event.runId, 'run-1');
  assert.equal(event.event.sessionId, 'session-1');
  assert.equal(event.event.agentId, 'agent-1');
  assert.equal(event.event.seq, 0);
  assert.equal(event.event.timestamp, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(delivered, ['agent_event']);
  assert.equal(session.events.length, 1);
});

test('AgentExecutionSession reuses one sequence per run id', () => {
  const session = createAgentExecutionSession({
    sessionId: 'session-1',
    runId: 'run-1',
    agentId: 'agent-1',
  });

  const mainFactory = session.createRuntimeEventFactory();
  const sameMainFactory = session.createRuntimeEventFactory('run-1');
  const checkpointFactory = session.createRuntimeEventFactory('run-2');

  const first = mainFactory({
    type: 'agent.debug',
    visibility: 'debug',
    name: 'first',
  });
  const second = sameMainFactory({
    type: 'agent.debug',
    visibility: 'debug',
    name: 'second',
  });
  const checkpoint = checkpointFactory({
    type: 'agent.debug',
    visibility: 'debug',
    name: 'checkpoint',
  });

  assert.equal(first.event.runId, 'run-1');
  assert.equal(first.event.seq, 0);
  assert.equal(second.event.runId, 'run-1');
  assert.equal(second.event.seq, 1);
  assert.equal(checkpoint.event.runId, 'run-2');
  assert.equal(checkpoint.event.seq, 0);
});
