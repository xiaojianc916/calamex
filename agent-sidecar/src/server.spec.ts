import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import type { OpenAICompatibleConfig } from '@mastra/core/llm';

import { buildSystemPrompt, extractVisibleAgentResultText } from './engines/agent-runtime-helpers.js';
import { MastraRuntime } from './engines/mastra-runtime.js';
import {
  createConfiguredRuntime,
  resolveConfiguredRuntimeName,
  type IAgentSidecarRuntime,
} from './engines/runtime.js';
import { agentPlanSchema } from './schemas/plan.js';
import {
  agentSidecarChatRequestSchema,
  agentSidecarExecuteRequestSchema,
  agentSidecarPlanRequestSchema,
  agentSidecarRollbackRestoreRequestSchema,
  createAgentSidecarServer,
} from './server.js';

const unsupportedRuntimeResponse = async (
  ...args: Parameters<IAgentSidecarRuntime['chat']>
): Promise<Awaited<ReturnType<IAgentSidecarRuntime['chat']>>> => {
  void args;
  throw new Error('Not implemented in test runtime.');
};

const unsupportedApprovalResolution = async (
  ...args: Parameters<IAgentSidecarRuntime['resolveApproval']>
): Promise<Awaited<ReturnType<IAgentSidecarRuntime['resolveApproval']>>> => {
  void args;
  throw new Error('Not implemented in test runtime.');
};

const isMastraRequestContextLike = (value: unknown): value is {
  get: (key: string) => unknown;
  toJSON: () => unknown;
} => Boolean(
  value
  && typeof value === 'object'
  && 'get' in value
  && typeof value.get === 'function'
  && 'toJSON' in value
  && typeof value.toJSON === 'function',
);

const assertMastraRequestContext = (
  value: unknown,
  expected: Record<string, unknown>,
): void => {
  assert.equal(isMastraRequestContextLike(value), true);

  if (!isMastraRequestContextLike(value)) {
    return;
  }

  for (const [key, expectedValue] of Object.entries(expected)) {
    assert.deepEqual(value.get(key), expectedValue);
  }

  assert.deepEqual(value.toJSON(), expected);
};

const unsupportedRollbackRestore = async (
  ...args: Parameters<IAgentSidecarRuntime['restoreCheckpoint']>
): Promise<Awaited<ReturnType<IAgentSidecarRuntime['restoreCheckpoint']>>> => {
  void args;
  throw new Error('Not implemented in test runtime.');
};

const createFakeRuntime = (
  overrides: Partial<IAgentSidecarRuntime> = {},
): IAgentSidecarRuntime => ({
  name: 'fake-runtime',
  version: 'test-version',
  chat: unsupportedRuntimeResponse,
  plan: unsupportedRuntimeResponse,
  execute: unsupportedRuntimeResponse,
  resolveApproval: unsupportedApprovalResolution,
  restoreCheckpoint: unsupportedRollbackRestore,
  ...overrides,
});

const startServer = async (runtime: IAgentSidecarRuntime): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> => {
  const server = createAgentSidecarServer({ runtime });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') {
    throw new Error('expected TCP server address');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    }),
  };
};

const parseNdjsonFrames = (body: string): unknown[] => body
  .trim()
  .split('\n')
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line));

describe('Agent sidecar request schema', () => {
  it('normalizes nullable optional fields from old Tauri clients', () => {
    const payload = agentSidecarChatRequestSchema.parse({
      sessionId: null,
      mode: null,
      goal: null,
      messages: [],
      workspaceRootPath: null,
      context: [],
    });

    assert.equal(payload.sessionId, undefined);
    assert.equal(payload.mode, undefined);
    assert.equal(payload.goal, undefined);
    assert.equal(payload.workspaceRootPath, null);
  });

  it('accepts omitted optional fields from current Tauri clients', () => {
    const payload = agentSidecarExecuteRequestSchema.parse({
      goal: 'run',
      messages: [{ role: 'user', content: 'run' }],
      context: [],
    });

    assert.equal(payload.sessionId, undefined);
    assert.equal(payload.mode, undefined);
    assert.equal(payload.workspaceRootPath, undefined);
    assert.equal(payload.goal, 'run');
  });

  it('normalizes blank optional fields without accepting invalid modes', () => {
    const payload = agentSidecarChatRequestSchema.parse({
      sessionId: '',
      mode: ' ',
      goal: ' ',
      messages: [],
      workspaceRootPath: '',
      context: [],
    });

    assert.equal(payload.sessionId, undefined);
    assert.equal(payload.mode, undefined);
    assert.equal(payload.goal, undefined);
    assert.equal(payload.workspaceRootPath, undefined);
    assert.throws(() => agentSidecarChatRequestSchema.parse({
      mode: 'invalid',
      messages: [],
      context: [],
    }));
  });

  it('requires a non-empty goal for plan and execute requests', () => {
    assert.throws(() =>
      agentSidecarPlanRequestSchema.parse({
        goal: ' ',
        messages: [],
        context: [],
      }),
    );
    assert.throws(() =>
      agentSidecarExecuteRequestSchema.parse({
        goal: null,
        messages: [],
        context: [],
      }),
    );
  });

  it('keeps valid execute payloads aligned with engine input fields', () => {
    const payload = agentSidecarExecuteRequestSchema.parse({
      sessionId: null,
      mode: 'agent',
      goal: ' run ',
      messages: [{ role: 'user', content: 'run' }],
      workspaceRootPath: 'D:/com.xiaojianc/my_desktop_app',
      context: [],
    });

    assert.equal(payload.sessionId, undefined);
    assert.equal(payload.mode, 'agent');
    assert.equal(payload.goal, 'run');
    assert.equal(payload.messages.length, 1);
    assert.equal(payload.workspaceRootPath, 'D:/com.xiaojianc/my_desktop_app');
  });

  it('accepts rollback restore requests with optional nested step paths', () => {
    const payload = agentSidecarRollbackRestoreRequestSchema.parse({
      sessionId: 'rollback-session',
      runId: 'run-1',
      snapshotId: 'run-1',
      step: ['durable-agentic-execution', 'durable-llm-execution'],
    });

    assert.equal(payload.sessionId, 'rollback-session');
    assert.equal(payload.runId, 'run-1');
    assert.equal(payload.snapshotId, 'run-1');
    assert.deepEqual(payload.step, ['durable-agentic-execution', 'durable-llm-execution']);
  });
});

