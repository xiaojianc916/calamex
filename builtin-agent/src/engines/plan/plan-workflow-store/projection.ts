import type {
    TAgentPlanWorkflowEventRecord,
    TAgentPlanWorkflowRecord,
    TAgentPlanWorkflowState,
    TAgentPlanWorkflowStatus,
} from '../../../schemas/plan-workflow.js';

// -----------------------------------------------------------------------------
// Projection
// -----------------------------------------------------------------------------

export class WorkflowProjection {
    status: TAgentPlanWorkflowStatus = 'waiting_approval';
    phase: TAgentPlanWorkflowRecord['phase'] = 'approval_gate';
    currentStepId: string | null = null;
    mastraRunId: string | null = null;
    suspendedAt: string | null = null;
    resumedAt: string | null = null;
    finishedAt: string | null = null;
    errorMessage: string | null = null;
    state: TAgentPlanWorkflowState;

    constructor(initialState: TAgentPlanWorkflowState) {
        this.state = initialState;
    }
}

export const projectWorkflow = (
    initialState: TAgentPlanWorkflowState,
    events: TAgentPlanWorkflowEventRecord[],
): WorkflowProjection => {
    const projection = new WorkflowProjection(initialState);
    for (const eventRecord of events) {
        const { event } = eventRecord;
        switch (event.type) {
            case 'PlanGenerated':
                projection.status = 'waiting_approval';
                projection.phase = 'approval_gate';
                projection.state.approvedPlanHash = event.planHash;
                projection.state.stepIds = event.stepIds;
                break;
            case 'PlanApproved':
                projection.status = 'approved';
                projection.phase = 'execute_plan';
                projection.state.approval.approved = true;
                projection.state.approvedPlanHash = event.approvedHash;
                break;
            case 'StepStarted':
                projection.status = 'executing';
                projection.phase = 'execute_plan';
                projection.currentStepId = event.stepId;
                projection.mastraRunId = event.mastraRunId;
                projection.state.currentStepId = event.stepId;
                projection.state.stepIdempotencyKeys[event.stepId] = event.idempotencyKey;
                projection.state.lastHeartbeatAt = eventRecord.createdAt;
                break;
            case 'StepCompleted': {
                projection.state.completedStepIds = [
                    ...new Set([...projection.state.completedStepIds, event.stepId]),
                ];
                projection.state.failedStepIds = projection.state.failedStepIds.filter(
                    (stepId) => stepId !== event.stepId,
                );
                projection.state.executionCursor = projection.state.stepIds.reduce(
                    (cursor, stepId, index) =>
                        projection.state.completedStepIds.includes(stepId)
                            ? Math.max(cursor, index + 1)
                            : cursor,
                    0,
                );
                projection.state.lastHeartbeatAt = eventRecord.createdAt;
                if (projection.currentStepId === event.stepId) {
                    projection.currentStepId = null;
                    projection.state.currentStepId = null;
                }
                if (projection.state.executionCursor >= projection.state.stepIds.length) {
                    projection.phase = 'validate_result';
                }
                break;
            }
            case 'StepFailed':
                projection.status = 'failed';
                projection.phase = 'execute_plan';
                projection.errorMessage = event.error;
                projection.state.failedStepIds = [
                    ...new Set([...projection.state.failedStepIds, event.stepId]),
                ];
                projection.state.lastHeartbeatAt = eventRecord.createdAt;
                break;
            case 'ValidatorReported':
                projection.phase = 'validate_result';
                projection.state.validator.status = event.report.status;
                projection.state.validator.summary = event.report.summary;
                projection.state.validator.needsReplan = event.report.needsReplan;
                break;
            case 'ReplanIssued':
                projection.phase = 'replan';
                projection.state.replanOfVersion = event.fromVersion;
                break;
            case 'Suspended':
                // status 不变：suspend 是与生命周期正交的暂停标记，由
                // state.suspend.reason 表达。plan_approval 的"初始暂停"由
                // PlanGenerated 设置的 waiting_approval 状态自然承担。
                if (event.reason === 'validator_needs_replan') {
                    projection.phase = 'replan';
                }
                projection.suspendedAt = eventRecord.createdAt;
                projection.state.suspend = {
                    reason: event.reason,
                    token: event.token,
                    payload: event.payload,
                    expiresAt: event.expiresAt,
                    resumeContract: event.resumeContract,
                };
                break;
            case 'Resumed':
                projection.resumedAt = eventRecord.createdAt;
                projection.state.suspend = {
                    reason: null,
                    token: null,
                    payload: null,
                    expiresAt: null,
                    resumeContract: null,
                };
                break;
            case 'Heartbeat':
                projection.state.lastHeartbeatAt = eventRecord.createdAt;
                break;
            case 'PlanFinished':
                projection.status = event.status;
                projection.phase = 'finish';
                projection.finishedAt = eventRecord.createdAt;
                projection.errorMessage = event.errorMessage;
                projection.state.approval.rejected = event.status === 'rejected';
                break;
        }
    }
    return projection;
};
