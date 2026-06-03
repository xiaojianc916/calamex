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
} from './engines/contracts/runtime-contracts.js';
import type { IAgentRuntimeInput, TAgentMode } from './engines/contracts/runtime-input.js';
import { createConfiguredRuntime, type IAgentSidecarRuntime } from './engines/runtime.js';
import type { TPlanOrchestrationWorkflow } from './engines/plan/orchestration-workflow.js';
import type { TAgentSidecarResponse } from './schemas/events.js';
import { agentSidecarResponseSchema } from './schemas/events.js';
import { getMcpRuntimeStatus } from './tools/mcp.js';
import {
  aiWebFetchInputSchema,
  aiWebFetchPayloadSchema,
  aiWebSearchInputSchema,
  aiWebSearchPayloadSchema,
} from './web/types.js';
import { disposeWebService, fetchWeb, searchWeb } from './web/service.js';
import { configureGlobalHttpTransport } from './http/transport.js';
import {
  logWarmupResult,
  scheduleBackgroundWarmup,
  warmupLlmConnection,
} from './http/warmup.js';

configureGlobalHttpTransport();

const DEFAULT_PORT = 39871;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const DEFAULT_RUNTIME_TIMEOUT_MS = 30 * 60 * 1000;
export const SIDECAR_PROTOCOL_VERSION = '7';
export const SIDECAR_IMPLEMENTATION_VERSION = 'deepseek-reasoning-transport-v6-plan-history';

// Phase 2b：内存中保留的「已挂起、等待审批 resume」编排 run 的最长存活时间。
// 超时未 resume 则回收，避免长跑 sidecar 永久持有被放弃的 run。
const ORCHESTRATION_RUN_TTL_MS = 30 * 60 * 1000;

// committed orchestration workflow 的 run 实例类型（createRun 可能同步或异步返回，统一 Awaited）。
type TPlanOrchestrationRun = Awaited<ReturnType<TPlanOrchestrationWorkflow['createRun']>>;

// -----------------------------------------------------------------------
// 基础 schema 工具
// -----------------------------------------------------------------------

const agentModeSchema = z.enum(['ask', 'plan', 'agent', 'patch', 'review']);

const approvalDecisionSchema = z.enum(['approve', 'reject', 'cancel', 'modify']);

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

const requestScopedModelConfigSchema = z.object({
  modelId: requiredNonEmptyStringSchema,
  apiKey: requiredNonEmptyStringSchema,
  baseUrl: optionalNonEmptyStringSchema,
});

// -----------------------------------------------------------------------
// Request schemas
// -----------------------------------------------------------------------

export const baseAgentRequestSchema = z.object({
  sessionId: optionalNonEmptyStringSchema,
  mode: optionalAgentModeSchema,
  goal: optionalNonEmptyStringSchema,
  messages: z.array(agentMessageInputSchema).default([]),
  workspaceRootPath: optionalWorkspaceRootPathSchema,
  context: z.array(agentContextReferenceSchema).default([]),
  modelConfig: requestScopedModelConfigSchema.optional(),
  threadId: optionalNonEmptyStringSchema,
  planId: optionalNonEmptyStringSchema,
  planVersion: z.number().int().positive().optional(),
  planStepId: optionalNonEmptyStringSchema,
});

export const agentSidecarChatRequestSchema = baseAgentRequestSchema;

export const agentSidecarPlanRequestSchema = baseAgentRequestSchema.extend({
  goal: requiredNonEmptyStringSchema,
});

export const agentSidecarExecuteRequestSchema = baseAgentRequestSchema.extend({
  goal: requiredNonEmptyStringSchema,
  planId: requiredNonEmptyStringSchema,
  planVersion: z.number().int().positive(),
  planStepId: requiredNonEmptyStringSchema,
});

export const agentSidecarPlanValidateRequestSchema = baseAgentRequestSchema.extend({
  planId: requiredNonEmptyStringSchema,
  planVersion: z.number().int().positive(),
});

export const agentSidecarPlanReplanRequestSchema = baseAgentRequestSchema.extend({
  goal: requiredNonEmptyStringSchema,
  planId: requiredNonEmptyStringSchema,
  planVersion: z.number().int().positive(),
});

