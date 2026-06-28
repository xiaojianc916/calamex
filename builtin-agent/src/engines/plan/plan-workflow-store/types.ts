import type {
    TAgentPlanDelta,
    TAgentPlanValidationReport,
    TAgentPlanWorkflowEventRecord,
    TAgentPlanWorkflowRecord,
    TAgentPlanWorkflowStatus,
    TAgentPlanWorkflowSuspendReason,
} from '../../../schemas/plan-workflow.js';
import type { TAgentPlanRecord } from '../../../schemas/plan.js';
import type { JSONValue } from '../../../types/json-value.js';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface IPlanWorkflowVersionInput {
    planId: string;
    version: number;
}

export interface ICreatePlanWorkflowInput {
    record: TAgentPlanRecord;
    parentRunId?: string | undefined;
    replanOfVersion?: number | undefined;
}

export interface IStartPlanWorkflowStepInput extends IPlanWorkflowVersionInput {
    stepId: string;
    mastraRunId?: string | undefined;
}

export interface ICompletePlanWorkflowStepInput extends IPlanWorkflowVersionInput {
    stepId: string;
    resultRef?: string | undefined;
}

export interface IFailPlanWorkflowStepInput extends IPlanWorkflowVersionInput {
    stepId: string;
    error: string;
    retryable: boolean;
}

export interface IHeartbeatPlanWorkflowInput extends IPlanWorkflowVersionInput {
    stepId?: string | undefined;
    phase: 'before_tool' | 'after_tool' | 'step_start' | 'step_end';
}

export interface ISuspendPlanWorkflowInput extends IPlanWorkflowVersionInput {
    reason: TAgentPlanWorkflowSuspendReason;
    payload?: JSONValue | undefined;
    expiresAt?: string | undefined;
    allowedFields?: string[] | undefined;
}

export interface IFinishPlanWorkflowInput extends IPlanWorkflowVersionInput {
    status: Extract<TAgentPlanWorkflowStatus, 'completed' | 'failed' | 'rejected' | 'cancelled'>;
    errorMessage?: string | undefined;
}

export interface IReportPlanValidatorInput extends IPlanWorkflowVersionInput {
    report: TAgentPlanValidationReport;
}

export interface IIssuePlanReplanInput extends IPlanWorkflowVersionInput {
    toVersion: number;
    delta: TAgentPlanDelta;
    deltaRef?: string | undefined;
}

export interface IAgentPlanWorkflowStore {
    createForPlan(input: ICreatePlanWorkflowInput): Promise<TAgentPlanWorkflowRecord>;
    getWorkflow(input: IPlanWorkflowVersionInput): Promise<TAgentPlanWorkflowRecord>;
    listEvents(input: IPlanWorkflowVersionInput): Promise<TAgentPlanWorkflowEventRecord[]>;
    approvePlan(record: TAgentPlanRecord, approvedBy?: string | undefined): Promise<TAgentPlanWorkflowRecord>;
    rejectPlan(record: TAgentPlanRecord, reason?: string | undefined): Promise<TAgentPlanWorkflowRecord>;
    startStep(input: IStartPlanWorkflowStepInput): Promise<TAgentPlanWorkflowRecord>;
    completeStep(input: ICompletePlanWorkflowStepInput): Promise<TAgentPlanWorkflowRecord>;
    failStep(input: IFailPlanWorkflowStepInput): Promise<TAgentPlanWorkflowRecord>;
    heartbeat(input: IHeartbeatPlanWorkflowInput): Promise<TAgentPlanWorkflowRecord>;
    suspend(input: ISuspendPlanWorkflowInput): Promise<TAgentPlanWorkflowRecord>;
    reportValidator(input: IReportPlanValidatorInput): Promise<TAgentPlanWorkflowRecord>;
    issueReplan(input: IIssuePlanReplanInput): Promise<TAgentPlanWorkflowRecord>;
    finishPlan(input: IFinishPlanWorkflowInput): Promise<TAgentPlanWorkflowRecord>;
    close(): Promise<void>;
}
