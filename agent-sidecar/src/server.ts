import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  toAgentUiEvent,
  type IAgentRuntimeResponse,
  type IAgentRuntimeRunOptions,
} from './engines/contracts/runtime-contracts.js';
import { createConfiguredRuntime, type IAgentSidecarRuntime } from './engines/runtime.js';
import { getMcpRuntimeStatus } from './tools/mcp.js';
import {
  aiWebFetchInputSchema,
  aiWebFetchPayloadSchema,
  aiWebSearchInputSchema,
  aiWebSearchPayloadSchema,
} from './web/types.js';
import { disposeWebService, fetchWeb, searchWeb } from './web/service.js';
import { configureGlobalHttpTransport } from './http/transport.js';
import { scheduleBackgroundWarmup } from './http/warmup.js';
import {
  agentSidecarChatRequestSchema,
  agentSidecarExecuteRequestSchema,
  agentSidecarOrchestrateRequestSchema,
  agentSidecarOrchestrateResumeRequestSchema,
  agentSidecarPlanApproveRequestSchema,
  agentSidecarPlanFinishRequestSchema,
  agentSidecarPlanQueryRequestSchema,
  agentSidecarPlanRejectRequestSchema,
  agentSidecarPlanReplanRequestSchema,
  agentSidecarPlanRequestSchema,
  agentSidecarPlanValidateRequestSchema,
  agentSidecarRollbackRestoreRequestSchema,
  approvalResolutionSchema,
} from './server/request-schemas.js';
import {
  handlePlainPost,
  handlePost,
  handlePostStream,
  handleRuntimeResponse,
  handleWarmupPost,
  isAuthorizedSidecarRequest,
  normalizeSidecarToken,
  readBody,
  toAgentInput,
  writeJson,
  writeNdjsonFrame,
  writeStreamHeaders,
} from './server/http.js';
import {
  extractOrchestrationAgentEvent,
  isOrchestrationWorkflowDisabled,
  type TPlanOrchestrationRun,
} from './server/orchestration-events.js';

export {
  agentSidecarChatRequestSchema,
  agentSidecarExecuteRequestSchema,
  agentSidecarOrchestrateRequestSchema,
  agentSidecarOrchestrateResumeRequestSchema,
  agentSidecarPlanApproveRequestSchema,
  agentSidecarPlanFinishRequestSchema,
  agentSidecarPlanQueryRequestSchema,
  agentSidecarPlanRejectRequestSchema,
  agentSidecarPlanReplanRequestSchema,
  agentSidecarPlanRequestSchema,
  agentSidecarPlanValidateRequestSchema,
  agentSidecarRollbackRestoreRequestSchema,
  baseAgentRequestSchema,
} from './server/request-schemas.js';

configureGlobalHttpTransport();

const DEFAULT_PORT = 39871;
export const SIDECAR_PROTOCOL_VERSION = '7';
export const SIDECAR_IMPLEMENTATION_VERSION = 'deepseek-reasoning-transport-v6-plan-history';

// Phase 2b：内存中保留的「已挂起、等待审批 resume」编排 run 的最长存活时间。
// 超时未 resume 则回收，避免长负 sidecar 永久持有被放弃的 run。
const ORCHESTRATION_RUN_TTL_MS = 30 * 60 * 1000;

// -----------------------------------------------------------------------
// Server
// -----------------------------------------------------------------------

