import { createHash, randomUUID } from 'node:crypto';

import type { Row } from '@libsql/client';

import {
    AGENT_PLAN_WORKFLOW_EVENT_SCHEMA_VERSION,
    agentPlanWorkflowEventRecordSchema,
    agentPlanWorkflowEventSchema,
    agentPlanWorkflowRecordSchema,
    agentPlanWorkflowStateSchema,
    type TAgentPlanWorkflowEvent,
    type TAgentPlanWorkflowEventRecord,
    type TAgentPlanWorkflowRecord,
    type TAgentPlanWorkflowState,
    type TAgentPlanWorkflowSuspendReason,
} from '../../../schemas/plan-workflow.js';
import {
    agentPlanSchema,
    type TAgentPlanRecord,
} from '../../../schemas/plan.js';

import type { IPlanWorkflowVersionInput } from './types.js';
import {
    parseJsonValue,
    rowInteger,
    rowNullableString,
    rowString,
} from './row-helpers.js';

// -----------------------------------------------------------------------------
// Serialization / hashing / record mapping helpers
// -----------------------------------------------------------------------------

export const parseWorkflowState = (value: string): TAgentPlanWorkflowState =>
    agentPlanWorkflowStateSchema.parse(parseJsonValue(value));

export const serializeWorkflowState = (state: TAgentPlanWorkflowState): string =>
    JSON.stringify(agentPlanWorkflowStateSchema.parse(state));

export const parseWorkflowEvent = (value: string): TAgentPlanWorkflowEvent =>
    agentPlanWorkflowEventSchema.parse(parseJsonValue(value));

export const serializeWorkflowEvent = (event: TAgentPlanWorkflowEvent): string =>
    JSON.stringify(agentPlanWorkflowEventSchema.parse(event));

export const hashApprovedPlan = (record: TAgentPlanRecord): string =>
    createHash('sha256')
        .update(JSON.stringify(agentPlanSchema.parse(record.plan)))
        .digest('hex');

export const createStepIdempotencyKey = (
    input: IPlanWorkflowVersionInput & { stepId: string },
): string => `${input.planId}:v${input.version}:step:${input.stepId}`;

export const createSuspendToken = (
    input: IPlanWorkflowVersionInput & { reason: TAgentPlanWorkflowSuspendReason },
): string => `${input.planId}:v${input.version}:suspend:${input.reason}:${randomUUID()}`;

export const buildDefaultResumeContract = (): { allowedFields: string[] } => ({
    allowedFields: ['decision', 'approvedBy', 'reason'],
});

export const toWorkflowRecord = (row: Row): TAgentPlanWorkflowRecord =>
    agentPlanWorkflowRecordSchema.parse({
        workflowRunId: rowString(row, 'workflow_run_id'),
        planId: rowString(row, 'plan_id'),
        planVersion: rowInteger(row, 'plan_version', { min: 1 }),
        threadId: rowString(row, 'thread_id'),
        status: rowString(row, 'status'),
        phase: rowString(row, 'phase'),
        currentStepId: rowNullableString(row, 'current_step_id'),
        mastraRunId: rowNullableString(row, 'mastra_run_id'),
        createdAt: rowString(row, 'created_at'),
        updatedAt: rowString(row, 'updated_at'),
        suspendedAt: rowNullableString(row, 'suspended_at'),
        resumedAt: rowNullableString(row, 'resumed_at'),
        finishedAt: rowNullableString(row, 'finished_at'),
        errorMessage: rowNullableString(row, 'error_message'),
        state: parseWorkflowState(rowString(row, 'state_json')),
    });

export const toWorkflowEventRecord = (row: Row): TAgentPlanWorkflowEventRecord =>
    agentPlanWorkflowEventRecordSchema.parse({
        eventId: rowString(row, 'event_id'),
        eventSchemaVersion: AGENT_PLAN_WORKFLOW_EVENT_SCHEMA_VERSION,
        workflowRunId: rowString(row, 'workflow_run_id'),
        planId: rowString(row, 'plan_id'),
        planVersion: rowInteger(row, 'plan_version', { min: 1 }),
        seq: rowInteger(row, 'seq', { min: 0 }),
        createdAt: rowString(row, 'created_at'),
        event: parseWorkflowEvent(rowString(row, 'event_json')),
    });

export const createInitialState = (
    record: TAgentPlanRecord,
    planHash: string,
    parentRunId: string | null,
    replanOfVersion: number | null,
): TAgentPlanWorkflowState => {
    const stepIds = record.plan.steps.map((step) => step.id);
    const stepIdempotencyKeys = Object.fromEntries(
        stepIds.map((stepId) => [
            stepId,
            createStepIdempotencyKey({
                planId: record.planId,
                version: record.version,
                stepId,
            }),
        ]),
    );

    return agentPlanWorkflowStateSchema.parse({
        planId: record.planId,
        planVersion: record.version,
        threadId: record.threadId,
        stepIds,
        stepIdempotencyKeys,
        executionCursor: 0,
        approvedPlanHash: planHash,
        currentStepId: null,
        completedStepIds: [],
        failedStepIds: [],
        lastHeartbeatAt: null,
        parentRunId,
        replanOfVersion,
        suspend: {
            reason: null,
            token: null,
            payload: null,
            expiresAt: null,
            resumeContract: null,
        },
        approval: {
            required: true,
            approved: false,
            rejected: false,
            reason: null,
        },
        validator: {
            status: 'pending',
            summary: null,
            needsReplan: false,
        },
    });
};
