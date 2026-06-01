import { MastraRuntimeExecution } from '../execution.js';
import { createDeepSeekReasoningRunPrefix, evictDeepSeekReasoningByPrefix, runWithDeepSeekReasoningContext } from '../../models/providers/deepseek-reasoning-fetch.js';
import { decodeApprovalRequestId, isApprovedDecision } from './utils.js';
import { createDeepSeekPayloadEventSink } from '../budget/budget.js';
import { createExecutionRequestContext } from '../context/context.js';
import { normalizeMastraError } from '../messages.js';
import { createErrorResponse } from '../responses.js';
import { DEFAULT_EXECUTION_AGENT_ID } from '../types.js';
import type { IMastraAgentStreamLike, IMastraApprovalOptions } from '../types.js';
import { createRuntimeEventFactory, createSessionId, pushUiEvent } from '../utils.js';
import { allowWorkspaceWriteAfterVerifiedRead, destroyMastraBrowser, destroyMastraWorkspace } from '../workspace.js';
import type { IAgentRuntimeResponse, IAgentRuntimeRunOptions, TAgentRuntimeOutputEvent } from '../contracts/runtime-contracts.js';
import type { IApprovalResolutionInput } from '../contracts/runtime-input.js';


export class MastraRuntimeApproval extends MastraRuntimeExecution {
    async resolveApproval(
        input: IApprovalResolutionInput,
        options: IAgentRuntimeRunOptions = {},
    ): Promise<IAgentRuntimeResponse> {
        const decodedRequest = decodeApprovalRequestId(input.requestId);
        const cachedPending = this.pendingApprovals.get(input.requestId);
        const sessionId = cachedPending?.sessionId ?? input.sessionId ?? createSessionId('mastra-approval');

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
        const payloadEventSink = createDeepSeekPayloadEventSink(events, options);
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
            return await runWithDeepSeekReasoningContext({
                sessionId,
                runId: decodedRequest.runId,
                onRequestPayload: payloadEventSink.onRequestPayload,
            }, async () => {
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
                const createRuntimeEvent = createRuntimeEventFactory({
                    runId: stream.runId ?? decodedRequest.runId,
                    sessionId,
                    agentId: DEFAULT_EXECUTION_AGENT_ID,
                    ...(this.now ? { now: this.now } : {}),
                });
                payloadEventSink.attachRuntimeEventFactory(createRuntimeEvent);
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
                );
                shouldDisconnectBundle = streamSummary.releaseResources;

                if (streamSummary.streamErrorMessage) {
                    return createErrorResponse(
                        sessionId,
                        `Mastra Approval 执行失败：${streamSummary.streamErrorMessage}`,
                        events,
                        options,
                    );
                }

                if (streamSummary.pendingApproval) {
                    return {
                        sessionId,
                        events,
                        result: null,
                    };
                }

                const result = streamSummary.visibleText.trim().length > 0
                    ? streamSummary.visibleText
                    : 'Agent 已完成。';

                pushUiEvent(events, {
                    type: 'done',
                    result,
                }, options);

                return {
                    sessionId,
                    events,
                    result,
                };
            });
        } catch (error) {
            return createErrorResponse(
                sessionId,
                `Mastra Approval 执行失败：${normalizeMastraError(error)}`,
                events,
                options,
            );
        } finally {
            if (shouldDisconnectBundle) {
                evictDeepSeekReasoningByPrefix(
                    createDeepSeekReasoningRunPrefix(sessionId, decodedRequest.runId),
                );
                streamCleanup?.();
                await pending.bundle.disconnectAll();
                await destroyMastraWorkspace(pending.workspace);
                await destroyMastraBrowser(pending.browser);
            }
        }
    }
}