describe('Agent sidecar system prompt', () => {
  it('keeps identity prompt model-aware and concise', () => {
    const prompt = buildSystemPrompt({
      mode: 'agent',
      goal: '回答你是谁',
      messages: [{ role: 'user', content: '你是谁' }],
      context: [],
    }, 'deepseek-v4-pro');

    assert.match(prompt, /当前模型：deepseek-v4-pro/);
    assert.match(prompt, /DeepSeek/);
    assert.doesNotMatch(prompt, /不要自称|由 .* 公司开发/);
  });

  it('allows Claude identity when the current model is Claude', () => {
    const prompt = buildSystemPrompt({
      mode: 'agent',
      goal: '回答你是谁',
      messages: [{ role: 'user', content: '你是谁' }],
      context: [],
    }, 'anthropic/claude-sonnet-4-6');

    assert.match(prompt, /当前模型：anthropic\/claude-sonnet-4-6/);
    assert.match(prompt, /Anthropic/);
    assert.doesNotMatch(prompt, /当前模型不是|不要自称/);
  });
});

describe('Agent sidecar visible result', () => {
  it('does not expose reasoning blocks in the final assistant text', () => {
    const result = {
      stopReason: 'endTurn',
      lastMessage: {
        content: [
          {
            type: 'reasoningBlock',
            text: '内部推理，不应该进入用户可见回答。',
          },
          {
            type: 'textBlock',
            text: '这是用户应该看到的回答。',
          },
        ],
      },
    };

    const visibleText = extractVisibleAgentResultText(result);

    assert.equal(visibleText, '这是用户应该看到的回答。');
    assert.doesNotMatch(visibleText, /Reasoning|内部推理/u);
  });

  it('preserves fenced code formatting when visible text is split across multiple text blocks', () => {
    const result = {
      stopReason: 'endTurn',
      lastMessage: {
        content: [
          {
            type: 'textBlock',
            text: '不过我可以帮你把它的内容清空（已经是空的），或者建议你手动执行：\n\n```bash\n',
          },
          {
            type: 'textBlock',
            text: 'Remove-Item .\\666.sh\n```\n',
          },
        ],
      },
    };

    const visibleText = extractVisibleAgentResultText(result);

    assert.equal(
      visibleText,
      '不过我可以帮你把它的内容清空（已经是空的），或者建议你手动执行：\n\n```bash\nRemove-Item .\\666.sh\n```',
    );
  });
});

describe('Agent runtime configuration', () => {
  it('defaults AGENT_RUNTIME to mastra when unset or blank', () => {
    assert.equal(resolveConfiguredRuntimeName({}), 'mastra');
    assert.equal(resolveConfiguredRuntimeName({ AGENT_RUNTIME: ' ' }), 'mastra');
    assert.equal(createConfiguredRuntime({}).name, 'mastra');
  });

  it('only accepts mastra and rejects unsupported runtime names', () => {
    assert.equal(resolveConfiguredRuntimeName({ AGENT_RUNTIME: 'mastra' }), 'mastra');
    assert.equal(createConfiguredRuntime({ AGENT_RUNTIME: 'mastra' }).name, 'mastra');

    assert.throws(
      () => resolveConfiguredRuntimeName({ AGENT_RUNTIME: 'legacy-runtime' }),
      /Unsupported AGENT_RUNTIME: legacy-runtime/u,
    );
  });
});

