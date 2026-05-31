import { MastraRuntimeValidation } from './validation.js';
import { createDeepSeekReasoningRunPrefix, evictDeepSeekReasoningByPrefix, runWithDeepSeekReasoningContext } from '../models/providers/deepseek-reasoning-fetch.js';
import { buildSystemPrompt } from './prompts/system-prompt.js';
import { createMastraMemoryReference, createMastraMemoryScope } from './context/memory.js';
import { createMastraMemoryForModel, createMastraModelConfig, resolveMastraModelConfig } from './agent/factory.js';
import { createAcontextTokenEventDraft, createDeepSeekPayloadEventSink } from './budget/budget.js';
import { createExecutionRequestContext } from './context/context.js';
import { buildMastraMessages, normalizeMastraError } from './messages.js';
import { createApprovedPlanExecutionContext, createErrorResponse } from './responses.js';
import { createDoneOutputEvent } from './stream/stream-utils.js';
import { loadMastraMcpTools } from './tools/tools.js';
import { DEFAULT_EXECUTION_AGENT_ID, DEFAULT_EXECUTION_AGENT_NAME } from './types.js';
import type { IMastraGenerateOptions } from './types.js';
import { attachMcpGatewayMetrics, createRuntimeEventFactory, createSessionId, pushUiEvent, toNonEmptyString } from './utils.js';
import { createMastraAgentInputProcessors, createMastraAgentOutputProcessors, destroyMastraBrowser, destroyMastraWorkspace } from './workspace.js';
import type { TAgentPlanRecord } from './plan/plan-store.js';
import type { IAgentRuntimeResponse, IAgentRuntimeRunOptions, TAgentRuntimeOutputEvent } from './contracts/runtime-contracts.js';
import type { IAgentRuntimeInput } from './contracts/runtime-input.js';


