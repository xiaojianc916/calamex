import { MastraRuntimePlan } from './plan/plan.js';
import { createDeepSeekReasoningRunPrefix, evictDeepSeekReasoningByPrefix, runWithDeepSeekReasoningContext } from '../models/providers/deepseek-reasoning-fetch.js';
import { agentPlanDeltaSchema, agentPlanValidationReportSchema } from '../schemas/plan-workflow.js';
import { createMastraMemoryReference, createMastraMemoryScope } from './context/memory.js';
import { createMastraMemoryForModel, createMastraModelConfig, resolveMastraModelConfig } from './agent/factory.js';
import { createAcontextTokenEventDraft, createDeepSeekPayloadEventSink } from './budget/budget.js';
import { normalizeMastraError } from './errors.js';
import { applyAgentPlanDelta, parsePlanDelta, parseValidationReport } from './plan/plan-utils.js';
import { createErrorResponse, createPlanResponse } from './responses.js';
import { loadMastraMcpTools } from './tools/tools.js';
import { DEFAULT_REPLANNER_AGENT_ID, DEFAULT_VALIDATOR_AGENT_ID } from './types.js';
import type { IMastraGenerateOptions, TMastraChatMessage } from './types.js';
import { attachMcpGatewayMetrics, createRuntimeEventFactory, createSessionId, pushUiEvent, toJsonValue, toNonEmptyString } from './utils.js';
import { createMastraAgentInputProcessors, createMastraAgentOutputProcessors, destroyMastraBrowser, destroyMastraWorkspace } from './workspace.js';
import type { IAgentRuntimeResponse, IAgentRuntimeRunOptions, TAgentRuntimeOutputEvent } from './contracts/runtime-contracts.js';
import type { IAgentRuntimeInput } from './contracts/runtime-input.js';


export class MastraRuntimeValidation extends MastraRuntimePlan {
    protected async preparePlanAgentRun(
        input: IAgentRuntimeInput,
        sessionId: string,
        events: TAgentRuntimeOutputEvent[],
        options: IAgentRuntimeRunOptions,
        runIdPrefix: string,
        missingPlanMessage: string,
    ) {
        const planId = toNonEmptyString(input.planId);
        const planVersion = input.planVersion;

        if (!planId || !Number.isInteger(planVersion) || Number(planVersion) <= 0) {
            return {
                ok: false as const,
                response: createErrorResponse(
                    sessionId,
                    missingPlanMessage,
                    events,
                    options,
                ),
            };
        }

        const modelConfig = resolveMastraModelConfig(this.readModelConfig, input.modelConfig);

        if (!modelConfig) {
            return {
                ok: false as const,
                response: createErrorResponse(
                    sessionId,
                    'AI 模型未配置：请在 Node sidecar 环境设置 AGENT_SIDECAR_MODEL 与 AGENT_SIDECAR_API_KEY。',
                    events,
                    options,
                ),
            };
        }

        const version = Number(planVersion);
        const record = await this.planStore.getPlan({
            planId,
            version,
        });
        let workflow = await this.planWorkflowStore.createForPlan({ record });
        if (record.status !== 'pending_approval' && record.status !== 'rejected') {
            workflow = await this.planWorkflowStore.approvePlan(record);
        }
        const workflowEvents = await this.planWorkflowStore.listEvents({
            planId,
            version,
        });
        const memoryInput: IAgentRuntimeInput = {
            ...input,
            threadId: input.threadId ?? record.threadId,
        };
        const toolBundle = await loadMastraMcpTools(
            this.mcpGatewayPool,
            input.workspaceRootPath,
            this.loggerRef,
            input.context ?? [],
            'readonly',
            memoryInput,
        );
        const requestedRunId = options.context?.requestId ?? createSessionId(runIdPrefix);
        const memory = createMastraMemoryReference(
            createMastraMemoryScope(memoryInput, sessionId, { resourceScope: 'session' }),
        );
        const agentMemory = createMastraMemoryForModel(modelConfig);
        const payloadEventSink = createDeepSeekPayloadEventSink(events, options);

        return {
            ok: true as const,
            planId,
            version,
            modelConfig,
            record,
            workflow,
            workflowEvents,
            toolBundle,
            requestedRunId,
            memory,
            agentMemory,
            payloadEventSink,
        };
    }

    protected async finalizePlanAgentRun(
        sessionId: string,
        requestedRunId: string,
        toolBundle: Awaited<ReturnType<typeof loadMastraMcpTools>>,
    ): Promise<void> {
        evictDeepSeekReasoningByPrefix(createDeepSeekReasoningRunPrefix(sessionId, requestedRunId));
        await toolBundle.bundle.disconnectAll();
        await destroyMastraWorkspace(toolBundle.workspace);
        await destroyMastraBrowser(toolBundle.browser);
    }

    async validatePlan(
        input: IAgentRuntimeInput,
        options: IAgentRuntimeRunOptions = {},
    ): Promise<IAgentRuntimeResponse> {
        const sessionId = input.sessionId ?? createSessionId('mastra-plan-validate');
        const events: TAgentRuntimeOutputEvent[] = [];
        const prepared = await this.preparePlanAgentRun(
            input,
            sessionId,
            events,
            options,
            