describe('Mastra runtime chat', () => {
  it('maps Mastra text chunks to cumulative message_delta events without changing the sidecar contract', async () => {
    let capturedMessages: unknown;
    let capturedStreamOptions: unknown;
    let capturedModel: OpenAICompatibleConfig | null = null;
    let disconnectCalls = 0;
    const runtime = new MastraRuntime({
      readModelConfig: () => ({
        apiKey: 'test-key',
        baseUrl: 'https://example.com/v1',
        model: 'deepseek-chat',
      }),
      createMcpClientBundle: async () => ({
        clients: [],
        configs: [],
        errors: [],
        tools: [],
        disconnectAll: async () => {
          disconnectCalls += 1;
        },
      }),
      createAgent: (config) => {
        capturedModel = config.model;

        return {
          stream: async (messages, streamOptions) => {
            capturedMessages = messages;
            capturedStreamOptions = streamOptions;

            return {
              fullStream: (async function* () {
                yield {
                  type: 'text-delta',
                  runId: 'run-1',
                  from: 'AGENT',
                  payload: {
                    id: 'text-1',
                    text: '你好',
                  },
                };
                yield {
                  type: 'text-delta',
                  runId: 'run-1',
                  from: 'AGENT',
                  payload: {
                    id: 'text-1',
                    text: '，世界',
                  },
                };
                yield {
                  type: 'finish',
                  runId: 'run-1',
                  from: 'AGENT',
                  payload: {
                    stepResult: {
                      reason: 'stop',
                    },
                    output: {
                      usage: {
                        inputTokens: 1,
                        outputTokens: 2,
                        totalTokens: 3,
                      },
                    },
                    metadata: {},
                    messages: {
                      all: [],
                      user: [],
                      nonUser: [],
                    },
                  },
                };
              })(),
            };
          },
          generate: async () => {
            throw new Error('generate should not be used in Mastra chat test');
          },
        };
      },
    });
    const streamedEvents: unknown[] = [];
    const abortController = new AbortController();

    const response = await runtime.chat({
      mode: 'ask',
      goal: '请打招呼',
      messages: [
        { role: 'assistant', content: '你好，我可以帮你做什么？' },
        { role: 'user', content: '请打招呼' },
      ],
      context: [],
    }, {
      context: {
        requestId: 'req-123',
        signal: abortController.signal,
        timeoutMs: 1_000,
      },
      onEvent: (event) => {
        streamedEvents.push(event);
      },
    });

    assert.deepEqual(capturedModel, {
      id: 'deepseek/deepseek-chat',
      url: 'https://example.com/v1',
      apiKey: 'test-key',
    });
    assert.deepEqual(capturedMessages, [
      { role: 'assistant', content: '你好，我可以帮你做什么？' },
      { role: 'user', content: '请打招呼' },
    ]);
    assert.deepEqual(capturedStreamOptions, {
      abortSignal: abortController.signal,
      runId: 'req-123',
      maxSteps: 1,
      toolChoice: 'none',
    });
    assert.deepEqual(streamedEvents, [
      {
        type: 'message_delta',
        text: '你好',
        phase: 'final',
      },
      {
        type: 'message_delta',
        text: '你好，世界',
        phase: 'final',
      },
      {
        type: 'done',
        result: '你好，世界',
      },
    ]);
    assert.deepEqual(response, {
      sessionId: response.sessionId,
      events: streamedEvents,
      result: '你好，世界',
    });
    assert.match(response.sessionId, /^mastra-chat-/u);
    assert.equal(disconnectCalls, 1);
  });

  it('routes Mastra reasoning chunks into agent runtime events instead of final text', async () => {
    let disconnectCalls = 0;
    const runtime = new MastraRuntime({
      now: () => '2026-05-07T00:00:00.000Z',
      readModelConfig: () => ({
        apiKey: 'test-key',
        baseUrl: 'https://example.com/v1',
        model: 'deepseek-chat',
      }),
      createMcpClientBundle: async () => ({
        clients: [],
        configs: [],
        errors: [],
        tools: [],
        disconnectAll: async () => {
          disconnectCalls += 1;
        },
      }),
      createAgent: () => ({
        stream: async () => ({
          fullStream: (async function* () {
            yield {
              type: 'reasoning',
              runId: 'run-reasoning',
              textDelta: 'The user wants the raw reasoning in the activity tree.',
            };
            yield {
              type: 'text-delta',
              runId: 'run-reasoning',
              payload: {
                id: 'text-1',
                text: '这是最终回答。',
              },
            };
          })(),
        }),
        generate: async () => {
          throw new Error('generate should not be used in Mastra reasoning test');
        },
      }),
    });
    const streamedEvents: unknown[] = [];
    const abortController = new AbortController();

    const response = await runtime.chat({
      mode: 'ask',
      goal: '测试 reasoning',
      messages: [{ role: 'user', content: '测试 reasoning' }],
      context: [],
    }, {
      context: {
        requestId: 'req-reasoning',
        signal: abortController.signal,
        timeoutMs: 1_000,
      },
      onEvent: (event) => {
        streamedEvents.push(event);
      },
    });
    const reasoningEvent = streamedEvents[0];

    assert.equal(typeof reasoningEvent, 'object');
    assert.notEqual(reasoningEvent, null);
    assert.equal((reasoningEvent as { type?: unknown }).type, 'agent_event');
    assert.equal(
      (reasoningEvent as { event?: { type?: unknown } }).event?.type,
      'agent.reasoning.delta',
    );
    assert.equal(
      (reasoningEvent as { event?: { text?: unknown } }).event?.text,
      'The user wants the raw reasoning in the activity tree.',
    );
    assert.deepEqual(streamedEvents.filter((event) =>
      (event as { type?: unknown }).type === 'message_delta'
    ), [
      {
        type: 'message_delta',
        text: '这是最终回答。',
        phase: 'final',
      },
    ]);
    assert.equal(response.result, '这是最终回答。');
    assert.equal(disconnectCalls, 1);
  });

  it('streams Mastra tool calls into the new runtime activity timeline', async () => {
    let disconnectCalls = 0;
    const runtime = new MastraRuntime({
      readModelConfig: () => ({
        apiKey: 'test-key',
        baseUrl: 'https://example.com/v1',
        model: 'deepseek-chat',
      }),
      createMcpClientBundle: async () => ({
        clients: [],
        configs: [],
        errors: [],
        tools: [],
        disconnectAll: async () => {
          disconnectCalls += 1;
        },
      }),
      createAgent: () => ({
        stream: async () => ({
          runId: 'run-tool-activity',
          fullStream: (async function* () {
            yield {
              type: 'tool-call',
              runId: 'run-tool-activity',
              payload: {
                toolName: 'web_search',
                toolCallId: 'tool-call-1',
                args: {
                  query: '全球矿产最新动态',
                  apiKey: 'secret-value',
                },
              },
            };
            yield {
              type: 'tool-result',
              runId: 'run-tool-activity',
              payload: {
                toolName: 'web_search',
                result: {
                  status: 'success',
                  summary: '搜索完成',
                },
              },
            };
            yield {
              type: 'text-delta',
              runId: 'run-tool-activity',
              payload: {
                id: 'text-tool-activity',
                text: '已完成搜索。',
              },
            };
          })(),
        }),
        generate: async () => {
          throw new Error('generate should not be used in Mastra tool runtime test');
        },
      }),
    });
    const streamedEvents: unknown[] = [];

    const response = await runtime.chat({
      mode: 'ask',
      goal: '搜索全球矿产',
      messages: [{ role: 'user', content: '搜索全球矿产' }],
      context: [],
    }, {
      onEvent: (event) => {
        streamedEvents.push(event);
      },
    });
    const runtimeToolEvents = streamedEvents.filter((event) => {
      const candidate = event as { type?: unknown; event?: { type?: unknown } };
      return candidate.type === 'agent_event'
        && (
          candidate.event?.type === 'agent.tool.started'
          || candidate.event?.type === 'agent.tool.completed'
        );
    });
    const startedEvent = runtimeToolEvents[0] as {
      event?: {
        type?: unknown;
        toolName?: unknown;
        toolUseId?: unknown;
        inputPreview?: unknown;
      };
    };
    const completedEvent = runtimeToolEvents[1] as {
      event?: {
        type?: unknown;
        toolName?: unknown;
        resultPreview?: unknown;
        ok?: unknown;
      };
    };

    assert.equal(runtimeToolEvents.length, 2);
    assert.equal(startedEvent.event?.type, 'agent.tool.started');
    assert.equal(startedEvent.event?.toolName, 'web_search');
    assert.equal(startedEvent.event?.toolUseId, 'tool-call-1');
    assert.match(String(startedEvent.event?.inputPreview ?? ''), /全球矿产最新动态/u);
    assert.doesNotMatch(String(startedEvent.event?.inputPreview ?? ''), /secret-value/u);
    assert.equal(completedEvent.event?.type, 'agent.tool.completed');
    assert.equal(completedEvent.event?.toolName, 'web_search');
    assert.equal(completedEvent.event?.ok, true);
    assert.match(String(completedEvent.event?.resultPreview ?? ''), /搜索完成/u);
    assert.equal(response.result, '已完成搜索。');
    assert.equal(disconnectCalls, 1);
  });

  it('normalizes Mastra stream errors into the existing error event shape', async () => {
    let disconnectCalls = 0;
    const runtime = new MastraRuntime({
      readModelConfig: () => ({
        apiKey: 'test-key',
        baseUrl: 'https://example.com/v1',
        model: 'deepseek-chat',
      }),
      createMcpClientBundle: async () => ({
        clients: [],
        configs: [],
        errors: [],
        tools: [],
        disconnectAll: async () => {
          disconnectCalls += 1;
        },
      }),
      createAgent: () => ({
        stream: async () => ({
          fullStream: (async function* () {
            yield {
              type: 'error',
              runId: 'run-err',
              from: 'AGENT',
              payload: {
                error: new Error('mastra exploded'),
              },
            };
          })(),
        }),
        generate: async () => {
          throw new Error('generate should not be used in Mastra chat error test');
        },
      }),
    });

    const response = await runtime.chat({
      mode: 'ask',
      goal: 'hello',
      messages: [{ role: 'user', content: 'hello' }],
      context: [],
    });

    assert.deepEqual(response.events, [{
      type: 'error',
      message: 'Mastra Agent 执行失败：mastra exploded',
    }]);
    assert.equal(response.result, null);
    assert.equal(disconnectCalls, 1);
  });
});

