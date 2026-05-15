import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TAgentRuntimeOutputEvent } from '../engines/runtime-contracts.js';
import type { TJsonValue } from '../schemas/events.js';
import { AgentStreamEventBus } from './stream-event-bus.js';
import { normalizeAgentRuntimeStreamEvent } from './stream-normalizer.js';
import { redactForStream } from './stream-redaction.js';
import { runAgentStream } from './stream-runner.js';

describe('streaming event layer', () => {
  it('normalizes model text and reasoning delta events', () => {
    const drafts = normalizeAgentRuntimeStreamEvent({
      type: 'modelStreamUpdateEvent',
      event: {
        type: 'modelContentBlockDeltaEvent',
        delta: {
          type: 'textDelta',
          text: 'hello',
        },
      },
    });

    assert.deepEqual(drafts, [{
      type: 'agent.text.delta',
      visibility: 'debug',
      level: 'debug',
      text: 'hello',
    }]);
    assert.deepEqual(normalizeAgentRuntimeStreamEvent({
      type: 'modelStreamUpdateEvent',
      event: {
        type: 'modelContentBlockDeltaEvent',
        delta: {
          type: 'reasoningText',
          text: 'hidden reasoning',
        },
      },
    }), [{
      type: 'agent.reasoning.delta',
      visibility: 'user',
      level: 'info',
      text: 'hidden reasoning',
    }]);
  });

  it('normalizes tool lifecycle events with redacted previews', () => {
    const started = normalizeAgentRuntimeStreamEvent({
      type: 'beforeToolCallEvent',
      toolUse: {
        name: 'mcp.fs.read_file',
        toolUseId: 'tool-1',
        input: {
          path: 'src/app.ts',
          apiKey: 'secret-value',
        },
      },
    });
    const completed = normalizeAgentRuntimeStreamEvent({
      type: 'afterToolCallEvent',
      toolUse: {
        name: 'mcp.fs.read_file',
        toolUseId: 'tool-1',
        input: {},
      },
      result: {
        status: 'success',
        content: [{
          type: 'textBlock',
          text: 'done',
        }],
      },
    });
    const startedEvent = started[0];
    const completedEvent = completed[0];

    assert.equal(startedEvent?.type, 'agent.tool.started');
    if (!startedEvent || startedEvent.type !== 'agent.tool.started') {
      throw new Error('tool started event was not normalized');
    }
    assert.match(startedEvent.inputPreview ?? '', /\[REDACTED_SECRET\]/u);
    assert.equal(completedEvent?.type, 'agent.tool.completed');
    if (!completedEvent || completedEvent.type !== 'agent.tool.completed') {
      throw new Error('tool completed event was not normalized');
    }
    assert.equal(completedEvent.ok, true);
  });

  it('handles unavailable projected input tokens explicitly', () => {
    const drafts = normalizeAgentRuntimeStreamEvent({
      type: 'beforeModelCallEvent',
    });

    const event = drafts[0];

    assert.equal(event?.type, 'agent.model.started');
    if (!event || event.type !== 'agent.model.started') {
      throw new Error('model started event was not normalized');
    }
    assert.equal('projectedInputTokens' in (drafts[0] ?? {}), false);
  });

  it('redacts common secret shapes before events leave the sidecar', () => {
    const input = [
      'Authorization: Bearer abc.def',
      'password="plain-text"',
      'Cookie: sid=123',
      '-----BEGIN PRIVATE KEY-----',
      'abc',
      '-----END PRIVATE KEY-----',
    ].join('\n');
    const redacted = redactForStream(input);

    assert.doesNotMatch(redacted, /abc\.def/u);
    assert.doesNotMatch(redacted, /plain-text/u);
    assert.doesNotMatch(redacted, /sid=123/u);
    assert.match(redacted, /\[REDACTED_PRIVATE_KEY\]/u);
  });

  it('assigns stable runtime metadata in emission order', () => {
    const bus = new AgentStreamEventBus({
      runId: 'run-1',
      sessionId: 'session-1',
      agentId: 'agent-1',
      now: () => '2026-05-02T00:00:00.000Z',
    });
    const events = [
      bus.emitDraft({
        type: 'agent.run.started',
        visibility: 'user',
        level: 'info',
        inputPreview: 'start',
      }),
      bus.emitDraft({
        type: 'agent.run.completed',
        visibility: 'user',
        level: 'info',
      }),
    ];

    assert.equal(events[0]?.seq, 0);
    assert.equal(events[1]?.seq, 1);
    assert.equal(events[0]?.schemaVersion, 1);
    assert.equal(events[0]?.redacted, true);
  });

  it('clears pre-tool visible text and streams the final answer segment after tool calls', async () => {
    const emittedEvents: TAgentRuntimeOutputEvent[] = [];
    const runtimeEvents = new AgentStreamEventBus({
      runId: 'run-1',
      sessionId: 'session-1',
      agentId: 'agent-1',
      now: () => '2026-05-02T00:00:00.000Z',
    });
    const agent = {
      async *stream() {
        yield {
          type: 'modelStreamUpdateEvent',
          event: {
            type: 'modelContentBlockDeltaEvent',
            delta: {
              type: 'textDelta',
              text: '我先查看文件。',
            },
          },
        };
        yield {
          type: 'beforeToolCallEvent',
          toolUse: {
            name: 'read_file',
            input: {
              path: 'src/app.ts',
            },
          },
        };
        yield {
          type: 'afterToolCallEvent',
          toolUse: {
            name: 'read_file',
            input: {
              path: 'src/app.ts',
            },
          },
          result: {
            status: 'success',
          },
        };
        yield {
          type: 'modelStreamUpdateEvent',
          event: {
            type: 'modelContentBlockDeltaEvent',
            delta: {
              type: 'textDelta',
              text: '最终回答第一段。',
            },
          },
        };

        return {
          stopReason: 'endTurn',
          lastMessage: {
            content: [
              {
                type: 'textBlock',
                text: '最终回答第一段。',
              },
            ],
          },
        };
      },
    };

    const result = await runAgentStream({
      agent,
      prompt: '检查文件',
      streamOptions: {},
      eventBus: runtimeEvents,
      emitOutputEvent: (event) => {
        emittedEvents.push(event);
      },
      toJsonValue: (value): TJsonValue => JSON.parse(JSON.stringify(value)) as TJsonValue,
    });

    assert.deepEqual(emittedEvents.filter((event) => event.type === 'message_delta'), [
      {
        type: 'message_delta',
        text: '最终回答第一段。',
        phase: 'final',
      },
    ]);
    assert.equal(result.visibleText, '最终回答第一段。');
  });

  it('flushes the final visible text on completion when no tool call occurred', async () => {
    const emittedEvents: TAgentRuntimeOutputEvent[] = [];
    const runtimeEvents = new AgentStreamEventBus({
      runId: 'run-plain',
      sessionId: 'session-plain',
      agentId: 'agent-plain',
      now: () => '2026-05-02T00:00:00.000Z',
    });
    const agent = {
      async *stream() {
        yield {
          type: 'modelStreamUpdateEvent',
          event: {
            type: 'modelContentBlockDeltaEvent',
            delta: {
              type: 'textDelta',
              text: '直接回答。',
            },
          },
        };

        return {
          stopReason: 'endTurn',
          lastMessage: {
            content: [
              {
                type: 'textBlock',
                text: '直接回答。',
              },
            ],
          },
        };
      },
    };

    const result = await runAgentStream({
      agent,
      prompt: '直接回答',
      streamOptions: {},
      eventBus: runtimeEvents,
      emitOutputEvent: (event) => {
        emittedEvents.push(event);
      },
      toJsonValue: (value): TJsonValue => JSON.parse(JSON.stringify(value)) as TJsonValue,
    });

    assert.deepEqual(emittedEvents.filter((event) => event.type === 'message_delta'), [{
      type: 'message_delta',
      text: '直接回答。',
      phase: 'final',
    }]);
    assert.equal(result.visibleText, '直接回答。');
  });
});
