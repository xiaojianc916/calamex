import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import {
  toAgentSidecarResponse,
  toAgentUiEvent,
  type IAgentRuntimeResponse,
  type IAgentRuntimeRunOptions,
  type TAgentRuntimeOutputEvent,
} from './engines/runtime-contracts.js';
import type { IAgentRuntimeInput, TAgentMode } from './engines/runtime-input.js';
import { createConfiguredRuntime, type IAgentSidecarRuntime } from './engines/runtime.js';
import type { TAgentSidecarResponse } from './schemas/events.js';
import { agentSidecarResponseSchema } from './schemas/events.js';
import { getMcpRuntimeStatus } from './tools/mcp.js';

const DEFAULT_PORT = 39871;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const DEFAULT_RUNTIME_TIMEOUT_MS = 30 * 60 * 1000;
export const SIDECAR_PROTOCOL_VERSION = '5';

const agentModeSchema = z.enum(['ask', 'plan', 'agent', 'patch', 'review']);

const optionalNonEmptyStringSchema = z.preprocess((value) => {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === 'string' && value.trim().length === 0) {
    return undefined;
  }

  return value;
}, z.string().trim().min(1).optional()).optional();

const requiredNonEmptyStringSchema = z.string().trim().min(1);

const optionalAgentModeSchema = z.preprocess((value) => {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === 'string' && value.trim().length === 0) {
    return undefined;
  }

  return value;
}, agentModeSchema.optional()).optional();

const optionalWorkspaceRootPathSchema = z.preprocess((value) => {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length === 0) {
    return undefined;
  }

  return value;
}, z.string().trim().min(1).nullable().optional()).optional();

const agentMessageInputSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
});

const agentContextReferenceSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  label: z.string().min(1),
  path: z.string().nullable(),
  range: z.object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  }).nullable(),
  contentPreview: z.string(),
  redacted: z.boolean(),
});

export const baseAgentRequestSchema = z.object({
  sessionId: optionalNonEmptyStringSchema,
  mode: optionalAgentModeSchema,
  goal: optionalNonEmptyStringSchema,
  messages: z.array(agentMessageInputSchema).default([]),
  workspaceRootPath: optionalWorkspaceRootPathSchema,
  context: z.array(agentContextReferenceSchema).default([]),
});

export const agentSidecarChatRequestSchema = baseAgentRequestSchema;

export const agentSidecarPlanRequestSchema = baseAgentRequestSchema.extend({
  goal: requiredNonEmptyStringSchema,
});

export const agentSidecarExecuteRequestSchema = baseAgentRequestSchema.extend({
  goal: requiredNonEmptyStringSchema,
});

const approvalResolutionSchema = z.object({
  sessionId: optionalNonEmptyStringSchema,
  requestId: z.string().min(1),
  decision: z.string().min(1),
});

const writeJson = (response: ServerResponse, statusCode: number, payload: unknown): void => {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
};

const readBody = async (request: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    request.on('data', (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_REQUEST_BYTES) {
        reject(new Error('请求体超过 sidecar 限制。'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('error', reject);
    request.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8').trim();
      if (!rawBody) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(rawBody));
      } catch {
        reject(new Error('请求体不是合法 JSON。'));
      }
    });
  });

const toAgentInput = (
  payload: z.infer<typeof baseAgentRequestSchema>,
  mode: TAgentMode,
): IAgentRuntimeInput => {
  const lastUserMessage = [...payload.messages]
    .reverse()
    .find((message) => message.role === 'user');
  const input: IAgentRuntimeInput = {
    mode: payload.mode ?? mode,
    goal: payload.goal ?? lastUserMessage?.content ?? '继续当前任务',
    messages: payload.messages,
    context: payload.context,
  };

  if (payload.sessionId) {
    input.sessionId = payload.sessionId;
  }

  if (payload.workspaceRootPath) {
    input.workspaceRootPath = payload.workspaceRootPath;
  }

  return input;
};

