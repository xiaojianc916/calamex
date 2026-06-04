import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createAgentSidecarServer } from './server.js';
import type { IAgentSidecarRuntime } from './engines/runtime.js';

// 原生编排 workflow 的流式路由（/agent/plan/orchestrate/stream）单测。
// 仅验证 server 层职责：feature flag 门控 + NDJSON 帧协议（meta → event* → response）。
// workflow 执行本身用最小桩替身，不触达真实 Mastra runtime。

type TStreamChunk = Record<string, unknown>;

// 构造既可 async-iterate、又带 result(Promise) 与 status 的 run.stream() 替身，
// 结构对齐 server.ts 对 WorkflowRunOutput 的消费方式。
const makeRunStream = (events: TStreamChunk[], status: string, result: unknown) => ({
  async *[Symbol.asyncIterator]() {
    for (const event of events) {
      yield event;
    }
  },
  status,
  result: Promise.resolve(result),
});

const createOrchestrationStreamRuntime = (
  events: TStreamChunk[],
  status: string,
  result: unknown,
): IAgentSidecarRuntime =>
  ({
    name: 'mastra',
    version: 'orchestrate-stream-test',
    buildPlanOrchestrationWorkflow: () => ({
      createRun: async () => ({
        stream: () => makeRunStream(events, status, result),
      }),
    }),
  }) as unknown as IAgentSidecarRuntime;

const startServer = async (
  runtime: IAgentSidecarRuntime,
): Promise<{ baseUrl: string; close: () => Promise<void> }> => {
  const server = createAgentSidecarServer({ runtime, authToken: null });

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
    close: () =>
      new Promise<void>((resolve, reject) => {
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

const ORCHESTRATION_FLAG = 'AGENT_ORCHESTRATION_WORKFLOW';

describe('Agent sidecar orchestration stream route', () => {
  let previousFlag: string | undefined;

  beforeEach(() => {
    previousFlag = process.env[ORCHESTRATION_FLAG];
  });

  afterEach(() => {
    if (previousFlag === undefined) {
      delete process.env[ORCHESTRATION_FLAG];
    } else {
      process.env[ORCHESTRATION_FLAG] = previousFlag;
    }
  });

  it('returns 404 when the orchestration workflow flag is disabled', async () => {
    delete process.env[ORCHESTRATION_FLAG];
    // 门控关闭时必须在触达 runtime 之前短路：workflow 桩一旦被构建即抛错。
    const runtime = {
      name: 'mastra',
      version: 'orchestrate-stream-test',
      buildPlanOrchestrationWorkflow: () => {
        throw new Error('workflow should not be built when the flag is disabled');
      },
    } as unknown as IAgentSidecarRuntime;
    const server = await startServer(runtime);

    try {
      const response = await fetch(`${server.baseUrl}/agent/plan/orchestrate/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: 'do something' }),
      });

      assert.equal(response.status, 404);
    } finally {
      await server.close();
    }
  });

  it('streams meta, event, and final response frames when enabled', async () => {
    process.env[ORCHESTRATION_FLAG] = '1';
    const events: TStreamChunk[] = [
      { type: 'step', name: 'generate-plan' },
      { type: 'step', name: 'finish' },
    ];
    const runtime = createOrchestrationStreamRuntime(events, 'success', { ok: true });
    const server = await startServer(runtime);

    try {
      const response = await fetch(`${server.baseUrl}/agent/plan/orchestrate/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: 'do something' }),
      });

      assert.equal(response.status, 200);
      const contentType = response.headers.get('content-type');
      assert.ok(contentType !== null && contentType.includes('application/x-ndjson'));

      const body = await response.text();
      const frames = body
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as TStreamChunk);

      // 帧序列：meta（含 runId）→ 每个 workflow 事件一帧 event → 末帧 response（权威终态）。
      assert.equal(frames.length, events.length + 2);

      const metaFrame = frames.find((frame) => frame.type === 'meta');
      const eventFrames = frames.filter((frame) => frame.type === 'event');
      const responseFrame = frames.find((frame) => frame.type === 'response');

      assert.ok(metaFrame, 'expected a meta frame');
      assert.ok(responseFrame, 'expected a response frame');
      assert.equal(eventFrames.length, events.length);

      assert.ok(typeof metaFrame.runId === 'string' && metaFrame.runId.length > 0);

      assert.equal(responseFrame.status, 'success');
      assert.deepEqual(responseFrame.result, { ok: true });
      // 末帧 runId 与首帧一致，便于客户端在挂起后用同一 runId 调用 resume。
      assert.equal(responseFrame.runId, metaFrame.runId);
    } finally {
      await server.close();
    }
  });
});