describe('Mastra runtime execute', () => {
  it('exposes MCP tools to Mastra execute, keeps the sidecar event contract, and releases the bundle after the run', async () => {
    let capturedInstructions = '';
    let capturedMessages: unknown;
    let capturedStreamOptions: unknown;
    let capturedToolNames: string[] = [];
    let disconnectCalls = 0;
    const runtime = new MastraRuntime({
      readModelConfig: () => ({
        apiKey: 'test-key',
        baseUrl: 'https://example.com/v1',
        model: 'deepseek-chat',
      }),
      createMcpClientBundle: async () => ({
        clients: [],
        configs: [],
        errors: [],
        tools: [
          {
            name: 'read_file',
            description: '读取文件内容',
            toolSpec: {
              inputSchema: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                },
                required: ['path'],
                additionalProperties: false,
              },
            },
            mcpClient: {
              callTool: async () => ({
                content: [{ type: 'text', text: 'README 内容' }],
                isError: false,
              }),
            },
          },
        ],
        disconnectAll: async () => {
          disconnectCalls += 1;
        },
      }),
      now: () => '2026-05-03T00:00:00.000Z',
      createExecutionHandle: async (config) => {
        capturedInstructions = config.instructions;
        capturedToolNames = Object.keys(config.tools ?? {});

        return {
          agent: {
            stream: async (messages, streamOptions) => {
              capturedMessages = messages;
              capturedStreamOptions = streamOptions;

              return {
                runId: 'run-execute',
                cleanup: () => undefined,
                fullStream: (async function* () {
                  yield {
                    type: 'tool-call',
                    runId: 'run-execute',
                    from: 'AGENT',
                    payload: {
                      toolCallId: 'tool-1',
                      toolName: 'read_file',
                      args: {
                        path: 'README.md',
                      },
                    },
                  };
                  yield {
                    type: 'tool-result',
                    runId: 'run-execute',
                    from: 'TOOL',
                    payload: {
                      toolName: 'read_file',
                      result: {
                        content: [{ type: 'text', text: 'README 内容' }],
                        isError: false,
                      },
                    },
                  };
                  yield {
                    type: 'text-delta',
                    runId: 'run-execute',
                    from: 'AGENT',
                    payload: {
                      id: 'text-execute',
                      text: '执行完成',
                    },
                  };
                })(),
              };
            },
            generate: async () => {
              throw new Error('generate should not be used in Mastra execute test');
            },
          },
          workflow: {
            id: 'durable-agentic-loop',
            createRun: async () => ({
              timeTravel: async () => ({ output: { text: '' } }),
            }),
          },
        };
      },
    });
    const streamedEvents: unknown[] = [];

    const response = await runtime.execute({
      mode: 'ask',
      goal: '请直接执行',
      messages: [{ role: 'user', content: '请直接执行' }],
      context: [],
    }, {
      onEvent: (event) => {
        streamedEvents.push(event);
      },
    });

    assert.match(capturedInstructions, /Agent 模式要求/u);
    assert.deepEqual(capturedMessages, [
      { role: 'user', content: '请直接执行' },
    ]);
    assert.deepEqual(capturedToolNames, ['read_file']);
    const streamOptions = capturedStreamOptions as {
      runId?: unknown;
      maxSteps?: unknown;
      toolChoice?: unknown;
      requestContext?: unknown;
    };
    assert.equal(typeof streamOptions.runId, 'string');
    assert.equal(streamOptions.maxSteps, 10);
    assert.equal(streamOptions.toolChoice, 'auto');
    assertMastraRequestContext(streamOptions.requestContext, {
      mode: 'agent',
      goal: '请直接执行',
      systemPrompt: capturedInstructions,
      workspaceRootPath: null,
      context: [],
    });
    assert.deepEqual(streamedEvents, [
      {
        type: 'agent_event',
        event: {
          id: streamedEvents[0] && typeof streamedEvents[0] === 'object' && streamedEvents[0] !== null && 'event' in streamedEvents[0]
            ? (streamedEvents[0] as { event: { id: string } }).event.id
            : '',
          type: 'rollback.checkpoint.created',
          runId: 'run-execute',
          sessionId: response.sessionId,
          agentId: 'calamex-agent-sidecar',
          timestamp: '2026-05-03T00:00:00.000Z',
          seq: 0,
          schemaVersion: 1,
          redacted: true,
          visibility: 'user',
          level: 'info',
          snapshotId: 'run-execute',
        },
      },
      {
        type: 'agent_event',
        event: {
          id: streamedEvents[1] && typeof streamedEvents[1] === 'object' && streamedEvents[1] !== null && 'event' in streamedEvents[1]
            ? (streamedEvents[1] as { event: { id: string } }).event.id
            : '',
          type: 'agent.tool.started',
          runId: 'run-execute',
          sessionId: response.sessionId,
          agentId: 'calamex-agent-sidecar',
          timestamp: '2026-05-03T00:00:00.000Z',
          seq: 1,
          schemaVersion: 1,
          redacted: true,
          visibility: 'user',
          level: 'info',
          toolName: 'read_file',
          toolUseId: 'tool-1',
          inputPreview: '{"path":"README.md"}',
        },
      },
      {
        type: 'tool_start',
        toolName: 'read_file',
        input: {
          path: 'README.md',
        },
      },
      {
        type: 'agent_event',
        event: {
          id: streamedEvents[3] && typeof streamedEvents[3] === 'object' && streamedEvents[3] !== null && 'event' in streamedEvents[3]
            ? (streamedEvents[3] as { event: { id: string } }).event.id
            : '',
          type: 'agent.tool.completed',
          runId: 'run-execute',
          sessionId: response.sessionId,
          agentId: 'calamex-agent-sidecar',
          timestamp: '2026-05-03T00:00:00.000Z',
          seq: 2,
          schemaVersion: 1,
          redacted: true,
          visibility: 'user',
          level: 'info',
          toolName: 'read_file',
          ok: true,
          resultPreview: '{"content":[{"type":"text","text":"README 内容"}],"isError":false}',
        },
      },
      {
        type: 'tool_result',
        toolName: 'read_file',
        output: {
          content: [{ type: 'text', text: 'README 内容' }],
          isError: false,
        },
      },
      {
        type: 'message_delta',
        text: '执行完成',
        phase: 'final',
      },
      {
        type: 'done',
        result: '执行完成',
      },
    ]);
    assert.deepEqual(response, {
      sessionId: response.sessionId,
      events: streamedEvents,
      result: '执行完成',
    });
    assert.match(response.sessionId, /^mastra-execute-/u);
    assert.equal(disconnectCalls, 1);
  });
});

