import { createMastraModelConfigFromEnv } from '../../models/config.js';
import type { IMastraResolvedModelConfig } from '../../models/config.js';
import { createMastraLoggerRef } from '../../tools/log/index.js';
import type { IMastraLogToolsRef } from '../../tools/log/index.js';
import { createMcpGatewayWarmPool } from '../../tools/mcp/index.js';
import type { McpGatewayWarmPool } from '../../tools/mcp/index.js';
import { createMastraMcpClientBundle } from '../../tools/mcp/client.js';
import type { TMcpServerName } from '../../tools/mcp/client.js';
import { buildSystemPrompt } from '../prompts/system-prompt.js';
import { createMastraMemoryReference, createMastraMemoryScope } from '../context/memory.js';
import { createMastraMemoryForModel, createMastraModelConfig, defaultCreateAgent, defaultCreateExecutionHandle, defaultCreateResumableAgentHandle, defaultCreateStorage, resolveMastraModelConfig } from '../agent/factory.js';
import { decodeApprovalRequestId, encodeApprovalRequestId, extractApprovalToolPath, getChunkRunId } from '../approval/utils.js';
import { normalizeMastraError } from '../shared/errors.js';
import { createApprovalRequest, createApprovedPlanExecutionContext, deriveApprovalRisk } from '../responses/responses.js';
import { aggregateDoneTokenSnapshot, createOmMemoryCompressedEventDraft, createSandboxToolProgressPreview, extractFinishTokenSnapshot, getReasoningDelta, getTextDelta, isErrorChunk, isSandboxDataChunk, isTextDeltaChunk, isToolCallChunk, isToolCallSuspendedChunk, isToolErrorChunk, isToolResultChunk } from '../stream/stream-utils.js';
import { loadMastraMcpTools } from '../../tools/index.js';
import { askUserRequestSchema } from '../../schemas/events.js';
import { DEFAULT_EXECUTION_AGENT_ID, DEFAULT_EXECUTION_AGENT_NAME } from '../shared/types.js';
import type { IMastraAgentConfig, IMastraAgentLike, IMastraAgentStreamLike, IMastraApprovalExecutionContext, IMastraExecutionHandle, IMastraMcpBundle, IMastraPendingApproval, IMastraResumableAgentHandle, IMastraRuntimeDeps, IMastraStorageLike, IMastraTextStreamSummary, IMastraWorkflowSnapshotLike, IPlanWorkflowStepTracker, TDoneTokenSnapshot, TMastraStreamChunk, TMastraToolCallApprovalChunk, TMastraToolCallSuspendedChunk, TRuntimeEventFactory } from '../shared/types.js';
import { createRuntimeEventFactory, createRuntimePreview, createWorkspaceRuntimeInputPreview, createWorkspaceRuntimeResultPreview, isNodeTestProcess, pushUiEvent, toJsonValue } from '../shared/utils.js';
import { createMastraAgentInputProcessors, createMastraAgentOutputProcessors, destroyMastraBrowser, destroyMastraWorkspace } from '../workspace/workspace.js';
import { createAgentPlanStore } from '../plan/plan-store.js';
import type { IAgentPlanStore, TAgentPlanRecord } from '../plan/plan-store.js';
import { createAgentPlanWorkflowStore } from '../plan/plan-workflow-store.js';
import type { IAgentPlanWorkflowStore } from '../plan/plan-workflow-store.js';
import type { IAgentRuntimeResponse, IAgentRuntimeRunOptions, TAgentRuntimeOutputEvent } from '../contracts/runtime-contracts.js';
import type { IAgentRuntimeInput, IApprovalResolutionInput } from '../contracts/runtime-input.js';
import { SIDECAR_VERSION } from './runtime.js';
import type { MastraBrowser } from '@mastra/core/browser';
import { WORKSPACE_TOOLS } from '@mastra/core/workspace';
import type { AnyWorkspace } from '@mastra/core/workspace';

/**
 * 放弃的审批（用户从不 resolve）在内存中保留的最长时间。超时后释放其持有的
 * MCP bundle / workspace / browser，避免长跑 sidecar 永久泄漏重型资源。
 */
const PENDING_APPROVAL_TTL_MS = 10 * 60_000;

/**
 * 启动时仅预热的本地 MCP 服务（无网络、无密钥依赖）。用于缩短冷启动，避免在
 * 启动阶段串行启动全部 MCP 服务（含需 npx 联网下载的 probe）后又被暖池
 * maxWarm 立刻淘汰造成的反复 spawn/evict 抖动。其余服务保持按需懒加载。
 */