const handlePost = async (
  request: IncomingMessage,
  response: ServerResponse,
  handler: (body: unknown, options: IAgentRuntimeRunOptions) => Promise<IAgentRuntimeResponse>,
): Promise<void> => {
  try {
    const body = await readBody(request);
    writeJson(
      response,
      200,
      toValidatedSidecarResponse(await handler(body, createRuntimeRunOptions(request))),
    );
  } catch (error) {
    writeJson(response, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const writeNdjsonFrame = (response: ServerResponse, payload: unknown): void => {
  if (response.writableEnded || response.destroyed) {
    return;
  }

  response.write(`${JSON.stringify(payload)}\n`);
};

const writeStreamHeaders = (response: ServerResponse): void => {
  response.socket?.setNoDelay(true);
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.flushHeaders();
};

const createRuntimeRunOptions = (
  request: IncomingMessage,
  onEvent?: (event: TAgentRuntimeOutputEvent) => void,
): IAgentRuntimeRunOptions => {
  const controller = new AbortController();

  request.once('aborted', () => {
    controller.abort();
  });

  return {
    context: {
      requestId: randomUUID(),
      signal: controller.signal,
      timeoutMs: DEFAULT_RUNTIME_TIMEOUT_MS,
    },
    ...(onEvent ? { onEvent } : {}),
  };
};

const toValidatedSidecarResponse = (
  response: IAgentRuntimeResponse,
): TAgentSidecarResponse => {
  const payload = toAgentSidecarResponse(response);
  agentSidecarResponseSchema.parse(payload);
  return payload;
};

const handlePostStream = async (
  request: IncomingMessage,
  response: ServerResponse,
  handler: (body: unknown, options: IAgentRuntimeRunOptions) => Promise<IAgentRuntimeResponse>,
): Promise<void> => {
  try {
    const body = await readBody(request);
    writeStreamHeaders(response);
    const payload = await handler(body, createRuntimeRunOptions(request, (event) => {
      writeNdjsonFrame(response, {
        type: 'event',
        event: toAgentUiEvent(event),
      });
    }));

    writeNdjsonFrame(response, {
      type: 'response',
      response: toValidatedSidecarResponse(payload),
    });
    response.end();
  } catch (error) {
    if (!response.headersSent) {
      writeJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    writeNdjsonFrame(response, {
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
    response.end();
  }
};

export const createAgentSidecarServer = (
  options: { runtime?: IAgentSidecarRuntime } = {},
) => {
  const runtime = options.runtime ?? createConfiguredRuntime();

  return createServer((request, response) => {
    const url = request.url ?? '/';

    if (request.method === 'GET' && url === '/health') {
      writeJson(response, 200, {
        ok: true,
        status: 'ready',
        engine: runtime.name,
        version: runtime.version ?? null,
        protocolVersion: SIDECAR_PROTOCOL_VERSION,
        mcp: getMcpRuntimeStatus(),
      });
      return;
    }

    if (request.method === 'POST' && url === '/agent/chat') {
      void handlePost(request, response, async (body, options) => {
        const payload = agentSidecarChatRequestSchema.parse(body);
        return runtime.chat(toAgentInput(payload, 'ask'), options);
      });
      return;
    }

    if (request.method === 'POST' && url === '/agent/chat/stream') {
      void handlePostStream(request, response, async (body, options) => {
        const payload = agentSidecarChatRequestSchema.parse(body);
        return runtime.chat(toAgentInput(payload, 'ask'), options);
      });
      return;
    }

    if (request.method === 'POST' && url === '/agent/plan') {
      void handlePost(request, response, async (body, options) => {
        const payload = agentSidecarPlanRequestSchema.parse(body);
        return runtime.plan(toAgentInput(payload, 'plan'), options);
      });
      return;
    }

    if (request.method === 'POST' && url === '/agent/plan/stream') {
      void handlePostStream(request, response, async (body, options) => {
        const payload = agentSidecarPlanRequestSchema.parse(body);
        return runtime.plan(toAgentInput(payload, 'plan'), options);
      });
      return;
    }

    if (request.method === 'POST' && url === '/agent/execute') {
      void handlePost(request, response, async (body, options) => {
        const payload = agentSidecarExecuteRequestSchema.parse(body);
        return runtime.execute(toAgentInput(payload, 'agent'), options);
      });
      return;
    }

    if (request.method === 'POST' && url === '/agent/execute/stream') {
      void handlePostStream(request, response, async (body, options) => {
        const payload = agentSidecarExecuteRequestSchema.parse(body);
        return runtime.execute(toAgentInput(payload, 'agent'), options);
      });
      return;
    }

    if (request.method === 'POST' && url === '/approval/resolve') {
      void handlePost(request, response, async (body, options) => {
        const payload = approvalResolutionSchema.parse(body);
        return runtime.resolveApproval(payload, options);
      });
      return;
    }

    if (request.method === 'POST' && url === '/approval/resolve/stream') {
      void handlePostStream(request, response, async (body, options) => {
        const payload = approvalResolutionSchema.parse(body);
        return runtime.resolveApproval(payload, options);
      });
      return;
    }

    writeJson(response, 404, {
      error: '未知 sidecar 路由。',
    });
  });
};

const resolvePort = (): number => {
  const rawPort = process.env.AGENT_SIDECAR_PORT?.trim();
  if (!rawPort) {
    return DEFAULT_PORT;
  }

  const parsed = Number(rawPort);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : DEFAULT_PORT;
};

const isEntrypoint = (): boolean => {
  const entrypoint = process.argv[1];
  return entrypoint ? resolve(fileURLToPath(import.meta.url)) === resolve(entrypoint) : false;
};

if (isEntrypoint()) {
  const port = resolvePort();
  createAgentSidecarServer().listen(port, '127.0.0.1', () => {
    console.info(`agent sidecar listening on http://127.0.0.1:${port}`);
  });
}