describe('Mastra runtime approval resolution', () => {
  it('resumes a pending approval on the original agent instance while keeping the approval request id opaque to the client', async () => {
    let capturedApprovalOptions: unknown;
    let disconnectCalls = 0;
    const runtime = new MastraRuntime({
      readModelConfig: () => ({
        apiKey: 'test-key',
        baseUrl: 'https://example.com/v1',
        model: 'deepseek-chat',
      }),
      createMcpClientBundle: async () => ({
        clients: [],
        configs: [],
        errors: [],
        tools: [],
        disconnectAll: async () => {
          disconnectCalls += 1;
        },
      }),
      now: () => '2026-05-03T00:00:00.000Z',
      createExecutionHandle: async () => ({
        agent: {
          stream: async () => ({
            runId: 'approval-run-1',
            cleanup: () => undefined,
            fullStream: (async function* () {
              yield {
                type: 'tool-call-approval',
                runId: 'approval-run-1',
                from: 'AGENT',
                payload: {
                  toolCallId: 'tool-approval-1',
                  toolName: 'write_file',
                  args: {
                    path: 'README.md',
                  },
                },
              };
            })(),
          }),
          generate: async () => {
            throw new Error('generate should not be used in Mastra approval resume test');
          },
          approveToolCall: async (approvalOptions) => {
            capturedApprovalOptions = approvalOptions;

            return {
              runId: 'approval-run-1',
              cleanup: () => undefined,
              fullStream: (async function* () {
                yield {
                  type: 'tool-result',
                  runId: 'approval-run-1',
                  from: 'TOOL',
                  payload: {
                    toolName: 'write_file',
                    result: {
                      ok: true,
                    },
                  },
                };
                yield {
                  type: 'text-delta',
                  runId: 'approval-run-1',
                  from: 'AGENT',
                  payload: {
                    id: 'approval-text-1',
                    text: '审批后继续执行',
                  },
                };
              })(),
            };
          },
          declineToolCall: async () => {
            throw new Error('declineToolCall should not be used in Mastra approval resume test');
          },
        },
        workflow: {
          id: 'durable-agentic-loop',
          createRun: async () => ({
            timeTravel: async () => ({ output: { text: '' } }),
          }),
        },
      }),
    });

    const initial = await runtime.execute({
      mode: 'agent',
      goal: '请修改 README',
      messages: [{ role: 'user', content: '请修改 README' }],
      context: [],
    });

    assert.equal(initial.result, null);
    assert.equal(initial.events.length, 2);
    assert.equal(initial.events[0]?.type, 'agent_event');
    assert.equal(initial.events[1]?.type, 'approval_required');
    assert.equal(disconnectCalls, 0);

    if (initial.events[1]?.type !== 'approval_required') {
      throw new Error('expected approval_required event');
    }

    const approvalRequestId = initial.events[1].request.id;
    assert.match(approvalRequestId, /^mastra-approval\./u);

    const resumed = await runtime.resolveApproval({
      sessionId: initial.sessionId,
      requestId: approvalRequestId,
      decision: 'approved',
    });

    assert.deepEqual(capturedApprovalOptions, {
      runId: 'approval-run-1',
      toolCallId: 'tool-approval-1',
    });
    assert.deepEqual(resumed.events, [
      {
        type: 'agent_event',
        event: {
          id: resumed.events[0] && resumed.events[0].type === 'agent_event'
            ? resumed.events[0].event.id
            : '',
          type: 'agent.tool.completed',
          runId: 'approval-run-1',
          sessionId: initial.sessionId,
          agentId: 'calamex-agent-sidecar',
          timestamp: '2026-05-03T00:00:00.000Z',
          seq: 0,
          schemaVersion: 1,
          redacted: true,
          visibility: 'user',
          level: 'info',
          toolName: 'write_file',
          ok: true,
          resultPreview: '{"ok":true}',
        },
      },
      {
        type: 'tool_result',
        toolName: 'write_file',
        output: {
          ok: true,
        },
      },
      {
        type: 'message_delta',
        text: '审批后继续执行',
        phase: 'final',
      },
      {
        type: 'done',
        result: '审批后继续执行',
      },
    ]);
    assert.equal(resumed.result, '审批后继续执行');
    assert.equal(disconnectCalls, 1);
  });

  it('keeps the existing approval tool_result plus done contract instead of returning a runtime-specific placeholder error', async () => {
    const runtime = new MastraRuntime({
      createAgent: () => {
        throw new Error('createAgent should not be used in Mastra approval test');
      },
      readModelConfig: () => null,
    });
    const streamedEvents: unknown[] = [];

    const response = await runtime.resolveApproval({
      sessionId: 'approval-session',
      requestId: 'approval-1',
      decision: 'approved',
    }, {
      onEvent: (event) => {
        streamedEvents.push(event);
      },
    });

    assert.deepEqual(streamedEvents, [
      {
        type: 'tool_result',
        toolName: 'approval',
        output: {
          requestId: 'approval-1',
          decision: 'approved',
        },
      },
      {
        type: 'done',
        result: '审批结果已记录，等待下一次 Agent 执行继续消费。',
      },
    ]);
    assert.deepEqual(response, {
      sessionId: 'approval-session',
      events: streamedEvents,
      result: '审批结果已记录，等待下一次 Agent 执行继续消费。',
    });
  });
});

