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
  createAgentSidecarServer,
} from './server.js';

const unsupportedRuntimeResponse = async (
  ..._args: Parameters<IAgentSidecarRuntime['chat']>
): Promise<Awaited<ReturnType<IAgentSidecarRuntime['chat']>>> => {
  throw new Error('Not implemented in test runtime.');
};

const unsupportedApprovalResolution = async (
  ..._args: Parameters<IAgentSidecarRuntime['resolveApproval']>
): Promise<Awaited<ReturnType<IAgentSidecarRuntime['resolveApproval']>>> => {
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
      createAgent: (config) => {
        capturedInstructions = config.instructions;
        capturedToolNames = Object.keys(config.tools ?? {});

        return {
          stream: async (messages, streamOptions) => {
            capturedMessages = messages;
            capturedStreamOptions = streamOptions;

            return {
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
    assert.deepEqual(capturedStreamOptions, {
      maxSteps: 10,
      toolChoice: 'auto',
    });
    assert.deepEqual(streamedEvents, [
      {
        type: 'tool_start',
        toolName: 'read_file',
        input: {
          path: 'README.md',
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
      createAgent: () => ({
        stream: async () => ({
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
      }),
    });

    const initial = await runtime.execute({
      mode: 'agent',
      goal: '请修改 README',
      messages: [{ role: 'user', content: '请修改 README' }],
      context: [],
    });

    assert.equal(initial.result, null);
    assert.equal(initial.events.length, 1);
    assert.equal(initial.events[0]?.type, 'approval_required');
    assert.equal(disconnectCalls, 0);

    if (initial.events[0]?.type !== 'approval_required') {
      throw new Error('expected approval_required event');
    }

    const approvalRequestId = initial.events[0].request.id;
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
