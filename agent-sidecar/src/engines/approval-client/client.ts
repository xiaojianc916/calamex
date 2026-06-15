import { MastraRuntimeExecution } from '../execution.js';
import { decodeApprovalRequestId, isApprovedDecision } from './utils.js';
import { createExecutionRequestContext } from '../context/context.js';
import { normalizeMastraError } from '../errors.js';
import { createErrorResponse } from '../responses.js';
import { DEFAULT_EXECUTION_AGENT_ID } from '../types.js';
import type { IMastraAgentStreamLike, IMastraApprovalOptions, IPlanWorkflowStepTracker, TMastraToolResumeData } from '../types.js';
import { createRuntimeEventFactory, createRuntimePreview, createSessionId, pushUiEvent, toNonEmptyString } from '../utils.js';
import { allowWorkspaceWriteAfterVerifiedRead, destroyMastraBrowser, destroyMastraWorkspace } from '../workspace.js';
import type { IAgentRuntimeResponse, IAgentRuntimeRunOptions, TAgentRuntimeOutputEvent } from '../contracts/runtime-contracts.js';
import type { IApprovalResolutionInput, IAskUserResolutionInput } from '../contracts/runtime-input.js';


export class MastraRuntimeApproval extends MastraRuntimeExecution {
    async resolveApproval(
        input: IApprovalResolutionInput,
        options: IAgentRuntimeRunOptions = {},
    ): Promise<IAgentRuntimeResponse> {
        const decodedRequest = decodeApprovalRequestId(input.requestId);
        const cachedPending = this.pendingApprovals.get(input.requestId);
        const sessionId = cachedPending?.sessionId ?? input.sessionId ?? createSessionId('mastra-approval');
        // 审批回执自身携带计划三元组（见 /approval/resolve schema），据此把 execute()
        // 在挂起时留下的 libSQL 工作流步骤恢复推进；缺三元组（纯 chat 审批）时为 null。
        const workflowTracker = this.resolveWorkflowTracker(input);

        if (!decodedRequest) {
            return this.createFallbackApprovalResponse(input, sessionId, options);
        }

        const approvalContext = cachedPending
            ? {
                pending: cachedPending,
                systemPrompt: '',
            }
            : await this.createResumableApprovalContext(input, sessionId, decodedRequest);

        if (!approvalContext) {
            return this.createFallbackApprovalResponse(input, sessionId, options);
        }

        if (cachedPending) {
            this.pendingApprovals.delete(input.requestId);
            this.clearPendingApprovalTimer(input.requestId);
        }

        const { pending } = approvalContext;

        const approvalContinueStream = isApprovedDecision(input.decision)
            ? pending.agent.approveToolCall
            : pending.agent.declineToolCall;
        const resumeContinueStream = pending.agent.resumeStream;
        const canContinue = pending.kind === 'suspended'
            ? typeof resumeContinueStream === 'function'
            : typeof resumeContinueStream === 'function' || typeof approvalContinueStream === 'function';

        if (!canContinue) {
            await pending.bundle.disconnectAll();
            await destroyMastraWorkspace(pending.workspace);
            await destroyMastraBrowser(pending.browser);
            return this.createFallbackApprovalResponse(input, sessionId, options);
        }

        const events: TAgentRuntimeOutputEvent[] = [];
        let shouldDisconnectBundle = true;
        let streamCleanup: (() => void) | undefined;
        const continueSuspendedStream = resumeContinueStream;
        if (
            pending.kind === 'approval' &&
            typeof resumeContinueStream !== 'function' &&
            typeof approvalContinueStream !== 'function'
        ) {
            await pending.bundle.disconnectAll();
            await destroyMastraWorkspace(pending.workspace);
            await destroyMastraBrowser(pending.browser);
            return this.createFallbackApprovalResponse(input, sessionId, options);
        }
        if (pending.kind === 'suspended' && typeof continueSuspendedStream !== 'function') {
            await pending.bundle.disconnectAll();
            await destroyMastraWorkspace(pending.workspace);
            await destroyMastraBrowser(pending.browser);
            return this.createFallbackApprovalResponse(input, sessionId, options);
        }
        const resumeSuspendedTool = continueSuspendedStream;
        const resumeApprovalRun = resumeContinueStream;
        const resumeApprovalTool = approvalContinueStream;

        try {
            let stream: IMastraAgentStreamLike;
            const resumeOptions: IMastraApprovalOptions = {
                runId: decodedRequest.runId,
                toolCallId: decodedRequest.toolCallId,
                ...(options.context?.signal ? { abortSignal: options.context.signal } : {}),
                ...(approvalContext.memory ? { memory: approvalContext.memory } : {}),
                ...(approvalContext.memory && approvalContext.systemPrompt ? {
                    requestContext: createExecutionRequestContext(
                        {
                            mode: 'agent',
                            goal: input.goal?.trim() || '继续当前任务',
                            messages: input.messages ?? [],
                            context: input.context ?? [],
                            ...(input.workspaceRootPath ? { workspaceRootPath: input.workspaceRootPath } : {}),
                            ...(input.threadId ? { threadId: input.threadId } : {}),
                            ...(input.planId ? { planId: input.planId } : {}),
                            ...(input.planVersion ? { planVersion: input.planVersion } : {}),
                            ...(input.planStepId ? { planStepId: input.planStepId } : {}),
                        },
                        approvalContext.systemPrompt,
                        approvalContext.memory,
                        approvalContext.approvedPlanRecord,
                    ),
                } : {}),
            };

            if (isApprovedDecision(input.decision)) {
                await allowWorkspaceWriteAfterVerifiedRead(pending.workspace, pending.approvedPath);
            }

            if (pending.kind === 'suspended') {
                if (typeof resumeSuspendedTool !== 'function') {
                    throw new Error('Mastra suspended tool resumeStream 不可用。');
                }

                stream = await resumeSuspendedTool({
                    approved: isApprovedDecision(input.decision),
                }, resumeOptions);
            } else if (typeof resumeApprovalRun === 'function') {
                stream = await resumeApprovalRun({
                    approved: isApprovedDecision(input.decision),
                }, resumeOptions);
            } else {
                if (typeof resumeApprovalTool !== 'function') {
                    throw new Error('Mastra approval resume 不可用。');
                }

                stream = await resumeApprovalTool(resumeOptions);
            }
            streamCleanup = stream.cleanup;
            const resumedRunId = stream.runId ?? decodedRequest.runId;
            const createRuntimeEvent = createRuntimeEventFactory({
                runId: resumedRunId,
                sessionId,
                agentId: DEFAULT_EXECUTION_AGENT_ID,
                ...(this.now ? { now: this.now } : {}),
            });
            const streamSummary = await this.consumeTextStream(
                pending.agent,
                pending.bundle,
                sessionId,
                stream,
                events,
                options,
                createRuntimeEvent,
                pending.workspace,
                pending.browser,
                workflowTracker ?? undefined,
            );
            shouldDisconnectBundle = streamSummary.releaseResources;

            if (streamSummary.streamErrorMessage) {
                if (workflowTracker) {
                    await this.planWorkflowStore.failStep({
                        ...workflowTracker,
                        error: streamSummary.streamErrorMessage,
                        retryable: true,
                    }).catch(() => undefined);
                }
                return createErrorResponse(
                    sessionId,
                    `Mastra Approval 执行失败：${streamSummary.streamErrorMessage}`,
                    events,
                    options,
                );
            }

            if (streamSummary.pendingApproval) {
                // 链式审批：又有工具需要批准，与 execute() 一致地重新挂起工作流步骤。
                if (workflowTracker) {
                    await this.planWorkflowStore.suspend({
                        planId: workflowTracker.planId,
                        version: workflowTracker.version,
                        reason: 'tool_external_wait',
                        payload: {
                            stepId: workflowTracker.stepId,
                            runId: resumedRunId,
                        },
                        allowedFields: ['decision', 'requestId'],
                    }).catch(() => undefined);
                }
                return {
                    sessionId,
                    events,
                    result: null,
                };
            }

            const result = streamSummary.visibleText.trim().length > 0
                ? streamSummary.visibleText
                : 'Agent 已完成。';

            // 闭环关键：审批恢复后必须对称地推进 libSQL 工作流，完成该步骤、前移
            // executionCursor，否则计划主线永远停在 executing/tool_external_wait。
            // 工作流协调采用尽力而为：其失败不得影响用户已成功获得的工具执行结果。
            if (workflowTracker) {
                await this.planWorkflowStore.completeStep({
                    ...workflowTracker,
                    resultRef: resumedRunId,
                }).catch(() => undefined);
            }

            return {
                sessionId,
                events,
                result,
                ...(streamSummary.doneTokenSnapshot ? { usage: streamSummary.doneTokenSnapshot } : {}),
            };
        } catch (error) {
            if (workflowTracker) {
                await this.planWorkflowStore.failStep({
                    ...workflowTracker,
                    error: normalizeMastraError(error),
                    retryable: true,
                }).catch(() => undefined);
            }
            return createErrorResponse(
                sessionId,
                `Mastra Approval 执行失败：${normalizeMastraError(error)}`,
                events,
                options,
            );
        } finally {
            if (shouldDisconnectBundle) {
                streamCleanup?.();
                await pending.bundle.disconnectAll();
                await destroyMastraWorkspace(pending.workspace);
                await destroyMastraBrowser(pending.browser);
            }
        }
    }

