import { createMastraModelConfigFromEnv } from '../models/config.js';
import type { IMastraResolvedModelConfig } from '../models/config.js';
import { createMastraLoggerRef } from '../tools/log.js';
import type { IMastraLogToolsRef } from '../tools/log.js';
import { createMcpGatewayWarmPool } from '../tools/mcp-gateway.js';
import type { McpGatewayWarmPool } from '../tools/mcp-gateway.js';
import { createMastraMcpClientBundle } from '../tools/mcp.js';
import type { TMcpServerName } from '../tools/mcp.js';
import { buildSystemPrompt } from './prompts/system-prompt.js';
import { createMastraMemoryReference, createMastraMemoryScope } from './context/memory.js';
import { createMastraMemoryForModel, createMastraModelConfig, defaultCreateAgent, defaultCreateExecutionHandle, defaultCreateResumableAgentHandle, defaultCreateStorage, resolveMastraModelConfig } from './agent/factory.js';
import { encodeApprovalRequestId, extractApprovalToolPath, getChunkRunId } from './approval-client/utils.js';
import { normalizeMastraError } from './messages.js';
import { createApprovalRequest, createApprovedPlanExecutionContext, deriveApprovalRisk } from './responses.js';
import { aggregateDoneTokenSnapshot, createOmMemoryCompressedEventDraft, createSandboxToolProgressPreview, extractFinishTokenSnapshot, getReasoningDelta, getTextDelta, isErrorChunk, isSandboxDataChunk, isTextDeltaChunk, isToolCallChunk, isToolCallSuspendedChunk, isToolErrorChunk, isToolResultChunk } from './stream/stream-utils.js';
import { loadMastraMcpTools } from './tools/tools.js';
import { DEFAULT_EXECUTION_AGENT_ID, DEFAULT_EXECUTION_AGENT_NAME } from './types.js';
import type { IMastraAgentConfig, IMastraAgentLike, IMastraAgentStreamLike, IMastraApprovalExecutionContext, IMastraExecutionHandle, IMastraMcpBundle, IMastraPendingApproval, IMastraResumableAgentHandle, IMastraRuntimeDeps, IMastraStorageLike, IMastraTextStreamSummary, IMastraWorkflowSnapshotLike, IPlanWorkflowStepTracker, TDoneTokenSnapshot, TMastraStreamChunk, TMastraToolCallApprovalChunk, TMastraToolCallSuspendedChunk, TRuntimeEventFactory } from './types.js';
import { createWorkspaceRuntimeInputPreview, createWorkspaceRuntimeResultPreview, isNodeTestProcess, pushUiEvent, toJsonValue } from './utils.js';
import { createMastraAgentInputProcessors, createMastraAgentOutputProcessors, destroyMastraBrowser, destroyMastraWorkspace } from './workspace.js';
import { createAgentPlanStore } from './plan/plan-store.js';
import type { IAgentPlanStore, TAgentPlanRecord } from './plan/plan-store.js';
import { createAgentPlanWorkflowStore } from './plan/plan-workflow-store.js';
import type { IAgentPlanWorkflowStore } from './plan/plan-workflow-store.js';
import type { IAgentRuntimeResponse, IAgentRuntimeRunOptions, TAgentRuntimeOutputEvent } from './contracts/runtime-contracts.js';
import type { IAgentRuntimeInput, IApprovalResolutionInput } from './contracts/runtime-input.js';
import { SIDECAR_VERSION } from './runtime.js';
import type { MastraBrowser } from '@mastra/core/browser';
import { WORKSPACE_TOOLS } from '@mastra/core/workspace';
import type { AnyWorkspace } from '@mastra/core/workspace';

/**
 * 放弃的审批（用户从不 resolve）在内存中保留的最长时间。超时后释放其持有的
 * MCP bundle / workspace / browser，避免长跑 sidecar 永久泄漏重型资源。
 */
const PENDING_APPROVAL_TTL_MS = 10 * 60_000;

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
            void this.mcpGatewayPool.primeCatalog().catch(() => undefined);
        }
        this.now = deps.now;
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
        let visibleText = '';
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

                visibleText += nextText;
                // Emit only the incremental text; the frontend accumulates it.
                // The terminal done event still carries the full result.
                pushUiEvent(events, {
                    type: 'message_delta',
                    text: nextText,
                    phase: 'final',
                }, options);
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

                const input = chunk.payload.args === undefined ? null : toJsonValue(chunk.payload.args);
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

                pushUiEvent(events, {
                    type: 'tool_start',
                    toolName: chunk.payload.toolName,
                    input,
                }, options);
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

                const output = toJsonValue(chunk.payload.result);
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

                pushUiEvent(events, {
                    type: 'tool_result',
                    toolName: chunk.payload.toolName,
                    output,
                }, options);
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

                pushUiEvent(events, {
                    type: 'tool_result',
                    toolName: chunk.payload.toolName,
                    output: toJsonValue({
                        error: errorMessage,
                    }),
                }, options);
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
            visibleText,
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

        pushUiEvent(events, {
            type: 'tool_result',
            toolName: 'approval',
            output: {
                requestId: input.requestId,
                decision: input.decision,
            },
        }, options);
        pushUiEvent(events, {
            type: 'done',
            result,
        }, options);

        return {
            sessionId,
            events,
            result,
        };
    }
}