describe('Mastra runtime plan', () => {
  it('keeps plan_ready plus done unchanged while exposing MCP tools to Mastra plan mode', async () => {
    let capturedMessages: unknown;
    let capturedGenerateOptions: unknown;
    let capturedModel: OpenAICompatibleConfig | null = null;
    let capturedToolNames: string[] = [];
    let disconnectCalls = 0;
    const plan = agentPlanSchema.parse({
      goal: '完成迁移',
      steps: [
        {
          id: 'step-1',
          title: '抽象 runtime 接口',
          goal: '把 provider 细节隔离到 sidecar runtime 层。',
          status: 'pending',
          tools: ['read_file'],
          riskLevel: 'low',
          requiresApproval: false,
          expectedOutput: '完成 runtime contract 抽象。',
        },
        {
          id: 'step-2',
          title: '补协议回归测试',
          goal: '确认流式事件与 plan 事件保持兼容。',
          status: 'pending',
          tools: ['test'],
          riskLevel: 'medium',
          requiresApproval: true,
          expectedOutput: '新增通过的协议测试。',
        },
      ],
    });
    const runtime = new MastraRuntime({
      readModelConfig: () => ({
        apiKey: 'test-key',
        baseUrl: 'https://example.com/v1',
        model: 'deepseek-chat',
      }),
      createMcpClientBundle: async () => ({
        tools: [
          {
            name: 'read_file',
            description: '读取文件内容',
            toolSpec: {
              inputSchema: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                },
                required: ['path'],
                additionalProperties: false,
              },
            },
            mcpClient: {
              callTool: async () => ({
                content: [{ type: 'text', text: 'README 内容' }],
                isError: false,
              }),
            },
          },
        ],
        disconnectAll: async () => {
          disconnectCalls += 1;
        },
      }),
      createAgent: (config) => {
        capturedModel = config.model;
        capturedToolNames = Object.keys(config.tools ?? {});

        return {
          stream: async () => ({
            fullStream: (async function* () { })(),
          }),
          generate: async (messages, generateOptions) => {
            capturedMessages = messages;
            capturedGenerateOptions = generateOptions;

            return {
              object: plan,
              text: '',
            };
          },
        };
      },
    });
    const abortController = new AbortController();
    const streamedEvents: unknown[] = [];

    const response = await runtime.plan({
      mode: 'plan',
      goal: '完成迁移',
      messages: [{ role: 'user', content: '给我一个迁移计划' }],
      context: [],
    }, {
      context: {
        requestId: 'plan-req-1',
        signal: abortController.signal,
        timeoutMs: 1_000,
      },
      onEvent: (event) => {
        streamedEvents.push(event);
      },
    });

    assert.deepEqual(capturedModel, {
      id: 'deepseek/deepseek-chat',
      url: 'https://example.com/v1',
      apiKey: 'test-key',
    });
    assert.deepEqual(capturedToolNames, ['read_file']);
    assert.deepEqual(capturedMessages, [
      { role: 'user', content: '目标：完成迁移\n给我一个迁移计划' },
    ]);
    assert.deepEqual(capturedGenerateOptions, {
      abortSignal: abortController.signal,
      runId: 'plan-req-1',
      maxSteps: 10,
      toolChoice: 'auto',
      structuredOutput: {
        schema: agentPlanSchema,
      },
    });
    assert.deepEqual(streamedEvents, [
      {
        type: 'plan_ready',
        plan,
      },
      {
        type: 'done',
        result: '已生成计划：2 个待办事项。',
      },
    ]);
    assert.deepEqual(response, {
      sessionId: response.sessionId,
      events: streamedEvents,
      result: '已生成计划：2 个待办事项。',
    });
    assert.match(response.sessionId, /^mastra-plan-/u);
    assert.equal(disconnectCalls, 1);
  });

  it('returns the existing sidecar error shape when Mastra plan output is invalid', async () => {
    let disconnectCalls = 0;
    const runtime = new MastraRuntime({
      readModelConfig: () => ({
        apiKey: 'test-key',
        baseUrl: 'https://example.com/v1',
        model: 'deepseek-chat',
      }),
      createMcpClientBundle: async () => ({
        tools: [],
        disconnectAll: async () => {
          disconnectCalls += 1;
        },
      }),
      createAgent: () => ({
        stream: async () => ({
          fullStream: (async function* () { })(),
        }),
        generate: async () => ({
          object: {
            goal: 'bad plan',
            steps: [],
          },
        }),
      }),
    });

    const response = await runtime.plan({
      mode: 'plan',
      goal: 'bad plan',
      messages: [{ role: 'user', content: '给我一个计划' }],
      context: [],
    });

    assert.deepEqual(response.events, [{
      type: 'error',
      message: 'Mastra structured output 没有返回有效 AgentPlan，计划未生成。',
    }]);
    assert.equal(response.result, null);
    assert.equal(disconnectCalls, 1);
  });

  it('restores a persisted checkpoint through Mastra timeTravel and preserves rollback runtime events', async () => {
    let capturedRollbackOptions: unknown;
    let disconnectCalls = 0;
    const runtime = new MastraRuntime({
      now: () => '2026-05-03T01:00:00.000Z',
      readModelConfig: () => ({
        apiKey: 'test-key',
        baseUrl: 'https://example.com/v1',
        model: 'deepseek-chat',
      }),
      loadExecutionSnapshot: async () => ({
        status: 'success',
        requestContext: {
          systemPrompt: '恢复前的 system prompt',
          workspaceRootPath: 'D:/com.xiaojianc/my_desktop_app',
        },
      }),
      createMcpClientBundle: async () => ({
        tools: [],
        disconnectAll: async () => {
          disconnectCalls += 1;
        },
      }),
      createExecutionHandle: async () => ({
        agent: {
          stream: async () => ({
            runId: 'run-restore-1',
            cleanup: () => undefined,
            fullStream: (async function* () { })(),
          }),
          generate: async () => {
            throw new Error('generate should not be used in restore test');
          },
        },
        workflow: {
          id: 'durable-agentic-loop',
          createRun: async () => ({
            timeTravel: async (rollbackOptions) => {
              capturedRollbackOptions = rollbackOptions;
              return {
                output: {
                  text: '已恢复到最近 checkpoint。',
                },
              };
            },
          }),
        },
      }),
    });

    const response = await runtime.restoreCheckpoint({
      sessionId: 'rollback-session',
      runId: 'run-restore-1',
      snapshotId: 'run-restore-1',
    });

    const rollbackOptions = capturedRollbackOptions as {
      step?: unknown;
      requestContext?: unknown;
    };
    assert.deepEqual(rollbackOptions.step, ['durable-agentic-execution', 'durable-llm-execution']);
    assertMastraRequestContext(rollbackOptions.requestContext, {
      systemPrompt: '恢复前的 system prompt',
      workspaceRootPath: 'D:/com.xiaojianc/my_desktop_app',
    });
    assert.deepEqual(response.events, [
      {
        type: 'agent_event',
        event: {
          id: response.events[0] && response.events[0].type === 'agent_event' ? response.events[0].event.id : '',
          type: 'rollback.restore.started',
          runId: 'run-restore-1',
          sessionId: 'rollback-session',
          agentId: 'calamex-agent-sidecar',
          timestamp: '2026-05-03T01:00:00.000Z',
          seq: 0,
          schemaVersion: 1,
          redacted: true,
          visibility: 'user',
          level: 'info',
          snapshotId: 'run-restore-1',
        },
      },
      {
        type: 'agent_event',
        event: {
          id: response.events[1] && response.events[1].type === 'agent_event' ? response.events[1].event.id : '',
          type: 'rollback.restore.completed',
          runId: 'run-restore-1',
          sessionId: 'rollback-session',
          agentId: 'calamex-agent-sidecar',
          timestamp: '2026-05-03T01:00:00.000Z',
          seq: 1,
          schemaVersion: 1,
          redacted: true,
          visibility: 'user',
          level: 'info',
          snapshotId: 'run-restore-1',
          savedAsLatest: true,
          message: '已恢复到最近 checkpoint。',
        },
      },
      {
        type: 'done',
        result: '已恢复到最近 checkpoint。',
      },
    ]);
    assert.equal(response.result, '已恢复到最近 checkpoint。');
    assert.equal(disconnectCalls, 1);
  });
});