const STARTUP_PRIME_SERVER_NAMES: readonly TMcpServerName[] = ['memory', 'sequential-thinking'];

/**
 * ask_user 工具的 id（与 engines/tools/ask-user.ts 的 createTool id 对齐——该工具
 * 模块是其名称的权威来源；此处仅为在挂起分支识别反向提问工具而镜像一份常量，
 * 避免为去重单一字符串而重写含正则的工具文件，重命名时两处需同步）。
 */
const ASK_USER_TOOL_NAME = 'ask_user' as const;

export class MastraRuntimeBase {
    readonly name = 'mastra' as const;
    readonly version: string = SIDECAR_VERSION;
    protected readonly createAgent: (config: IMastraAgentConfig) => IMastraAgentLike;

    protected readonly createResumableAgentHandle: (config: IMastraAgentConfig) => Promise<IMastraResumableAgentHandle>;

    protected readonly createExecutionHandle: (config: IMastraAgentConfig) => Promise<IMastraExecutionHandle>;

    protected readonly shouldUseRegisteredAgentForTools: boolean;

    protected readonly loadExecutionSnapshot: (
        workflowName: string,
        runId: string,
    ) => Promise<IMastraWorkflowSnapshotLike | null>;

    protected readonly readModelConfig: () => IMastraResolvedModelConfig | null;

    protected readonly createMcpClientBundle: (
        options?: { workspaceRootPath?: string | null; serverNames?: readonly TMcpServerName[] },
    ) => Promise<IMastraMcpBundle>;

    protected readonly mcpGatewayPool: McpGatewayWarmPool;

    protected readonly now: (() => string) | undefined;

    protected readonly storage: IMastraStorageLike;

    protected readonly planStore: IAgentPlanStore;

    protected readonly planWorkflowStore: IAgentPlanWorkflowStore;

    protected readonly loggerRef: IMastraLogToolsRef;

    protected readonly pendingApprovals = new Map<string, IMastraPendingApproval>();

    protected readonly pendingApprovalTimers = new Map<string, ReturnType<typeof setTimeout>>();

    /** 放弃审批的资源回收 TTL；<=0 时禁用自动回收。 */
    protected readonly pendingApprovalTtlMs: number = PENDING_APPROVAL_TTL_MS;

    constructor(deps: IMastraRuntimeDeps = {}) {
        this.createAgent = deps.createAgent ?? defaultCreateAgent;
        this.storage = deps.createStorage ? deps.createStorage() : defaultCreateStorage();
        this.planStore = deps.createPlanStore ? deps.createPlanStore() : createAgentPlanStore();
        this.planWorkflowStore = deps.createPlanWorkflowStore
            ? deps.createPlanWorkflowStore()
            : createAgentPlanWorkflowStore();
        this.loggerRef = createMastraLoggerRef();
        this.shouldUseRegisteredAgentForTools =
            deps.createAgent === undefined || deps.createResumableAgentHandle !== undefined;
        this.createResumableAgentHandle = deps.createResumableAgentHandle
            ?? ((config) => defaultCreateResumableAgentHandle(config, this.storage, this.loggerRef));
        this.createExecutionHandle = deps.createExecutionHandle
            ?? ((config) => defaultCreateExecutionHandle(config, this.storage, this.loggerRef));
        this.loadExecutionSnapshot = deps.loadExecutionSnapshot
            ?? (async (workflowName, runId) => {
                const workflowStore = await this.storage.getStore('workflows');
                return workflowStore?.loadWorkflowSnapshot({ workflowName, runId }) ?? null;
            });
        this.readModelConfig = deps.readModelConfig ?? createMastraModelConfigFromEnv;
        this.createMcpClientBundle = deps.createMcpClientBundle ?? createMastraMcpClientBundle;
        this.mcpGatewayPool = createMcpGatewayWarmPool({
            createBundle: this.createMcpClientBundle,
        });
        if (!deps.createMcpClientBundle && !isNodeTestProcess()) {
            void this.mcpGatewayPool
                .primeCatalog({ serverNames: STARTUP_PRIME_SERVER_NAMES })
                .catch(() => undefined);
        }
        this.now = deps.now;
    }

