import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import { AgentResult, Message, ReasoningBlock, TextBlock } from '@strands-agents/sdk';

import {
  agentSidecarChatRequestSchema,
  agentSidecarExecuteRequestSchema,
  agentSidecarPlanRequestSchema,
  createAgentSidecarServer,
} from './server.js';
import type { IAgentSidecarRuntime } from './server.js';
import { buildSystemPrompt, extractVisibleAgentResultText } from './engines/strands-engine.js';

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
    const result = new AgentResult({
      stopReason: 'endTurn',
      lastMessage: new Message({
        role: 'assistant',
        content: [
          new ReasoningBlock({
            text: '内部推理，不应该进入用户可见回答。',
          }),
          new TextBlock('这是用户应该看到的回答。'),
        ],
      }),
      invocationState: {},
    });

    const visibleText = extractVisibleAgentResultText(result);

    assert.equal(visibleText, '这是用户应该看到的回答。');
    assert.doesNotMatch(visibleText, /Reasoning|内部推理/u);
  });

  it('preserves fenced code formatting when visible text is split across multiple text blocks', () => {
    const result = new AgentResult({
      stopReason: 'endTurn',
      lastMessage: new Message({
        role: 'assistant',
        content: [
          new TextBlock('不过我可以帮你把它的内容清空（已经是空的），或者建议你手动执行：\n\n```bash\n'),
          new TextBlock('Remove-Item .\\666.sh\n```\n'),
        ],
      }),
      invocationState: {},
    });

    const visibleText = extractVisibleAgentResultText(result);

    assert.equal(
      visibleText,
      '不过我可以帮你把它的内容清空（已经是空的），或者建议你手动执行：\n\n```bash\nRemove-Item .\\666.sh\n```',
    );
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