describe('Agent sidecar protocol golden tests', () => {
  it('streams deterministic NDJSON frames from the injected runtime without changing response aggregation', async () => {
    let capturedInput: unknown;
    const runtimeEvents = [
      {
        type: 'message_delta',
        text: 'hello',
      },
      {
        type: 'message_delta',
        text: 'hello world',
      },
      {
        type: 'done',
        result: 'hello world',
      },
    ] as const;
    const runtime = createFakeRuntime({
      chat: async (input, options) => {
        capturedInput = input;
        for (const event of runtimeEvents) {
          options?.onEvent?.(event);
        }

        return {
          sessionId: 'session-fixed',
          events: [...runtimeEvents],
          result: 'hello world',
        };
      },
    });
    const server = await startServer(runtime);

    try {
      const response = await fetch(`${server.baseUrl}/agent/chat/stream`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: null,
          mode: ' ',
          goal: ' ',
          messages: [{ role: 'user', content: 'hello world' }],
          workspaceRootPath: '',
          context: [],
        }),
      });

      assert.equal(response.status, 200);

      const frames = parseNdjsonFrames(await response.text());

      assert.deepEqual(frames, [
        { type: 'event', event: runtimeEvents[0] },
        { type: 'event', event: runtimeEvents[1] },
        { type: 'event', event: runtimeEvents[2] },
        {
          type: 'response',
          response: {
            sessionId: 'session-fixed',
            events: [...runtimeEvents],
            result: 'hello world',
          },
        },
      ]);
      assert.deepEqual(capturedInput, {
        mode: 'ask',
        goal: 'hello world',
        messages: [{ role: 'user', content: 'hello world' }],
        context: [],
      });
    } finally {
      await server.close();
    }
  });

  it('keeps streamed runtime errors inside the sidecar error frame', async () => {
    const runtime = createFakeRuntime({
      chat: async (_input, options) => {
        options?.onEvent?.({
          type: 'message_delta',
          text: 'partial',
        });

        throw new Error('runtime exploded');
      },
    });
    const server = await startServer(runtime);

    try {
      const response = await fetch(`${server.baseUrl}/agent/chat/stream`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'hello world' }],
          context: [],
        }),
      });

      assert.equal(response.status, 200);
      assert.deepEqual(parseNdjsonFrames(await response.text()), [
        {
          type: 'event',
          event: {
            type: 'message_delta',
            text: 'partial',
          },
        },
        {
          type: 'error',
          error: 'runtime exploded',
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it('reports injected runtime metadata on health without changing the protocol field', async () => {
    const server = await startServer(createFakeRuntime());

    try {
      const response = await fetch(`${server.baseUrl}/health`);

      assert.equal(response.status, 200);
      const payload = await response.json();

      assert.equal(payload.ok, true);
      assert.equal(payload.status, 'ready');
      assert.equal(payload.engine, 'fake-runtime');
      assert.equal(payload.version, 'test-version');
      assert.equal(payload.protocolVersion, '5');
      assert.equal(typeof payload.mcp?.configuredServers, 'number');
      assert.equal(Array.isArray(payload.mcp?.serverNames), true);
      assert.equal(Array.isArray(payload.mcp?.errors), true);
    } finally {
      await server.close();
    }
  });
});