    /**
     * 优雅关闭：清理挂起审批的 TTL 回收计时器，并断开暖池中的全部 MCP 连接
     * （含其 stdio 子进程）。由进程退出 / 终止信号处理器调用，避免 MCP 子进程
     * 变成孤儿进程。
     */
    async dispose(): Promise<void> {
        for (const requestId of [...this.pendingApprovalTimers.keys()]) {
            this.clearPendingApprovalTimer(requestId);
        }
        await this.mcpGatewayPool.disconnectAll();
    }

    protected registerPendingApproval(
        sessionId: string,
        agent: IMastraAgentLike,
        bundle: IMastraMcpBundle,
        chunk: TMastraToolCallApprovalChunk | TMastraToolCallSuspendedChunk,
        workspace?: AnyWorkspace,
        browser?: MastraBrowser,
    ): string | null {
        const runId = getChunkRunId(chunk);

        const canResolveApproval =
            typeof agent.approveToolCall === 'function' &&
            typeof agent.declineToolCall === 'function';
        const canResumeSuspendedTool = typeof agent.resumeStream === 'function';

        if (!runId || (!canResolveApproval && !canResumeSuspendedTool)) {
            return null;
        }

        const approvedPath = extractApprovalToolPath(chunk.payload.args);
        const requestId = encodeApprovalRequestId(runId, chunk.payload.toolCallId, approvedPath);
        this.pendingApprovals.set(requestId, {
            agent,
            bundle,
            runId,
            sessionId,
            toolCallId: chunk.payload.toolCallId,
            kind: chunk.type === 'tool-call-suspended' ? 'suspended' : 'approval',
            ...(approvedPath ? { approvedPath } : {}),
            ...(workspace ? { workspace } : {}),
            ...(browser ? { browser } : {}),
        });

        this.schedulePendingApprovalEviction(requestId);

        return requestId;
    }

    /**
     * 为某个挂起审批安排 TTL 回收计时器。若用户始终不 resolve，超时后释放其资源。
     */
    protected schedulePendingApprovalEviction(requestId: string): void {
        if (!(this.pendingApprovalTtlMs > 0)) {
            return;
        }
        this.clearPendingApprovalTimer(requestId);
        const timer = setTimeout(() => {
            void this.evictPendingApproval(requestId);
        }, this.pendingApprovalTtlMs);
        // 不让悬挂的审批计时器阻止进程退出。
        timer.unref?.();
        this.pendingApprovalTimers.set(requestId, timer);
    }

    /** 清理某个挂起审批的回收计时器（在被正常 resolve 时调用）。 */
    protected clearPendingApprovalTimer(requestId: string): void {
        const timer = this.pendingApprovalTimers.get(requestId);
        if (timer) {
            clearTimeout(timer);
            this.pendingApprovalTimers.delete(requestId);
        }
    }

    /** TTL 到期后释放挂起审批占用的 bundle / workspace / browser。 */
    protected async evictPendingApproval(requestId: string): Promise<void> {
        this.pendingApprovalTimers.delete(requestId);
        const pending = this.pendingApprovals.get(requestId);
        if (!pending) {
            return;
        }
        this.pendingApprovals.delete(requestId);
        try {
            await pending.bundle.disconnectAll();
        } catch {
            // 资源释放尽力而为，忽略清理期间的异常。
        }
        await destroyMastraWorkspace(pending.workspace);
        await destroyMastraBrowser(pending.browser);
    }

