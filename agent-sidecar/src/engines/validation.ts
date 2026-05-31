import { MastraRuntimePlan } from './plan/plan.js';
import { createDeepSeekReasoningRunPrefix, evictDeepSeekReasoningByPrefix, runWithDeepSeekReasoningContext } from '../models/providers/deepseek-reasoning-fetch.js';
import { agentPlanDeltaSchema, agentPlanValidationReportSchema } from '../schemas/plan-workflow.js';
import { createMastraMemoryReference, createMastraMemoryScope } from './context/memory.js';
import { createMastraMemoryForModel, createMastraModelConfig, resolveMastraModelConfig } from './agent/factory.js';
import { createAcontextTokenEventDraft, createDeepSeekPayloadEventSink } from './budget/budget.js';
import { normalizeMastraError } from './messages.js';
import { applyAgentPlanDelta, parsePlanDelta, parseValidationReport } from './plan/plan-utils.js';
import { createErrorResponse, createPlanResponse } from './responses.js';
import { createDoneOutputEvent } from './stream/stream-utils.js';
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
            'mastra-plan-validator-run',
            '计划验证需要 planId 和 planVersion。',
        );

        if (!prepared.ok) {
            return prepared.response;
        }

        const {
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
        } = prepared;
        const {
            tools: mastraTools,
            hasTools,
            toolStats,
            mcpGatewayMetrics,
            workspace,
            browser,
        } = toolBundle;

        try {
            return await runWithDeepSeekReasoningContext({
                sessionId,
                runId: requestedRunId,
                onRequestPayload: payloadEventSink.onRequestPayload,
            }, async () => {
                const systemPrompt = [
                    '你是 Plan Mode 的 Validator Agent。',
                    '你只能验证已批准计划的执行结果，不允许修改文件，不允许提出无关重构。',
                    '优先依据 workflow event log、计划验收标准、用户目标和只读工具结果判断是否完成。',
                    '必须返回 json object，并严格匹配结构化输出 schema。',
                ].join('\n');
                const agent = this.createAgent({
                    id: DEFAULT_VALIDATOR_AGENT_ID,
                    name: 'Calamex Plan Validator',
                    instructions: systemPrompt,
                    model: createMastraModelConfig(modelConfig),
                    memory: agentMemory,
                    ...(hasTools ? { tools: mastraTools } : {}),
                    ...(workspace ? { workspace } : {}),
                    ...(browser ? { browser } : {}),
                    inputProcessors: createMastraAgentInputProcessors(),
                    outputProcessors: createMastraAgentOutputProcessors(),
                });
                const prompt = [
                    '请验证这个已执行计划的结果，返回 json object。',
                    `用户补充目标：${input.goal}`,
                    'approvedPlanJson:',
                    JSON.stringify(record.plan, null, 2),
                    'workflowStateJson:',
                    JSON.stringify(workflow.state, null, 2),
                    'workflowEventsJson:',
                    JSON.stringify(workflowEvents.map((event) => event.event), null, 2),
                ].join('\n');
                const toolChoice: IMastraGenerateOptions['toolChoice'] =
                    hasTools || Boolean(workspace) || Boolean(browser) ? 'auto' : 'none';
                const generateOptions: IMastraGenerateOptions = {
                    maxSteps: hasTools || Boolean(workspace) || Boolean(browser) ? 8 : 1,
                    toolChoice,
                    structuredOutput: {
                        schema: agentPlanValidationReportSchema,
                    },
                    memory,
                    ...(options.context?.signal ? { abortSignal: options.context.signal } : {}),
                    runId: requestedRunId,
                };
                const mastraMessages: TMastraChatMessage[] = [{ role: 'user', content: prompt }];
                const createRuntimeEvent = createRuntimeEventFactory({
                    runId: requestedRunId,
                    sessionId,
                    agentId: DEFAULT_VALIDATOR_AGENT_ID,
                    ...(this.now ? { now: this.now } : {}),
                });
                payloadEventSink.attachRuntimeEventFactory(createRuntimeEvent);
                attachMcpGatewayMetrics(mcpGatewayMetrics, console);
                pushUiEvent(events, createRuntimeEvent(createAcontextTokenEventDraft({
                    systemPrompt,
                    messages: mastraMessages,
                    contextReferences: input.context ?? [],
                    tools: mastraTools,
                    toolStats,
                    workspaceEnabled: Boolean(workspace),
                    browserEnabled: Boolean(browser),
                    memoryEnabled: true,
                    maxSteps: generateOptions.maxSteps ?? 1,
                    toolChoice,
                })), options);
                const generated = await agent.generate(mastraMessages, generateOptions);
                const report = parseValidationReport(generated.object);

                if (!report) {
                    return createErrorResponse(
                        sessionId,
                        'Validator 没有返回有效验证报告。',
                        events,
                        options,
                    );
                }

                const projectedWorkflow = await this.planWorkflowStore.reportValidator({
                    planId,
                    version,
                    report,
                });
                const result = report.needsReplan
                    ? `验证完成：${report.summary}，需要重新规划。`
                    : `验证完成：${report.summary}`;

                pushUiEvent(events, {
                    type: 'tool_result',
                    toolName: 'plan_validator',
                    output: toJsonValue({
                        report,
                        workflowPhase: projectedWorkflow.phase,
                        workflowStatus: projectedWorkflow.status,
                    }),
                }, options);
                pushUiEvent(events, createDoneOutputEvent(result), options);

                return {
                    sessionId,
                    events,
                    result,
                };
            });
        } catch (error) {
            return createErrorResponse(
                sessionId,
                `Validator 执行失败：${normalizeMastraError(error)}`,
                events,
                options,
            );
        } finally {
            await this.finalizePlanAgentRun(sessionId, requestedRunId, toolBundle);
        }
    }

    async replanPlan(
        input: IAgentRuntimeInput,
        options: IAgentRuntimeRunOptions = {},
    ): Promise<IAgentRuntimeResponse> {
        const sessionId = input.sessionId ?? createSessionId('mastra-plan-replan');
        const events: TAgentRuntimeOutputEvent[] = [];
        const prepared = await this.preparePlanAgentRun(
            input,
            sessionId,
            events,
            options,
            'mastra-plan-replanner-run',
            '重新规划需要 planId 和 planVersion。',
        );

        if (!prepared.ok) {
            return prepared.response;
        }

        const {
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
        } = prepared;
        const {
            tools: mastraTools,
            hasTools,
            toolStats,
            mcpGatewayMetrics,
            workspace,
            browser,
        } = toolBundle;

        try {
            return await runWithDeepSeekReasoningContext({
                sessionId,
                runId: requestedRunId,
                onRequestPayload: payloadEventSink.onRequestPayload,
            }, async () => {
                const systemPrompt = [
                    '你是 Plan Mode 的 Replanner Agent。',
                    '你只输出最小 delta plan，不重写已完成且仍然有效的步骤。',
                    'stepId 必须稳定：保留已有语义步骤 id，新步骤使用语义化 id，不使用数组下标含义。',
                    '必须返回 json object，并严格匹配结构化输出 schema。',
                ].join('\n');
                const agent = this.createAgent({
                    id: DEFAULT_REPLANNER_AGENT_ID,
                    name: 'Calamex Plan Replanner',
                    instructions: systemPrompt,
                    model: createMastraModelConfig(modelConfig),
                    memory: agentMemory,
                    ...(hasTools ? { tools: mastraTools } : {}),
                    ...(workspace ? { workspace } : {}),
                    ...(browser ? { browser } : {}),
                    inputProcessors: createMastraAgentInputProcessors(),
                    outputProcessors: createMastraAgentOutputProcessors(),
                });
                const prompt = [
                    '请基于验证结果生成最小 delta plan，返回 json object。',
                    `重新规划要求：${input.goal}`,
                    'originalPlanJson:',
                    JSON.stringify(record.plan, null, 2),
                    'workflowStateJson:',
                    JSON.stringify(workflow.state, null, 2),
                    'workflowEventsJson:',
                    JSON.stringify(workflowEvents.map((event) => event.event), null, 2),
                ].join('\n');
                const toolChoice: IMastraGenerateOptions['toolChoice'] =
                    hasTools || Boolean(workspace) || Boolean(browser) ? 'auto' : 'none';
                const generateOptions: IMastraGenerateOptions = {
                    maxSteps: hasTools || Boolean(workspace) || Boolean(browser) ? 8 : 1,
                    toolChoice,
                    structuredOutput: {
                        schema: agentPlanDeltaSchema,
                    },
                    memory,
                    ...(options.context?.signal ? { abortSignal: options.context.signal } : {}),
                    runId: requestedRunId,
                };
                const mastraMessages: TMastraChatMessage[] = [{ role: 'user', content: prompt }];
                const createRuntimeEvent = createRuntimeEventFactory({
                    runId: requestedRunId,
                    sessionId,
                    agentId: DEFAULT_REPLANNER_AGENT_ID,
                    ...(this.now ? { now: this.now } : {}),
                });
                payloadEventSink.attachRuntimeEventFactory(createRuntimeEvent);
                attachMcpGatewayMetrics(mcpGatewayMetrics, console);
                pushUiEvent(events, createRuntimeEvent(createAcontextTokenEventDraft({
                    systemPrompt,
                    messages: mastraMessages,
                    contextReferences: input.context ?? [],
                    tools: mastraTools,
                    toolStats,
                    workspaceEnabled: Boolean(workspace),
                    browserEnabled: Boolean(browser),
                    memoryEnabled: true,
                    maxSteps: generateOptions.maxSteps ?? 1,
                    toolChoice,
                })), options);
                const generated = await agent.generate(mastraMessages, generateOptions);
                const delta = parsePlanDelta(generated.object);

                if (!delta) {
                    return createErrorResponse(
                        sessionId,
                        'Replanner 没有返回有效 delta plan。',
                        events,
                        options,
                    );
                }

                const nextPlan = applyAgentPlanDelta(record.plan, delta);

                if (!nextPlan) {
                    return createErrorResponse(
                        sessionId,
                        'Replanner 生成的 delta plan 无法应用到当前计划。',
                        events,
                        options,
                    );
                }

                const nextRecord = await this.planStore.createPendingPlan({
                    planId: record.planId,
                    threadId: record.threadId,
                    userRequest: input.goal,
                    plan: nextPlan,
                });
                await this.planWorkflowStore.createForPlan({
                    record: nextRecord,
                    parentRunId: workflow.workflowRunId,
                    replanOfVersion: record.version,
                });
                await this.planWorkflowStore.issueReplan({
                    planId,
                    version,
                    toVersion: nextRecord.version,
                    delta,
                });

                pushUiEvent(events, {
                    type: 'tool_result',
                    toolName: 'plan_replanner',
                    output: toJsonValue({
                        fromVersion: record.version,
                        toVersion: nextRecord.version,
                        delta,
                    }),
                }, options);

                return createPlanResponse(sessionId, nextRecord, events, options);
            });
        } catch (error) {
            return createErrorResponse(
                sessionId,
                `Replanner 执行失败：${normalizeMastraError(error)}`,
                events,
                options,
            );
        } finally {
            await this.finalizePlanAgentRun(sessionId, requestedRunId, toolBundle);
        }
    }
}