export const createAgentSidecarServer = (
  options: { runtime?: IAgentSidecarRuntime; authToken?: string | null } = {},
) => {
  const runtime = options.runtime ?? createConfiguredRuntime();
  const authToken = options.authToken !== undefined
    ? normalizeSidecarToken(options.authToken)
    : normalizeSidecarToken(process.env.AGENT_SIDECAR_TOKEN);

  // Phase 2b：挂起中的编排 run 注册表。sidecar 是长跑进程，同一进程内保留 run
  // 实例即可跨 HTTP 请求 resume；跨进程 / 回收后则由 Phase 3b 从 libsql 快照重建。
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

    // /health 保持免鉴权（宿主探活在注入令牌前也要可用）；其余路由需带有效令牌。
    const isHealthProbe = request.method === 'GET' && parsedUrl.pathname === '/health';
    if (!isHealthProbe && !isAuthorizedSidecarRequest(request, authToken)) {
      writeJson(response, 401, {
        error: 'sidecar 鉴权失败。',
      });
      return;
    }

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
      if (isOrchestrationWorkflowDisabled()) {
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

    if (request.method === 'POST' && url === '/agent/plan/orchestrate/stream') {
      // Phase 2c-1：原生编排 workflow 的流式入口。同样默认关闭。
      // 用 run.stream() 把 workflow 执行事件以 NDJSON 逐帧推给客户端，达到与旧
      // /stream 路径的功能对等；首帧先回 runId 便于挂起后 resume。
      if (isOrchestrationWorkflowDisabled()) {
        writeJson(response, 404, {
          error: '未知 sidecar 路由。',
        });
        return;
      }
      void (async () => {
        try {
          const payload = agentSidecarOrchestrateRequestSchema.parse(await readBody(request));
          if (typeof runtime.buildPlanOrchestrationWorkflow !== 'function') {
            throw new Error('当前 runtime 不支持原生编排 workflow。');
          }
          const workflow = runtime.buildPlanOrchestrationWorkflow(payload.modelConfig);
          const runId = randomUUID();
          const run = await workflow.createRun({ runId });
          rememberOrchestrationRun(runId, run);
          writeStreamHeaders(response);
          // 首帧：尽早把 runId 交给客户端（approval-gate 挂起后 resume 需要它）。
          writeNdjsonFrame(response, { type: 'meta', runId });
          // run.stream() 返回 async-iterable 的 WorkflowRunOutput；closeOnSuspend
          // 默认 true：approval-gate 挂起时流自动闭合，客户端据此转去调用 resume。
          const stream = run.stream({
            inputData: { goal: payload.goal, threadId: payload.threadId ?? null },
          });
          for await (const chunk of stream) {
            // 只把白名单内的内层 agent 事件解包成与 /stream 同构的帧；丢弃 Mastra 内部帧。
            const event = extractOrchestrationAgentEvent(chunk);
            if (event) {
              writeNdjsonFrame(response, { type: 'event', event: toAgentUiEvent(event) });
            }
          }
          // 流结束后读取权威终态：result 为 Promise，status 为当前运行状态。
          const result = await stream.result;
          if (stream.status !== 'suspended') {
            forgetOrchestrationRun(runId);
          }
          writeNdjsonFrame(response, {
            type: 'response',
            runId,
            status: stream.status,
            result,
          });
          response.end();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!response.headersSent) {
            writeJson(response, 400, { error: message });
            return;
          }
          writeNdjsonFrame(response, { type: 'error', error: message });
          response.end();
        }
      })();
      return;
    }

    if (request.method === 'POST' && url === '/agent/plan/orchestrate/resume') {
      // Phase 2b：恢复被挂起的编排 run（计划审批门 / 工具审批 / 逐步闸门通用）。同样默认关闭。
      if (isOrchestrationWorkflowDisabled()) {
        writeJson(response, 404, {
          error: '未知 sidecar 路由。',
        });
        return;
      }
      void handlePlainPost(request, response, async (body) => {
        const payload = agentSidecarOrchestrateResumeRequestSchema.parse(body);
        // Phase 3b：先查内存快路径；未命中（进程重启 / TTL 回收）时，借助 Phase 3a
        // 已落 libsql 的快照，用 createRun({ runId }) 重建同一 run 再 resume。
        let run = orchestrationRuns.get(payload.runId);
        if (!run) {
          if (typeof runtime.buildPlanOrchestrationWorkflow !== 'function') {
            throw new Error('当前 runtime 不支持原生编排 workflow。');
          }
          const workflow = runtime.buildPlanOrchestrationWorkflow(payload.modelConfig);
          // 同 runId 的 createRun 会从 storage 的 'workflows' 域 rehydrate 已挂起快照。
          run = await workflow.createRun({ runId: payload.runId });
        }
        // 省略 step：本 workflow 任意时刻只有一个挂起步骤（线性、无并行/foreach），
        // 运行时自动恢复当前挂起步；step 内部读 suspendData.reason 解释 decision。
        const result = await run.resume({
          resumeData: {
            decision: payload.decision,
            ...(payload.reason ? { reason: payload.reason } : {}),
          },
        });
        // 非 suspended 即终态，回收 run；仍 suspended（工具审批 / 下一个逐步闸门）时
        // 重新登记内存供下次 resume。
        if (result.status !== 'suspended') {
          forgetOrchestrationRun(payload.runId);
        } else {
          rememberOrchestrationRun(payload.runId, run);
        }
        return { runId: payload.runId, result };
      });
      return;
    }

    if (request.method === 'POST' && url === '/agent/plan/orchestrate/resume/stream') {
      // Phase 2c-2：编排挂起点的「流式」恢复入口。同样默认关闭。
      // 与非流式 /orchestrate/resume 等价，但用 run.resumeStream() 把恢复之后
      // （执行 → 验证 → 重规划 → finish，含逐步闸门）阶段的内层 agent 事件以 NDJSON 逐帧推给客户端，
      // 帧协议与 /orchestrate/stream 完全一致（meta → event* → response）。
      if (isOrchestrationWorkflowDisabled()) {
        writeJson(response, 404, {
          error: '未知 sidecar 路由。',
        });
        return;
      }
      void (async () => {
        try {
          const payload = agentSidecarOrchestrateResumeRequestSchema.parse(await readBody(request));
          // 先查内存快路径；未命中（进程重启 / TTL 回收）时用同 runId createRun 从快照重建。
          let run = orchestrationRuns.get(payload.runId);
          if (!run) {
            if (typeof runtime.buildPlanOrchestrationWorkflow !== 'function') {
              throw new Error('当前 runtime 不支持原生编排 workflow。');
            }
            const workflow = runtime.buildPlanOrchestrationWorkflow(payload.modelConfig);
            run = await workflow.createRun({ runId: payload.runId });
          }
          writeStreamHeaders(response);
          // 首帧：回 runId（链式工具审批 / 下一个逐步闸门再次挂起时，客户端用同一 runId 继续 resume）。
          writeNdjsonFrame(response, { type: 'meta', runId: payload.runId });
          // resumeStream() 与 stream() 同构：可 async-iterate，且带 result(Promise) 与 status。
          // 省略 step：本 workflow 任意时刻仅一个挂起步骤，运行时自动恢复当前挂起步。
          const stream = run.resumeStream({
            resumeData: {
              decision: payload.decision,
              ...(payload.reason ? { reason: payload.reason } : {}),
            },
          });
          for await (const chunk of stream) {
            const event = extractOrchestrationAgentEvent(chunk);
            if (event) {
              writeNdjsonFrame(response, { type: 'event', event: toAgentUiEvent(event) });
            }
          }
          const result = await stream.result;
          // 非 suspended 即终态，回收 run；若仍 suspended（链式审批 / 下一个逐步闸门），重新登记内存供下次 resume。
          if (stream.status !== 'suspended') {
            forgetOrchestrationRun(payload.runId);
          } else {
            rememberOrchestrationRun(payload.runId, run);
          }
          writeNdjsonFrame(response, {
            type: 'response',
            runId: payload.runId,
            status: stream.status,
            result,
          });
          response.end();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!response.headersSent) {
            writeJson(response, 400, { error: message });
            return;
          }
          writeNdjsonFrame(response, { type: 'error', error: message });
          response.end();
        }
      })();
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