    protected async createResumableApprovalContext(
        input: IApprovalResolutionInput,
        sessionId: string,
        decodedRequest: { runId: string; toolCallId: string; path?: string | undefined },
    ): Promise<IMastraApprovalExecutionContext | null> {
        const mode: IAgentRuntimeInput['mode'] = 'agent';
        const normalizedInput: IAgentRuntimeInput = {
            mode,
            goal: input.goal?.trim() || '继续当前任务',
            messages: input.messages ?? [],
            context: input.context ?? [],
            ...(input.workspaceRootPath ? { workspaceRootPath: input.workspaceRootPath } : {}),
            ...(input.threadId ? { threadId: input.threadId } : {}),
            ...(input.modelConfig ? { modelConfig: input.modelConfig } : {}),
            ...(input.planId ? { planId: input.planId } : {}),
            ...(input.planVersion ? { planVersion: input.planVersion } : {}),
            ...(input.planStepId ? { planStepId: input.planStepId } : {}),
            sessionId,
        };
        const modelConfig = resolveMastraModelConfig(this.readModelConfig, normalizedInput.modelConfig);

        if (!modelConfig) {
            return null;
        }

        let approvedPlanRecord: TAgentPlanRecord | undefined;
        if (normalizedInput.planId && normalizedInput.planVersion && normalizedInput.planStepId) {
            try {
                approvedPlanRecord = await this.planStore.getPlan({
                    planId: normalizedInput.planId,
                    version: normalizedInput.planVersion,
                });
            } catch {
                approvedPlanRecord = undefined;
            }
        }

        const memoryInput: IAgentRuntimeInput = {
            ...normalizedInput,
            ...(approvedPlanRecord?.threadId ? {
                threadId: normalizedInput.threadId ?? approvedPlanRecord.threadId,
            } : {}),
        };
        const {
            bundle,
            tools,
            hasTools,
            workspace,
            browser,
        } = await loadMastraMcpTools(
            this.mcpGatewayPool,
            normalizedInput.workspaceRootPath,
            this.loggerRef,
            normalizedInput.context ?? [],
            'write',
            memoryInput,
        );
        const memory = createMastraMemoryReference(
            createMastraMemoryScope(memoryInput, sessionId, { resourceScope: 'session' }),
        );
        const agentMemory = createMastraMemoryForModel(modelConfig);
        const systemPrompt = [
            buildSystemPrompt(memoryInput, modelConfig.modelId),
            ...(approvedPlanRecord && normalizedInput.planStepId
                ? [createApprovedPlanExecutionContext(approvedPlanRecord, normalizedInput.planStepId)]
                : []),
        ].join('\n\n');
        const executionHandle = await this.createResumableAgentHandle({
            id: DEFAULT_EXECUTION_AGENT_ID,
            name: DEFAULT_EXECUTION_AGENT_NAME,
            instructions: systemPrompt,
            model: createMastraModelConfig(modelConfig),
            memory: agentMemory,
            ...(hasTools ? { tools } : {}),
            ...(workspace ? { workspace } : {}),
            ...(browser ? { browser } : {}),
            inputProcessors: createMastraAgentInputProcessors(),
            outputProcessors: createMastraAgentOutputProcessors(),
        });

        if (typeof executionHandle.agent.resumeStream !== 'function') {
            await bundle.disconnectAll();
            await destroyMastraWorkspace(workspace);
            await destroyMastraBrowser(browser);
            return null;
        }

        return {
            pending: {
                agent: executionHandle.agent,
                bundle,
                runId: decodedRequest.runId,
                sessionId,
                toolCallId: decodedRequest.toolCallId,
                kind: 'suspended',
                ...(decodedRequest.path ? { approvedPath: decodedRequest.path } : {}),
                ...(workspace ? { workspace } : {}),
                ...(browser ? { browser } : {}),
            },
            systemPrompt,
            memory,
            ...(approvedPlanRecord ? { approvedPlanRecord } : {}),
        };
    }