const planVersionRequestSchema = z.object({
  sessionId: optionalNonEmptyStringSchema,
  planId: requiredNonEmptyStringSchema,
  version: z.number().int().positive(),
});

export const agentSidecarPlanApproveRequestSchema = planVersionRequestSchema;

export const agentSidecarPlanRejectRequestSchema = planVersionRequestSchema.extend({
  reason: optionalNonEmptyStringSchema,
});

export const agentSidecarPlanFinishRequestSchema = planVersionRequestSchema.extend({
  status: z.enum(['completed', 'failed']),
  errorMessage: optionalNonEmptyStringSchema,
});

export const agentSidecarPlanQueryRequestSchema = z.object({
  sessionId: optionalNonEmptyStringSchema,
  planId: requiredNonEmptyStringSchema,
  version: z.number().int().positive().optional(),
});

const approvalResolutionSchema = baseAgentRequestSchema.extend({
  sessionId: optionalNonEmptyStringSchema,
  requestId: z.string().min(1),
  decision: approvalDecisionSchema,
});

/**
 * 把单字符串归一为单元素数组；输出永远是 `string[]`，
 * 结构上兼容 `TRollbackStepPath = readonly string[]`。
 */
const rollbackStepSchema = z.preprocess(
  (value) => (typeof value === 'string' ? [value] : value),
  z.array(requiredNonEmptyStringSchema).min(1),
);

export const agentSidecarRollbackRestoreRequestSchema = z.object({
  sessionId: optionalNonEmptyStringSchema,
  runId: requiredNonEmptyStringSchema,
  snapshotId: optionalNonEmptyStringSchema,
  step: rollbackStepSchema.optional(),
  modelConfig: requestScopedModelConfigSchema.optional(),
});

// Phase 2：原生编排 workflow 入口（默认关闭，AGENT_ORCHESTRATION_WORKFLOW=1 才启用）。
export const agentSidecarOrchestrateRequestSchema = z.object({
  goal: requiredNonEmptyStringSchema,
  threadId: optionalNonEmptyStringSchema,
  modelConfig: requestScopedModelConfigSchema.optional(),
});

// Phase 2b：恢复一个被计划审批门挂起的编排 run（需携带 start 返回的 runId）。
export const agentSidecarOrchestrateResumeRequestSchema = z.object({
  runId: requiredNonEmptyStringSchema,
  decision: z.enum(['approve', 'reject']),
  reason: optionalNonEmptyStringSchema,
});

// -----------------------------------------------------------------------
// HTTP utilities
// -----------------------------------------------------------------------

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

