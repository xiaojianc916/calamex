import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentExecutionSession } from './agent-session.js';
import { buildMastraMessagesFromSessionMessages, COMPACTION_RESUME_USER_MESSAGE_PREFIX } from './session-messages.js';

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

  if (first.type !== 'agent_event' || second.type !== 'agent_event' || checkpoint.type !== 'agent_event') {
    throw new Error('expected agent_event outputs');
  }
  assert.equal(first.event.runId, 'run-1');
  assert.equal(first.event.seq, 0);
  assert.equal(second.event.runId, 'run-1');
  assert.equal(second.event.seq, 1);
  assert.equal(checkpoint.event.runId, 'run-2');
  assert.equal(checkpoint.event.seq, 0);
});

test('AgentExecutionSession records turn lifecycle as session state', () => {
  const session = createAgentExecutionSession({
    sessionId: 'session-1',
    runId: 'run-1',
    now: () => '2026-01-01T00:00:00.000Z',
  });

  const turn = session.startTurn({
    turnId: 'turn-1',
    mode: 'agent',
    goal: '重构执行层',
    modelId: 'deepseek/deepseek-v4-pro',
  });

  assert.equal(turn.id, 'turn-1');
  assert.equal(turn.runId, 'run-1');
  assert.equal(turn.status, 'running');
  assert.equal(turn.startedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(session.turns.length, 1);

  const completed = session.completeTurn('turn-1', { result: 'done' });

  assert.equal(completed?.status, 'completed');
  assert.equal(completed?.result, 'done');
  assert.equal(completed?.completedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(session.turns[0]?.status, 'completed');
});

test('AgentExecutionSession stores session messages as aggregate state', () => {
  const session = createAgentExecutionSession();

  session.appendMessage({
    id: 'message-1',
    kind: 'user',
    source: 'conversation',
    content: '继续重构',
  });
  session.appendMessages([{
    id: 'message-2',
    kind: 'assistant',
    source: 'runtime',
    content: '收到',
  }]);

  assert.deepEqual(session.messages.map((message) => message.id), ['message-1', 'message-2']);
});

test('AgentExecutionSession records compaction handoff as replayable session state', () => {
  const session = createAgentExecutionSession({
    now: () => '2026-01-01T00:00:00.000Z',
  });

  const compaction = session.appendContextCompaction('Goal: 继续重构\nNext: 接入执行流', {
    id: 'compaction-1',
  });
  const mastraMessages = buildMastraMessagesFromSessionMessages(session.messages);

  assert.deepEqual(compaction, {
    id: 'compaction-1',
    status: 'completed',
    reason: 'budget',
    summary: 'Goal: 继续重构\nNext: 接入执行流',
    createdAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(session.contextCompactions.length, 1);
  assert.equal(session.messages[0]?.kind, 'compaction');
  assert.equal(
    mastraMessages[0]?.content,
    `${COMPACTION_RESUME_USER_MESSAGE_PREFIX}\n\nGoal: 继续重构\nNext: 接入执行流`,
  );
});

test('AgentExecutionSession models streaming compaction lifecycle events', () => {
  const deliveredTypes: string[] = [];
  const session = createAgentExecutionSession({
    sessionId: 'session-1',
    runId: 'run-1',
    now: () => '2026-01-01T00:00:00.000Z',
  });
  const started = session.startContextCompaction({
    id: 'compaction-1',
    reason: 'budget',
  });

  session.pushRuntimeEvent({
    type: 'acontext.context_compaction.started',
    visibility: 'debug',
    level: 'info',
    compactionId: started.id,
    reason: started.reason,
    sourceMessageCount: session.messages.length,
  }, {
    onEvent: (event) => deliveredTypes.push(event.type),
  });

  const updated = session.appendContextCompactionDelta(started.id, {
    summaryDelta: 'Goal: 继续重构',
  });

  session.pushRuntimeEvent({
    type: 'acontext.context_compaction.updated',
    visibility: 'debug',
    level: 'info',
    compactionId: started.id,
    summaryDeltaCharCount: 'Goal: 继续重构'.length,
    summaryCharCount: updated?.summary.length ?? 0,
  }, {
    onEvent: (event) => deliveredTypes.push(event.type),
  });

  const completed = session.completeContextCompaction(started.id, {
    summary: `${updated?.summary ?? ''}\nNext: 接入执行流`,
  });

  session.pushRuntimeEvent({
    type: 'acontext.context_compaction.completed',
    visibility: 'debug',
    level: 'info',
    compactionId: started.id,
    reason: started.reason,
    summaryCharCount: completed?.summary.length ?? 0,
    sourceMessageCount: session.messages.length,
  }, {
    onEvent: (event) => deliveredTypes.push(event.type),
  });

  assert.equal(completed?.status, 'completed');
  assert.equal(session.messages[0]?.kind, 'compaction');
  assert.deepEqual(deliveredTypes, ['agent_event', 'agent_event', 'agent_event']);
  assert.deepEqual(session.events.map((event) => (event.type === 'agent_event' ? event.event.type : event.type)), [
    'acontext.context_compaction.started',
    'acontext.context_compaction.updated',
    'acontext.context_compaction.completed',
  ]);
});

test('AgentExecutionSession disposes resources in reverse acquisition order', async () => {
  const disposed: string[] = [];
  const session = createAgentExecutionSession();
  const scope = session.createResourceScope('turn');

  scope.add({
    name: 'mcp-bundle',
    dispose: () => { disposed.push('mcp-bundle'); },
  });
  scope.add({
    name: 'workspace',
    dispose: () => { disposed.push('workspace'); },
  });

  const dispositions = await scope.disposeAll();

  assert.deepEqual(disposed, ['workspace', 'mcp-bundle']);
  assert.deepEqual(dispositions, [
    { name: 'workspace', ok: true },
    { name: 'mcp-bundle', ok: true },
  ]);
  assert.equal(scope.size, 0);
  assert.deepEqual(await scope.disposeAll(), []);
});

test('AgentExecutionSession resource disposal is best-effort', async () => {
  const disposed: string[] = [];
  const session = createAgentExecutionSession();
  const scope = session.createResourceScope('turn');

  scope.add({
    name: 'first',
    dispose: () => { disposed.push('first'); },
  });
  scope.add({
    name: 'broken',
    dispose: () => {
      throw new Error('boom');
    },
  });
  scope.add({
    name: 'last',
    dispose: () => { disposed.push('last'); },
  });

  const dispositions = await scope.disposeAll();

  assert.deepEqual(disposed, ['last', 'first']);
  assert.deepEqual(dispositions, [
    { name: 'last', ok: true },
    { name: 'broken', ok: false, errorMessage: 'boom' },
    { name: 'first', ok: true },
  ]);
});