    protected async consumeTextStream(
        agent: IMastraAgentLike,
        bundle: IMastraMcpBundle,
        sessionId: string,
        stream: IMastraAgentStreamLike,
        events: TAgentRuntimeOutputEvent[],
        options: IAgentRuntimeRunOptions,
        createRuntimeEvent?: TRuntimeEventFactory,
        workspace?: AnyWorkspace,
        browser?: MastraBrowser,
        workflowTracker?: IPlanWorkflowStepTracker,
    ): Promise<IMastraTextStreamSummary> {
        const visibleTextParts: string[] = [];
        let streamErrorMessage: string | null = null;
        let pendingApproval = false;
        let releaseResources = true;
        let doneTokenSnapshot: TDoneTokenSnapshot | undefined;
        const pendingToolCallIdsByName = new Map<string, string[]>();

        for await (const rawChunk of stream.fullStream) {
            const chunk = rawChunk as TMastraStreamChunk;
            const finishTokenSnapshot = extractFinishTokenSnapshot(chunk);
            if (finishTokenSnapshot) {
                doneTokenSnapshot = aggregateDoneTokenSnapshot(doneTokenSnapshot, finishTokenSnapshot);
                continue;
            }

            const memoryCompressedEvent = createOmMemoryCompressedEventDraft(chunk);
            if (memoryCompressedEvent) {
                if (createRuntimeEvent) {
                    pushUiEvent(events, createRuntimeEvent(memoryCompressedEvent), options);
                }
                continue;
            }

            if (isSandboxDataChunk(chunk)) {
                if (createRuntimeEvent) {
                    pushUiEvent(events, createRuntimeEvent({
                        type: 'agent.tool.progress',
                        visibility: 'user',
                        level: chunk.type === 'data-sandbox-stderr' ? 'warn' : 'info',
                        toolName: WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND,
                        ...(typeof chunk.data.toolCallId === 'string' ? { toolUseId: chunk.data.toolCallId } : {}),
                        dataPreview: createSandboxToolProgressPreview(chunk),
                    }), options);
                }
                continue;
            }

            const reasoningDelta = getReasoningDelta(chunk);
            if (reasoningDelta) {
                if (createRuntimeEvent) {
                    pushUiEvent(events, createRuntimeEvent({
                        type: 'agent.reasoning.delta',
                        visibility: 'user',
                        level: 'info',
                        text: reasoningDelta,
                    }), options);
                }
                continue;
            }

            if (isTextDeltaChunk(chunk)) {
                const nextText = getTextDelta(chunk);
                if (!nextText) {
                    continue;
                }

                visibleTextParts.push(nextText);
                // 仅发射增量富事件 agent.text.delta（visibility:'user'）；
                // 正文增量经 egress 投影为 ACP agent_message_chunk，完整结果由 prompt 响应承载。
                if (createRuntimeEvent) {
                    pushUiEvent(events, createRuntimeEvent({
                        type: 'agent.text.delta',
                        visibility: 'user',
                        level: 'info',
                        text: nextText,
                    }), options);
                }
                continue;
            }

            if (chunk.type === 'tool-call' && isToolCallChunk(chunk)) {
                if (workflowTracker) {
                    await this.planWorkflowStore.heartbeat({
                        planId: workflowTracker.planId,
                        version: workflowTracker.version,
                        stepId: workflowTracker.stepId,
                        phase: 'before_tool',
                    });
                }

                const pendingToolCallIds = pendingToolCallIdsByName.get(chunk.payload.toolName) ?? [];
                pendingToolCallIds.push(chunk.payload.toolCallId);
                pendingToolCallIdsByName.set(chunk.payload.toolName, pendingToolCallIds);

                if (createRuntimeEvent) {
                    const inputPreview = createWorkspaceRuntimeInputPreview(
                        chunk.payload.toolName,
                        chunk.payload.args,
                    );

                    pushUiEvent(events, createRuntimeEvent({
                        type: 'agent.tool.started',
                        visibility: 'user',
                        level: 'info',
                        toolName: chunk.payload.toolName,
                        toolUseId: chunk.payload.toolCallId,
                        ...(inputPreview ? { inputPreview } : {}),
                    }), options);
                }
                continue;
            }

            if (isToolResultChunk(chunk)) {
                if (workflowTracker) {
                    await this.planWorkflowStore.heartbeat({
                        planId: workflowTracker.planId,
                        version: workflowTracker.version,
                        stepId: workflowTracker.stepId,
                        phase: 'after_tool',
                    });
                }

                const pendingToolCallIds = pendingToolCallIdsByName.get(chunk.payload.toolName) ?? [];
                // 始终从队列出队一个，避免 toolCallId 存在时残留条目无限累积。
                const queuedToolCallId = pendingToolCallIds.shift();
                const toolUseId = chunk.payload.toolCallId ?? queuedToolCallId;
                if (pendingToolCallIds.length === 0) {
                    pendingToolCallIdsByName.delete(chunk.payload.toolName);
                }

                if (createRuntimeEvent) {
                    const resultPreview = createWorkspaceRuntimeResultPreview(
                        chunk.payload.toolName,
                        chunk.payload.result,
                    );

                    pushUiEvent(events, createRuntimeEvent({
                        type: 'agent.tool.completed',
                        visibility: 'user',
                        level: 'info',
                        toolName: chunk.payload.toolName,
                        ok: true,
                        ...(toolUseId ? { toolUseId } : {}),
                        ...(resultPreview ? { resultPreview } : {}),
                    }), options);
                }
                continue;
            }

            if (chunk.type === 'tool-call-approval' && isToolCallChunk(chunk)) {
                pendingApproval = true;
                const pendingRequestId = this.registerPendingApproval(
                    sessionId,
                    agent,
                    bundle,
                    chunk,
                    workspace,
                    browser,
                );

                if (pendingRequestId) {
                    releaseResources = false;
                }

                pushUiEvent(events, {
                    type: 'approval_required',
                    request: createApprovalRequest(chunk.payload, pendingRequestId ? getChunkRunId(chunk) : null),
                }, options);
                continue;
            }

            if (isToolCallSuspendedChunk(chunk)) {
                pendingApproval = true;
                const pendingRequestId = this.registerPendingApproval(
                    sessionId,
                    agent,
                    bundle,
                    chunk,
                    workspace,
                    browser,
                );

                if (pendingRequestId) {
                    releaseResources = false;
                }

                // ask_user：反向提问工具挂起时，surface 为结构化 ask_user_required（带外承载，
                // 镜像 approval_required），而非降级成单一 approve/reject 气泡；恢复经专用 ext
                // 方法回传富答案续跑（见 acp/ext-methods 的 ask-user resume，2c 落地）。其余挂起
                // 工具仍走下方通用 approval_required 兜底。
                // ask_user：反向提问工具挂起 —— 始终 surface 结构化 ask_user_required，绝不降级到旧的
                // approve/reject 审批气泡（杜绝新旧杂糅）。挂起负载由本工具按 suspendSchema 自构造；权威的跨进程
                // 校验在 sidecar→renderer 边界（前端 extractPendingAskUser 再行 zod 解析），此处 safeParse 仅作
                // 进程内类型收窄。万一（按契约不可达）失败：既不回灌审批链、也不终结回合，仅跳过本次 surface，
                // 挂起句柄交由 TTL 回收。
                if (chunk.payload.toolName === ASK_USER_TOOL_NAME) {
                    const surfacedRequest = askUserRequestSchema.safeParse(chunk.payload.suspendPayload);
                    if (surfacedRequest.success) {
                        pushUiEvent(events, {
                            type: 'ask_user_required',
                            requestId: pendingRequestId ?? chunk.payload.toolCallId,
                            request: surfacedRequest.data,
                        }, options);
                    }
                    continue;
                }

                const suspendedRisk = deriveApprovalRisk(chunk.payload);
                pushUiEvent(events, {
                    type: 'approval_required',
                    request: {
                        id: pendingRequestId ?? chunk.payload.toolCallId,
                        toolName: chunk.payload.toolName,
                        question: `${chunk.payload.toolName} 已暂停，等待继续信息。`,
                        summary: JSON.stringify(toJsonValue(chunk.payload.suspendPayload)),
                        riskLevel: suspendedRisk.riskLevel,
                        reversible: suspendedRisk.reversible,
                        createdAt: new Date().toISOString(),
                    },
                }, options);
                continue;
            }

            if (isToolErrorChunk(chunk)) {
                const errorMessage = normalizeMastraError(chunk.payload.error);

                if (createRuntimeEvent) {
                    pushUiEvent(events, createRuntimeEvent({
                        type: 'agent.tool.completed',
                        visibility: 'user',
                        level: 'error',
                        toolName: chunk.payload.toolName,
                        ok: false,
                        errorMessage,
                    }), options);
                }
                continue;
            }

            if (isErrorChunk(chunk)) {
                streamErrorMessage = normalizeMastraError(chunk.payload.error);
                continue;
            }

            if (chunk.type === 'abort') {
                streamErrorMessage = 'Mastra Agent 执行已中止。';
            }
        }

        return {
            pendingApproval,
            releaseResources,
            streamErrorMessage,
            visibleText: visibleTextParts.join(''),
            ...(doneTokenSnapshot ? { doneTokenSnapshot } : {}),
        };
    }

    protected createFallbackApprovalResponse(
        input: IApprovalResolutionInput,
        sessionId: string,
        options: IAgentRuntimeRunOptions,
    ): IAgentRuntimeResponse {
        const result = '审批结果已记录，等待下一次 Agent 执行继续消费。';
        const events: TAgentRuntimeOutputEvent[] = [];

        // 复用真实 runId（来自审批 token），使该事件的链路元数据与原始 turn 一致；
        // toolName 维持 'approval' 以保持前端事件适配层的工具配对/结果渲染不变。
        const decoded = decodeApprovalRequestId(input.requestId);
        const createRuntimeEvent = createRuntimeEventFactory({
            runId: decoded?.runId ?? sessionId,
            sessionId,
            agentId: DEFAULT_EXECUTION_AGENT_ID,
            ...(this.now ? { now: this.now } : {}),
        });

        pushUiEvent(events, createRuntimeEvent({
            type: 'agent.tool.completed',
            visibility: 'user',
            level: 'info',
            toolName: 'approval',
            ok: true,
            resultPreview: createRuntimePreview({
                requestId: input.requestId,
                decision: input.decision,
            }),
        }), options);

        return {
            sessionId,
            events,
            result,
        };
    }
}