const handleRuntimeResponse = async (
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
    writeJson(response, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const handlePlainPost = async <TPayload>(
  request: IncomingMessage,
  response: ServerResponse,
  handler: (body: unknown) => Promise<TPayload>,
): Promise<void> => {
  try {
    const body = await readBody(request);
    writeJson(response, 200, await handler(body));
  } catch (error) {
    writeJson(response, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const handleWarmupPost = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  try {
    const result = await warmupLlmConnection(await readBody(request));
    logWarmupResult('explicit', result);
    writeJson(response, 200, result);
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

// -----------------------------------------------------------------------
// Server
// -----------------------------------------------------------------------

export const createAgentSidecarServer = (
  options: { runtime?: IAgentSidecarRuntime } = {},
) => {
  const runtime = options.runtime ?? createConfiguredRuntime();

  // Phase 2b：挂起中的编排 run 注册表。sidecar 是长跑进程，同一进程内保留 run
  // 实例即可跨 HTTP 请求 resume，无需依赖 storage 跨进程重建（对齐 pendingApprovals 模式）。
  const orchestrationRuns = new Map<string, TPlanOrchestrationRun>();
  const orchestrationRunTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const forgetOrchestrationRun = (runId: string): void => {
    orchestrationRuns.delete(runId);
    const timer = orchestrationRunTimers.get(runId);
    if (timer) {
      clearTimeout(timer);
      orchestrationRunTimers.delete(runId);
    }
  };

  const rememberOrchestrationRun = (runId: string, run: TPlanOrchestrationRun): void => {
    orchestrationRuns.set(runId, run);
    const existing = orchestrationRunTimers.get(runId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => forgetOrchestrationRun(runId), ORCHESTRATION_RUN_TTL_MS);
    // 不让悬挂的回收计时器阻止进程退出。
    timer.unref?.();
    orchestrationRunTimers.set(runId, timer);
  };

  // /agent/chat, /agent/chat/stream, /model/chat and /model/chat/stream all
  // share this exact handler; the streaming vs non-streaming difference is
  // handled by the surrounding handlePost / handlePostStream wrapper.
  const runChat = (
    body: unknown,
    options: IAgentRuntimeRunOptions,
  ): Promise<IAgentRuntimeResponse> => {
    const payload = agentSidecarChatRequestSchema.parse(body);
    scheduleBackgroundWarmup(payload, 'request');
    return runtime.chat(toAgentInput(payload, 'ask'), options);
  };

  return createServer((request, response) => {
    const url = request.url ?? '/';
    const parsedUrl = new URL(url, 'http://127.0.0.1');

    if (request.method === 'GET' && parsedUrl.pathname === '/health') {
      writeJson(response, 200, {
        ok: true,
        status: 'ready',
        engine: runtime.name,
        version: runtime.version ?? null,
        protocolVersion: SIDECAR_PROTOCOL_VERSION,
        implementationVersion: SIDECAR_IMPLEMENTATION_VERSION,
        mcp: getMcpRuntimeStatus(),
      });
      return;
    }

    if (request.method === 'GET' && parsedUrl.pathname.startsWith('/agent/plan/')) {
      const planId = decodeURIComponent(parsedUrl.pathname.slice('/agent/plan/'.length));
      const rawVersion = parsedUrl.searchParams.get('version');
      const version = rawVersion ? Number(rawVersion) : undefined;
      const payload = agentSidecarPlanQueryRequestSchema.safeParse({
        planId,
        ...(version !== undefined ? { version } : {}),
      });
      if (!payload.success) {
        writeJson(response, 400, {
          error: '计划查询参数无效。',
        });
        return;
      }
      void handleRuntimeResponse(request, response, async (options) =>
        runtime.getPlan(payload.data, options)
      );
      return;
    }

    if (request.method === 'POST' && (url === '/agent/chat' || url === '/model/chat')) {
      void handlePost(request, response, runChat);
      return;
    }

    if (request.method === 'POST' && (url === '/agent/chat/stream' || url === '/model/chat/stream')) {
      void handlePostStream(request, response, runChat);
      return;
    }

    if (request.method === 'POST' && url === '/agent/warmup') {
      void handleWarmupPost(request, response);
      return;
    }

    if (request.method === 'POST' && url === '/agent/plan') {
      void handlePost(request, response, async (body, options) => {
        const payload = agentSidecarPlanRequestSchema.parse(body);
        scheduleBackgroundWarmup(payload, 'request');
        return runtime.plan(toAgentInput(payload, 'plan'), options);
      });
      return;
    }

    if (request.method === 'POST' && url === '/agent/plan/stream') {
      void handlePostStream(request, response, async (body, options) => {
        const payload = agentSidecarPlanRequestSchema.parse(body);
        scheduleBackgroundWarmup(payload, 'request');
        return runtime.plan(toAgentInput(payload, 'plan'), options);
      });
      return;
    }

    if (request.method === 'POST' && url === '/agent/plan/approve') {
      void handlePost(request, response, async (body, options) => {
        const payload = agentSidecarPlanApproveRequestSchema.parse(body);
        return runtime.approvePlan(payload, options);
      });
      return;
    }

    if (request.method === 'POST' && url === '/agent/plan/reject') {
      void handlePost(request, response, async (body, options) => {
        const payload = agentSidecarPlanRejectRequestSchema.parse(body);
        return runtime.rejectPlan(payload, options);
      });
      return;
    }

    if (request.method === 'POST' && url === '/agent/plan/finish') {
      void handlePost(request, response, async (body, options) => {
        const payload = agentSidecarPlanFinishRequestSchema.parse(body);
        return runtime.finishPlan(payload, options);
      });
      return;
    }

    if (request.method === 'POST' && url === '/agent/plan/query') {
      void handlePost(request, response, async (body, options) => {
        const payload = agentSidecarPlanQueryRequestSchema.parse(body);
        return runtime.getPlan(payload, options);
      });
      return;
    }

    if (request.method === 'POST' && url === '/agent/plan/validate') {
      void handlePost(request, response, async (body, options) => {
        const payload = agentSidecarPlanValidateRequestSchema.parse(body);
        scheduleBackgroundWarmup(payload, 'request');
        return runtime.validatePlan(toAgentInput(payload, 'agent'), options);
      });
      return;
    }

    if (request.method === 'POST' && url === '/agent/plan/replan') {
      void handlePost(request, response, async (body, options) => {
        const payload = agentSidecarPlanReplanRequestSchema.parse(body);
        scheduleBackgroundWarmup(payload, 'request');
        return runtime.replanPlan(toAgentInput(payload, 'plan'), options);
      });
      return;
    }

    if (request.method === 'POST' && url === '/agent/execute') {
      void handlePost(request, response, async (body, options) => {
        const payload = agentSidecarExecuteRequestSchema.parse(body);
        scheduleBackgroundWarmup(payload, 'request');
        return runtime.execute(toAgentInput(payload, 'agent'), options);
      });
      return;
    }

    if (request.method === 'POST' && url === '/agent/execute/stream') {
      void handlePostStream(request, response, async (body, options) => {
        const payload = agentSidecarExecuteRequestSchema.parse(body);
        scheduleBackgroundWarmup(payload, 'request');
        return runtime.execute(toAgentInput(payload, 'agent'), options);
      });
      return;
    }

    if (request.method === 'POST' && url === '/approval/resolve') {
      void handlePost(request, response, async (body, options) => {
        const payload = approvalResolutionSchema.parse(body);
        scheduleBackgroundWarmup(payload, 'request');
        return runtime.resolveApproval(payload, options);
      });
      return;
    }

    if (request.method === 'POST' && url === '/approval/resolve/stream') {
      void handlePostStream(request, response, async (body, options) => {
        const payload = approvalResolutionSchema.parse(body);
        scheduleBackgroundWarmup(payload, 'request');
        return runtime.resolveApproval(payload, options);
      });
      return;
    }

    if (request.method === 'POST' && url === '/web/search') {
      void handlePlainPost(request, response, async (body) =>
        aiWebSearchPayloadSchema.parse(
          await searchWeb(aiWebSearchInputSchema.parse(body)),
        )
      );
      return;
    }

    if (request.method === 'POST' && url === '/web/fetch') {
      void handlePlainPost(request, response, async (body) =>
        aiWebFetchPayloadSchema.parse(
          await fetchWeb(aiWebFetchInputSchema.parse(body)),
        )
      );
      return;
    }

    if (request.method === 'POST' && url === '/rollback/restore') {
      void handlePost(request, response, async (body, options) => {
        const payload = agentSidecarRollbackRestoreRequestSchema.parse(body);
        scheduleBackgroundWarmup(payload, 'request');
        return runtime.restoreCheckpoint(payload, options);
      });
      return;
    }

    if (request.method === 'POST' && url === '/rollback/restore/stream') {
      void handlePostStream(request, response, async (body, options) => {
        const payload = agentSidecarRollbackRestoreRequestSchema.parse(body);
        scheduleBackgroundWarmup(payload, 'request');
        return runtime.restoreCheckpoint(payload, options);
      });
      return;
    }

    if (request.method === 'POST' && url === '/agent/plan/orchestrate') {
      // Phase 2：原生编排 workflow 新路径。默认关闭；未开启时与未知路由一致（旧行为完全不变）。
      if (process.env.AGENT_ORCHESTRATION_WORKFLOW !== '1') {
        writeJson(response, 404, {
          error: '未知 sidecar 路由。',
        });
        return;
      }
      void handlePlainPost(request, response, async (body) => {
        const payload = agentSidecarOrchestrateRequestSchema.parse(body);
        if (typeof runtime.buildPlanOrchestrationWorkflow !== 'function') {
          throw new Error('当前 runtime 不支持原生编排 workflow。');
        }
        const workflow = runtime.buildPlanOrchestrationWorkflow(payload.modelConfig);
        // 自发 runId，避免依赖 run.runId 的实现细节（createRun({ runId }) 与 rollback 路径一致）。
        const runId = randomUUID();
        const run = await workflow.createRun({ runId });
        rememberOrchestrationRun(runId, run);
        // 首切片：跑到审批门 suspend 或终态。suspended 时保留 run 供后续 resume。
        const result = await run.start({
          inputData: { goal: payload.goal, threadId: payload.threadId ?? null },
        });
        if (result.status !== 'suspended') {
          forgetOrchestrationRun(runId);
        }
        return { runId, result };
      });
      return;
    }

    if (request.method === 'POST' && url === '/agent/plan/orchestrate/resume') {
      // Phase 2b：恢复被计划审批门挂起的编排 run。同样默认关闭。
      if (process.env.AGENT_ORCHESTRATION_WORKFLOW !== '1') {
        writeJson(response, 404, {
          error: '未知 sidecar 路由。',
        });
        return;
      }
      void handlePlainPost(request, response, async (body) => {
        const payload = agentSidecarOrchestrateResumeRequestSchema.parse(body);
        const run = orchestrationRuns.get(payload.runId);
        if (!run) {
          throw new Error('未找到对应的编排 run（可能已完成、已被拒绝或已超时回收）。');
        }
        // approval-gate 步骤的 resumeSchema = { decision, reason? }。
        const result = await run.resume({
          step: 'approval-gate',
          resumeData: {
            decision: payload.decision,
            ...(payload.reason ? { reason: payload.reason } : {}),
          },
        });
        // 理论上本 workflow 只在 approval-gate 挂起一次；非 suspended 即终态，回收 run。
        if (result.status !== 'suspended') {
          forgetOrchestrationRun(payload.runId);
        }
        return { runId: payload.runId, result };
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

const logProcessEvent = (event: string, error: unknown): void => {
  console.error(JSON.stringify({
    level: 'error',
    scope: 'agent-sidecar',
    event,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }));
};

if (isEntrypoint()) {
  const port = resolvePort();
  const runtime = createConfiguredRuntime();
  const server = createAgentSidecarServer({ runtime });

  let shuttingDown = false;
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      server.close();
    } catch {
      // 忽略关闭 HTTP server 时的异常。
    }
    try {
      await runtime.dispose?.();
    } catch {
      // 资源释放尽力而为，忽略清理期间的异常。
    }
    try {
      // web 搜索使用独立的共享 tavily MCP bundle，关闭时一并断开，避免遗留子进程。
      await disposeWebService();
    } catch {
      // 同样尽力而为，忽略清理期间的异常。
    }
    process.exit(code);
  };

  // 顶层兜底：长跑 sidecar 不能因为一次未处理的 rejection / 异常而静默退出。
  // 错误写入 stderr（由宿主重定向进 agent-sidecar.log，便于崩溃后回读）。
  process.on('unhandledRejection', (reason) => {
    logProcessEvent('process.unhandledRejection', reason);
  });
  process.on('uncaughtException', (error) => {
    logProcessEvent('process.uncaughtException', error);
    // 未捕获异常后进程状态不可信，尽力优雅退出。
    void shutdown(1);
  });

  // listen 失败（例如端口被并发抢占的 EADDRINUSE）必须兜住，否则无人处理的
  // 'error' 事件会直接让进程崩溃，且日志里看不到原因。
  server.on('error', (error) => {
    const err = error as NodeJS.ErrnoException;
    logProcessEvent('server.error', err);
    if (err.code === 'EADDRINUSE') {
      console.error(`agent sidecar 端口 ${port} 已被占用，进程退出。`);
    }
    void shutdown(1);
  });

  // 收到终止信号时优雅关闭，断开 MCP 子进程，避免孤儿进程堆积。
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void shutdown(0);
    });
  }

  server.listen(port, '127.0.0.1', () => {
    console.info(`agent sidecar listening on http://127.0.0.1:${port}`);
  });
}