    /**
     * 恢复一个被 ask_user（HITL 反向提问）挂起的工具调用。这是 resolveApproval 的姊妹
     * 方法：ask_user 挂起恒为 suspended 工具（见 base.ts consumeTextStream 的
     * ask_user_required 分支），故此处只走 resumeStream 续跑单分支，不涉及 approve/
     * decline 气泡，也无需审批专属的「已验证读后放开写」闸门。用户回填的 outcome +
     * 结构化 answers 原样经 resumeData 回灌挂起工具（即 ask_user 工具 resumeSchema 的
     * 形状）；缓存未命中时按 toApprovalResolutionInput 重建上下文，恢复链路与审批一致。
     */
    async resolveAskUser(
        input: IAskUserResolutionInput,
        options: IAgentRuntimeRunOptions = {},
    ): Promise<IAgentRuntimeResponse> {
        const decodedRequest = decodeApprovalRequestId(input.requestId);
        const cachedPending = this.pendingApprovals.get(input.requestId);
        const sessionId = cachedPending?.sessionId ?? input.sessionId ?? createSessionId('mastra-ask-user');
        const workflowTracker = this.resolveWorkflowTracker(input);

        if (!decodedRequest) {
            return this.buildFallbackAskUserResponse(input, sessionId, options);
        }

        const approvalContext = cachedPending
            ? {
                pending: cachedPending,
                systemPrompt: '',
            }
            : await this.createResumableApprovalContext(
                this.toApprovalResolutionInput(input),
                sessionId,
                decodedRequest,
            );

        if (!approvalContext) {
            return this.buildFallbackAskUserResponse(input, sessionId, options);
        }

        if (cachedPending) {
            this.pendingApprovals.delete(input.requestId);
            this.clearPendingApprovalTimer(input.requestId);
        }

        const { pending } = approvalContext;
        const resumeSuspendedTool = pending.agent.resumeStream;

        if (typeof resumeSuspendedTool !== 'function') {
            await pending.bundle.disconnectAll();
            await destroyMastraWorkspace(pending.workspace);
            await destroyMastraBrowser(pending.browser);
            return this.buildFallbackAskUserResponse(input, sessionId, options);
        }

        const events: TAgentRuntimeOutputEvent[] = [];
        let shouldDisconnectBundle = true;
        let streamCleanup: (() => void) | undefined;

        try {
            const resumeOptions: IMastraApprovalOptions = {
                runId: decodedRequest.runId,
                toolCallId: decodedRequest.toolCallId,
                ...(options.context?.signal ? { abortSignal: options.context.signal } : {}),
                ...(approvalContext.memory ? { memory: approvalContext.memory } : {}),
                ...(approvalContext.memory && approvalContext.systemPrompt ? {
                    requestContext: createExecutionRequestContext(
                        {
                            mode: 'agent',
                            goal: input.goal?.trim() || '继续当前任务',
                            messages: input.messages ?? [],
                            context: input.context ?? [],
                            ...(input.workspaceRootPath ? { workspaceRootPath: input.workspaceRootPath } : {}),
                            ...(input.threadId ? { threadId: input.threadId } : {}),
                            ...(input.planId ? { planId: input.planId } : {}),
                            ...(input.planVersion ? { planVersion: input.planVersion } : {}),
                            ...(input.planStepId ? { planStepId: input.planStepId } : {}),
                        },
                        approvalContext.systemPrompt,
                        approvalContext.memory,
                        approvalContext.approvedPlanRecord,
                    ),
                } : {}),
            };

            // 回灌挂起 ask_user 工具的恢复负载：与该工具 resumeSchema 同形（outcome +
            // 可选结构化 answers）。answers 逐项规范化，text 仅在确有自由文本时携带。
            const resumeData: TMastraToolResumeData = {
                outcome: input.outcome,
                ...(input.answers ? {
                    answers: input.answers.map((answer) => ({
                        questionId: answer.questionId,
                        optionIds: answer.optionIds,
                        ...(answer.text !== undefined ? { text: answer.text } : {}),
                    })),
                } : {}),
            };

            const stream = await resumeSuspendedTool(resumeData, resumeOptions);
            streamCleanup = stream.cleanup;
            const resumedRunId = stream.runId ?? decodedRequest.runId;
            const createRuntimeEvent = createRuntimeEventFactory({
                runId: resumedRunId,
                sessionId,
                agentId: DEFAULT_EXECUTION_AGENT_ID,
                ...(this.now ? { now: this.now } : {}),
            });
            const streamSummary = await this.consumeTextStream(
                pending.agent,
                pending.bundle,
                sessionId,
                stream,
                events,
                options,
                createRuntimeEvent,
                pending.workspace,
                pending.browser,
                workflowTracker ?? undefined,
            );
            shouldDisconnectBundle = streamSummary.releaseResources;

            if (streamSummary.streamErrorMessage) {
                if (workflowTracker) {
                    await this.planWorkflowStore.failStep({
                        ...workflowTracker,
                        error: streamSummary.streamErrorMessage,
                        retryable: true,
                    }).catch(() => undefined);
                }
                return createErrorResponse(
                    sessionId,
                    `Mastra ask_user 恢复执行失败：${streamSummary.streamErrorMessage}`,
                    events,
                    options,
                );
            }

            if (streamSummary.pendingApproval) {
                // 续跑后又触发新的挂起（再次 ask_user 或工具审批）：与 execute()/resolveApproval
                // 一致地重新挂起工作流步骤，本回合结束、等待下一次回执。
                if (workflowTracker) {
                    await this.planWorkflowStore.suspend({
                        planId: workflowTracker.planId,
                        version: workflowTracker.version,
                        reason: 'tool_external_wait',
                        payload: {
                            stepId: workflowTracker.stepId,
                            runId: resumedRunId,
                        },
                        allowedFields: ['decision', 'requestId'],
                    }).catch(() => undefined);
                }
                return {
                    sessionId,
                    events,
                    result: null,
                };
            }

            const result = streamSummary.visibleText.trim().length > 0
                ? streamSummary.visibleText
                : 'Agent 已完成。';

            if (workflowTracker) {
                await this.planWorkflowStore.completeStep({
                    ...workflowTracker,
                    resultRef: resumedRunId,
                }).catch(() => undefined);
            }

            return {
                sessionId,
                events,
                result,
                ...(streamSummary.doneTokenSnapshot ? { usage: streamSummary.doneTokenSnapshot } : {}),
            };
        } catch (error) {
            if (workflowTracker) {
                await this.planWorkflowStore.failStep({
                    ...workflowTracker,
                    error: normalizeMastraError(error),
                    retryable: true,
                }).catch(() => undefined);
            }
            return createErrorResponse(
                sessionId,
                `Mastra ask_user 恢复执行失败：${normalizeMastraError(error)}`,
                events,
                options,
            );
        } finally {
            if (shouldDisconnectBundle) {
                streamCleanup?.();
                await pending.bundle.disconnectAll();
                await destroyMastraWorkspace(pending.workspace);
                await destroyMastraBrowser(pending.browser);
            }
        }
    }

