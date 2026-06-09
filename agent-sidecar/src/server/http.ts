import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  toAgentSidecarResponse,
  toAgentUiEvent,
  type IAgentRuntimeResponse,
  type IAgentRuntimeRunOptions,
  type TAgentRuntimeOutputEvent,
} from '../engines/contracts/runtime-contracts.js';
import type { IAgentRuntimeInput, TAgentMode } from '../engines/contracts/runtime-input.js';
import type { TAgentSidecarResponse } from '../schemas/events.js';
import { agentSidecarResponseSchema } from '../schemas/events.js';
import { logWarmupResult, warmupLlmConnection } from '../http/warmup.js';
import { baseAgentRequestSchema } from './request-schemas.js';

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const DEFAULT_RUNTIME_TIMEOUT_MS = 30 * 60 * 1000;

// -----------------------------------------------------------------------
// HTTP utilities
// -----------------------------------------------------------------------

class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const toHttpStatusCode = (error: unknown): number =>
  error instanceof HttpError ? error.statusCode : 400;

const writeErrorJson = (response: ServerResponse, error: unknown): void => {
  writeJson(response, toHttpStatusCode(error), {
    error: toErrorMessage(error),
  });
};

export const writeJson = (response: ServerResponse, statusCode: number, payload: unknown): void => {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
};

// 将空 / 空白令牌归一为 null，表示「未配置鉴权」。
export const normalizeSidecarToken = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

// 未配置令牌时不强制（兼容外部 / 自定义部署）；配置后要求
// Authorization: Bearer <token>，用恒时比较避免时序侧信道。
export const isAuthorizedSidecarRequest = (
  request: IncomingMessage,
  token: string | null,
): boolean => {
  if (!token) {
    return true;
  }
  const header = request.headers.authorization;
  if (typeof header !== 'string') {
    return false;
  }
  const expected = Buffer.from(`Bearer ${token}`, 'utf8');
  const actual = Buffer.from(header, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export const readBody = async (request: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const settleResolve = (value: unknown): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const settleReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_REQUEST_BYTES) {
        settleReject(new HttpError(413, '请求体超过 sidecar 限制。'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', settleReject);
    request.on('end', () => {
      if (settled) return;
      const rawBody = Buffer.concat(chunks).toString('utf8').trim();
      if (!rawBody) {
        settleResolve({});
        return;
      }
      try {
        settleResolve(JSON.parse(rawBody));
      } catch {
        settleReject(new Error('请求体不是合法 JSON。'));
      }
    });
  });

export const toAgentInput = (
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
  if (payload.threadId) {
    input.threadId = payload.threadId;
  }
  if (payload.modelConfig) {
    input.modelConfig = payload.modelConfig;
  }
  if (payload.planId) {
    input.planId = payload.planId;
  }
  if (payload.planVersion) {
    input.planVersion = payload.planVersion;
  }
  if (payload.planStepId) {
    input.planStepId = payload.planStepId;
  }
  return input;
};

export const createRuntimeRunOptions = (
  request: IncomingMessage,
  onEvent?: (event: TAgentRuntimeOutputEvent) => void,
): IAgentRuntimeRunOptions => {
  const controller = new AbortController();
  // Node 已废弃 IncomingMessage 的 'aborted' 事件；改用 'close' + !complete 等价判定：
  // 仅当请求在正常结束（complete=true）之前断开时才中止，行为与旧 'aborted' 一致。
  request.once('close', () => {
    if (!request.complete) {
      controller.abort();
    }
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

export const toValidatedSidecarResponse = (
  response: IAgentRuntimeResponse,
): TAgentSidecarResponse => {
  const payload = toAgentSidecarResponse(response);
  agentSidecarResponseSchema.parse(payload);
  return payload;
};

export const writeNdjsonFrame = (response: ServerResponse, payload: unknown): void => {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  response.write(`${JSON.stringify(payload)}\n`);
};

export const writeStreamHeaders = (response: ServerResponse): void => {
  response.socket?.setNoDelay(true);
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.flushHeaders();
};

export const handlePost = async (
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
    writeErrorJson(response, error);
  }
};

export const handleRuntimeResponse = async (
  request: IncomingMessage,
  response: ServerResponse,
  handler: (options: IAgentRuntimeRunOptions) => Promise<IAgentRuntimeResponse>,
): Promise<void> => {
  try {
    writeJson(
      response,
      200,
      toValidatedSidecarResponse(await handler(createRuntimeRunOptions(request))),
    );
  } catch (error) {
    writeErrorJson(response, error);
  }
};

export const handlePlainPost = async <TPayload>(
  request: IncomingMessage,
  response: ServerResponse,
  handler: (body: unknown) => Promise<TPayload>,
): Promise<void> => {
  try {
    const body = await readBody(request);
    writeJson(response, 200, await handler(body));
  } catch (error) {
    writeErrorJson(response, error);
  }
};

export const handleWarmupPost = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  try {
    const result = await warmupLlmConnection(await readBody(request));
    logWarmupResult('explicit', result);
    writeJson(response, 200, result);
  } catch (error) {
    writeErrorJson(response, error);
  }
};

export const handlePostStream = async (
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
    // 边界倒计时 shim：运行时已不再把错误当 UI 事件（改由 errorMessage 承载），
    // 这里在响应帧前补发一条遗留 `error` 事件帧，使未迁移前端的错误展示与旧行为
    // 逐字节等价；待前端迁移至 ACP（U4）后删除。
    if (payload.errorMessage) {
      writeNdjsonFrame(response, {
        type: 'event',
        event: { type: 'error', message: payload.errorMessage },
      });
    }
    writeNdjsonFrame(response, {
      type: 'response',
      response: toValidatedSidecarResponse(payload),
    });
    response.end();
  } catch (error) {
    if (!response.headersSent) {
      writeErrorJson(response, error);
      return;
    }
    writeNdjsonFrame(response, {
      type: 'error',
      error: toErrorMessage(error),
    });
    response.end();
  }
};