export class MastraRuntimeExecution extends MastraRuntimeValidation {
    async execute(
        input: IAgentRuntimeInput,
        options: IAgentRuntimeRunOptions = {},
    ): Promise<IAgentRuntimeResponse> {
        const normalizedInput: IAgentRuntimeInput = {
            ...input,
            mode: 'agent',
        };
        const sessionId = normalizedInput.sessionId ?? createSessionId('mastra-execute');
        const events: TAgentRuntimeOutputEvent[] = [];
        const planId = toNonEmptyString(normalizedInput.planId);
        const planStepId = toNonEmptyString(normalizedInput.planStepId);
        const planVersion = normalizedInput.planVersion;
        const requestedRunId = options.context?.requestId ?? createSessionId('mastra-run');

        if (!planId || !planStepId || !Number.isInteger(planVersion) || Number(planVersion) <= 0) {
            return createErrorResponse(
                sessionId,
                'Agent 执行需要已批准计划的 planId、planVersion 和 planStepId。',
                events,
                options,
            );
        }

        let approvedPlanRecord: TAgentPlanRecord;
        try {
            const gate = await this.planStore.prepareExecution({
                planId,
                version: Number(planVersion),
                stepId: planStepId,
            });
            approvedPlanRecord = gate.record;
            await this.planWorkflowStore.createForPlan({ record: approvedPlanRecord });
            await this.planWorkflowStore.approvePlan(approvedPlanRecord);
            await this.planWorkflowStore.startStep({
                planId,
                version: Number(planVersion),
                stepId: planStepId,
                mastraRunId: requestedRunId,
            });
        } catch (error) {
            return createErrorResponse(
                sessionId,
                `Plan 执行门禁失败：${normalizeMastraError(error)}`,
                events,
                options,
            );
        }

        const memoryInput: IAgentRuntimeInput = {
            ...normalizedInput,
            threadId: normalizedInput.threadId ?? approvedPlanRecord.threadId,
        };

        const modelConfig = resolveMastraModelConfig(this.readModelConfig, normalizedInput.modelConfig);

        if (!modelConfig) {
            return createErrorResponse(
                sessionId,
                'AI 模型未配置：请在 Node sidecar 环境设置 AGENT_SIDECAR_MODEL 与 AGENT_SIDECAR_API_KEY。',
                events,
                options,
            );
        }

        const {
            bundle: mcpBundle,
            tools: mastraTools,
            hasTools,
            toolStats,
            mcpGatewayMetrics,
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
        const hasAgentTools = hasTools || Boolean(workspace) || Boolean(browser);
        const memory = createMastraMemoryReference(
            createMastraMemoryScope(memoryInput, sessionId, { resourceScope: 'session' }),
        );
        const agentMemory = createMastraMemoryForModel(modelConfig);
        const createRequestedRunEvent = createRuntimeEventFactory({
            runId: requestedRunId,
            sessionId,
            agentId: DEFAULT_EXECUTION_AGENT_ID,
            ...(this.now ? { now: this.now } : {}),
        });
        const systemPrompt = [
            buildSystemPrompt(memoryInput, modelConfig.modelId),
            createApprovedPlanExecutionContext(approvedPlanRecord, planStepId),
        ].join('\n\n');
        const payloadEventSink = createDeepSeekPayloadEventSink(events, options);
        let shouldDisconnectBundle = true;
        let streamCleanup: (() => void) | undefined;

        try {
            return await runWithDeepSeekReasoningContext({
                sessionId,
                runId: requestedRunId,
                onRequestPayload: payloadEventSink.onRequestPayload,
            }, async () => {
                const mastraMessages = buildMastraMessages(memoryInput);
                const toolChoice: IMastraGenerateOptions['toolChoice'] = hasAgentTools ? 'auto' : 'none';
                const executionHandle = await this.createExecutionHandle({
                    id: DEFAULT_EXECUTION_AGENT_ID,
                    name: DEFAULT_EXECUTION_AGENT_NAME,
                    instructions: systemPrompt,
                    model: createMastraModelConfig(modelConfig),
                    memory: agentMemory,
                    ...(hasTools ? { tools: mastraTools } : {}),
                    ...(workspace ? { workspace } : {}),
                    ...(browser ? { browser } : {}),
                    inputProcessors: createMastraAgentInputProcessors(),
                    outputProcessors: createMastraAgentOutputProcessors(),
                });
                const stream = await executionHandle.agent.stream(
                    mastraMessages,
                    {
                        maxSteps: hasAgentTools ? 10 : 1,
                        toolChoice,
                        memory,
                        ...(options.context?.signal ? { abortSignal: options.context.signal } : {}),
                        runId: requestedRunId,
                        requestContext: createExecutionRequestContext(
                            memoryInput,
                            systemPrompt,
                            memory,
                            approvedPlanRecord,
                        ),
                    },
                );
                streamCleanup = stream.cleanup;
                const checkpointRunId = stream.runId ?? requestedRunId;
                const createCheckpointEvent = checkpointRunId === requestedRunId
                    ? createRequestedRunEvent
                    : createRuntimeEventFactory({
                        runId: checkpointRunId,
                        sessionId,
                        agentId: DEFAULT_EXECUTION_AGENT_ID,
                        ...(this.now ? { now: this.now } : {}),
                    });

                payloadEventSink.attachRuntimeEventFactory(createCheckpointEvent);
                attachMcpGatewayMetrics(mcpGatewayMetrics, console);
                pushUiEvent(events, createCheckpointEvent(createAcontextTokenEventDraft({
                    systemPrompt,
                    messages: mastraMessages,
                    contextReferences: normalizedInput.context ?? [],
                    tools: mastraTools,
                    toolStats,
                    workspaceEnabled: Boolean(workspace),
                    browserEnabled: Boolean(browser),
                    memoryEnabled: true,
                    maxSteps: hasAgentTools ? 10 : 1,
                    toolChoice,
                })), options);
                pushUiEvent(events, createCheckpointEvent({
                    type: 'rollback.checkpoint.created',
                    visibility: 'user',
                    level: 'info',
                    snapshotId: checkpointRunId,
                }), options);

                const streamSummary = await this.consumeTextStream(
                    executionHandle.agent,
                    mcpBundle,
                    sessionId,
                    stream,
                    events,
                    options,
                    createCheckpointEvent,
                    workspace,
                    browser,
                    {
                        planId,
                        version: Number(planVersion),
                        stepId: planStepId,
                    },
                );
                shouldDisconnectBundle = streamSummary.releaseResources;

                if (streamSummary.streamErrorMessage) {
                    await this.planWorkflowStore.failStep({
                        planId,
                        version: Number(planVersion),
                        stepId: planStepId,
                        error: streamSummary.streamErrorMessage,
                        retryable: true,
                    });
                    return createErrorResponse(
                        sessionId,
                        `Mastra Agent 执行失败：${streamSummary.streamErrorMessage}`,
                        events,
                        options,
                    );
                }

                if (streamSummary.pendingApproval) {
                    await this.planWorkflowStore.suspend({
                        planId,
                        version: Number(planVersion),
                        reason: 'tool_external_wait',
                        payload: {
                            stepId: planStepId,
                            runId: checkpointRunId,
                        },
                        allowedFields: ['decision', 'requestId'],
                    });
                    return {
                        sessionId,
                        events,
                        result: null,
                    };
                }

                const result = streamSummary.visibleText.trim().length > 0
                    ? streamSummary.visibleText
                    : 'Agent 已完成。';

                await this.planWorkflowStore.completeStep({
                    planId,
                    version: Number(planVersion),
                    stepId: planStepId,
                    resultRef: checkpointRunId,
                });

                pushUiEvent(events, createDoneOutputEvent(result, streamSummary.doneTokenSnapshot), options);

                return {
                    sessionId,
                    events,
                    result,
                };
            });
        } catch (error) {
            await this.planWorkflowStore.failStep({
                planId,
                version: Number(planVersion),
                stepId: planStepId,
                error: normalizeMastraError(error),
                retryable: true,
            }).catch(() => undefined);
            pushUiEvent(events, createRequestedRunEvent({
                type: 'rollback.checkpoint.failed',
                visibility: 'user',
                level: 'error',
                snapshotId: requestedRunId,
                errorMessage: normalizeMastraError(error),
            }), options);

            return createErrorResponse(
                sessionId,
                `Mastra Agent 执行失败：${normalizeMastraError(error)}`,
                events,
                options,
            );
        } finally {
            if (shouldDisconnectBundle) {
                evictDeepSeekReasoningByPrefix(createDeepSeekReasoningRunPrefix(sessionId, requestedRunId));
                streamCleanup?.();
                await mcpBundle.disconnectAll();
                await destroyMastraWorkspace(workspace);
                await destroyMastraBrowser(browser);
            }
        }
    }
}