    /**
     * 从恢复回执还原计划工作流步骤坐标（planId/version/stepId）。审批与 ask_user 两类
     * 回执都带这同一计划三元组，故采用结构化入参共享：仅当三元组齐备且 version 为正整数
     * 时返回；否则返回 null，调用方据此跳过工作流状态机推进（例如不绑定计划的纯 chat 场景）。
     */
    private resolveWorkflowTracker(
        input: { planId?: string | undefined; planStepId?: string | undefined; planVersion?: number | undefined },
    ): IPlanWorkflowStepTracker | null {
        const planId = toNonEmptyString(input.planId);
        const stepId = toNonEmptyString(input.planStepId);
        const version = input.planVersion;
        if (!planId || !stepId || !Number.isInteger(version) || Number(version) <= 0) {
            return null;
        }
        return { planId, version: Number(version), stepId };
    }

    /**
     * 把 ask_user 回执投影为审批输入形状，仅用于在缓存未命中时复用
     * createResumableApprovalContext 重建挂起上下文。该重建只读取会话/计划相关字段
     * （goal、messages、context、workspaceRootPath、threadId、modelConfig 及计划三元组），
     * 从不读取 decision，故此处的 'approve' 仅为满足类型的占位，不影响重建语义。
     */
    private toApprovalResolutionInput(input: IAskUserResolutionInput): IApprovalResolutionInput {
        return {
            requestId: input.requestId,
            decision: 'approve',
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input.goal !== undefined ? { goal: input.goal } : {}),
            ...(input.messages ? { messages: input.messages } : {}),
            ...(input.workspaceRootPath !== undefined ? { workspaceRootPath: input.workspaceRootPath } : {}),
            ...(input.context ? { context: input.context } : {}),
            ...(input.modelConfig ? { modelConfig: input.modelConfig } : {}),
            ...(input.threadId ? { threadId: input.threadId } : {}),
            ...(input.planId ? { planId: input.planId } : {}),
            ...(input.planVersion ? { planVersion: input.planVersion } : {}),
            ...(input.planStepId ? { planStepId: input.planStepId } : {}),
        };
    }

    /**
     * ask_user 无法恢复时（requestId 解码失败 / 上下文重建失败 / resumeStream 不可用）的
     * 优雅兜底，镜像 createFallbackApprovalResponse：复用审批 token 中的真实 runId 保持链路
     * 元数据一致，发一条 ask_user 工具完成事件（仅承载 requestId + outcome），返回非错误结果，
     * 等待下一次 Agent 执行继续消费。
     */
    private buildFallbackAskUserResponse(
        input: IAskUserResolutionInput,
        sessionId: string,
        options: IAgentRuntimeRunOptions,
    ): IAgentRuntimeResponse {
        const result = '提问回执已记录，等待下一次 Agent 执行继续消费。';
        const events: TAgentRuntimeOutputEvent[] = [];

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
            toolName: 'ask_user',
            ok: true,
            resultPreview: createRuntimePreview({
                requestId: input.requestId,
                outcome: input.outcome,
            }),
        }), options);

        return {
            sessionId,
            events,
            result,
        };
    }
}
