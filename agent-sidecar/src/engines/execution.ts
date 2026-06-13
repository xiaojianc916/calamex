import { MastraRuntimeValidation } from './validation.js';
import { buildSystemPrompt } from './prompts/system-prompt.js';
import { createMastraMemoryReference, createMastraMemoryScope, resolveObservationalMemoryEnabled, resolveSemanticRecallEnabled } from './context/memory.js';
import { createMastraMemoryForModel, createMastraModelConfig, resolveMastraModelConfig } from './agent/factory.js';
import { createAcontextTokenEventDraft } from './budget/budget.js';
import { createExecutionRequestContext } from './context/context.js';
import { normalizeMastraError } from './errors.js';
import { resolveAgentExecutionPolicy } from './policy/execution-policy.js';
import { createApprovedPlanExecutionContext, createErrorResponse } from './responses.js';
import { createAgentExecutionSession } from './session/agent-session.js';
import { buildMastraMessagesFromSessionMessages, createAgentSessionMessagesFromRuntimeInput } from './session/session-messages.js';
import { loadMastraMcpTools } from './tools/tools.js';
import { DEFAULT_EXECUTION_AGENT_ID, DEFAULT_EXECUTION_AGENT_NAME } from './types.js';
import type { IMastraGenerateOptions } from './types.js';
import { attachMcpGatewayMetrics, toNonEmptyString } from './utils.js';
import { createMastraAgentInputProcessors, createMastraAgentOutputProcessors, destroyMastraBrowser, destroyMastraWorkspace } from './workspace.js';
import type { TAgentPlanRecord } from './plan/plan-store.js';
import type { IAgentRuntimeResponse, IAgentRuntimeRunOptions } from './contracts/runtime-contracts.js';
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
        const executionSession = createAgentExecutionSession({
            sessionId: normalizedInput.sessionId,
            runId: options.context?.requestId,
            agentId: DEFAULT_EXECUTION_AGENT_ID,
            ...(this.now ? { now: this.now } : {}),
        });
        const { sessionId, events, requestedRunId } = executionSession;
        const planId = toNonEmptyString(normalizedInput.planId);
        const planStepId = toNonEmptyString(normalizedInput.planStepId);
        const planVersion = normalizedInput.planVersion;

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

        const executionTurn = executionSession.startTurn({
            runId: requestedRunId,
            mode: normalizedInput.mode,
            goal: normalizedInput.goal,
            modelId: modelConfig.modelId,
        });
        const turnResourceScope = executionSession.createResourceScope(`turn:${executionTurn.id}`);

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
        turnResourceScope.add({
            name: 'mcp-bundle',
            dispose: () => mcpBundle.disconnectAll(),
        });
        if (workspace) {
            turnResourceScope.add({
                name: 'workspace',
                dispose: () => destroyMastraWorkspace(workspace),
            });
        }
        if (browser) {
            turnResourceScope.add({
                name: 'browser',
                dispose: () => destroyMastraBrowser(browser),
            });
        }
        const hasAgentTools = hasTools || Boolean(workspace) || Boolean(browser);
        const executionPolicy = resolveAgentExecutionPolicy();
        const maxSteps = hasAgentTools ? executionPolicy.maxSteps : 1;
        const memory = createMastraMemoryReference(
            createMastraMemoryScope(memoryInput, sessionId, { resourceScope: 'session' }),
        );
        const agentMemory = createMastraMemoryForModel(modelConfig);
        const observationalMemoryEnabled = resolveObservationalMemoryEnabled();
        const semanticRecallEnabled = resolveSemanticRecallEnabled();
        const createRequestedRunEvent = executionSession.createRuntimeEventFactory();
        const systemPrompt = [
            buildSystemPrompt(memoryInput, modelConfig.modelId),
            createApprovedPlanExecutionContext(approvedPlanRecord, planStepId),
        ].join('\n\n');
        let shouldReleaseTurnResources = true;
        let streamCleanup: (() => void) | undefined;
        turnResourceScope.add({
            name: 'stream-cleanup',
            dispose: () => {
                streamCleanup?.();
            },
        });

        try {
            const sessionMessages = createAgentSessionMessagesFromRuntimeInput(memoryInput);
            executionSession.appendMessages(sessionMessages);
            const mastraMessages = buildMastraMessagesFromSessionMessages(sessionMessages);
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
                    maxSteps,
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
                : executionSession.createRuntimeEventFactory(checkpointRunId);

            attachMcpGatewayMetrics(mcpGatewayMetrics, console);
            executionSession.push(createCheckpointEvent(createAcontextTokenEventDraft({
                systemPrompt,
                messages: mastraMessages,
                contextReferences: normalizedInput.context ?? [],
                tools: mastraTools,
                toolStats,
                workspaceEnabled: Boolean(workspace),
                browserEnabled: Boolean(browser),
                memoryEnabled: true,
                observationalMemoryEnabled,
                semanticRecallEnabled,
                maxSteps,
                toolChoice,
                modelCapabilities: modelConfig.capabilities,
            })), options);
            executionSession.push(createCheckpointEvent({
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
            shouldReleaseTurnResources = streamSummary.releaseResources;

            if (streamSummary.streamErrorMessage) {
                executionSession.failTurn(executionTurn.id, { errorMessage: streamSummary.streamErrorMessage });
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
                executionSession.suspendTurn(executionTurn.id, { reason: 'tool_external_wait' });
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

            executionSession.completeTurn(executionTurn.id, { result });

            return {
                sessionId,
                events,
                result,
                ...(streamSummary.doneTokenSnapshot ? { usage: streamSummary.doneTokenSnapshot } : {}),
            };
        } catch (error) {
            const errorMessage = normalizeMastraError(error);
            executionSession.failTurn(executionTurn.id, { errorMessage });
            await this.planWorkflowStore.failStep({
                planId,
                version: Number(planVersion),
                stepId: planStepId,
                error: errorMessage,
                retryable: true,
            }).catch(() => undefined);
            executionSession.push(createRequestedRunEvent({
                type: 'rollback.checkpoint.failed',
                visibility: 'user',
                level: 'error',
                snapshotId: requestedRunId,
                errorMessage,
            }), options);

            return createErrorResponse(
                sessionId,
                `Mastra Agent 执行失败：${errorMessage}`,
                events,
                options,
            );
        } finally {
            if (shouldReleaseTurnResources) {
                await turnResourceScope.disposeAll();
            }
        }
    }
}
