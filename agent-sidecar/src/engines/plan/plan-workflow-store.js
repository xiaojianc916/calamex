import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@libsql/client';
import { agentPlanWorkflowEventRecordSchema, agentPlanWorkflowEventSchema, agentPlanWorkflowRecordSchema, agentPlanWorkflowStateSchema, } from '../../schemas/plan-workflow.js';
import { agentPlanSchema, } from '../../schemas/plan.js';
import { resolveMastraStorageUrl } from '../context/memory.js';
// -----------------------------------------------------------------------------
// Schema constants
// -----------------------------------------------------------------------------
const WORKFLOW_RUN_TABLE = 'agent_plan_workflow_runs';
const WORKFLOW_EVENT_TABLE = 'agent_plan_workflow_events';
const WORKFLOW_META_TABLE = 'agent_plan_workflow_meta';
const WORKFLOW_SCHEMA_VERSION = 1;
const WORKFLOW_RUN_SELECT_FIELDS = [
    'workflow_run_id', 'plan_id', 'plan_version', 'thread_id',
    'status', 'phase', 'current_step_id', 'execution_cursor',
    'approved_plan_hash', 'last_heartbeat_at',
    'parent_run_id', 'replan_of_version',
    'suspend_reason', 'suspend_token', 'mastra_run_id',
    'created_at', 'updated_at',
    'suspended_at', 'resumed_at', 'finished_at',
    'error_message', 'state_json', 'revision',
].join(', ');
const WORKFLOW_EVENT_SELECT_FIELDS = [
    'event_id', 'workflow_run_id', 'plan_id', 'plan_version',
    'seq', 'created_at', 'event_json',
].join(', ');
const ACTIVE_STATUSES = new Set([
    'waiting_approval',
    'approved',
    'executing',
]);
// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
const toNonEmptyString = (value) => {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};
const rowString = (row, key) => {
    const value = row[key];
    if (typeof value !== 'string') {
        throw new Error(`计划 workflow 字段 ${key} 不是字符串。`);
    }
    return value;
};
const rowNullableString = (row, key) => {
    const value = row[key];
    if (value === null)
        return null;
    if (typeof value !== 'string') {
        throw new Error(`计划 workflow 字段 ${key} 不是字符串或 null。`);
    }
    return value;
};
const rowInteger = (row, key, { min }) => {
    const value = row[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= min) {
        return value;
    }
    if (typeof value === 'bigint' && value >= BigInt(min) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(value);
    }
    throw new Error(`计划 workflow 字段 ${key} 不是 >= ${min} 的整数。`);
};
const parseJsonValue = (value) => JSON.parse(value);
const toRecord = (value) => value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
const normalizeWorkflowStateInput = (value) => {
    const record = toRecord(value);
    const validator = toRecord(record?.validator);
    if (!record || !validator || 'needsReplan' in validator) {
        return value;
    }
    return {
        ...record,
        validator: { ...validator, needsReplan: false },
    };
};
const parseWorkflowState = (value) => agentPlanWorkflowStateSchema.parse(normalizeWorkflowStateInput(parseJsonValue(value)));
const serializeWorkflowState = (state) => JSON.stringify(agentPlanWorkflowStateSchema.parse(state));
const parseWorkflowEvent = (value) => agentPlanWorkflowEventSchema.parse(parseJsonValue(value));
const serializeWorkflowEvent = (event) => JSON.stringify(agentPlanWorkflowEventSchema.parse(event));
const hashApprovedPlan = (record) => createHash('sha256')
    .update(JSON.stringify(agentPlanSchema.parse(record.plan)))
    .digest('hex');
const createStepIdempotencyKey = (input) => `${input.planId}:v${input.version}:step:${input.stepId}`;
const createSuspendToken = (input) => `${input.planId}:v${input.version}:suspend:${input.reason}:${randomUUID()}`;
const buildDefaultResumeContract = () => ({
    allowedFields: ['decision', 'approvedBy', 'reason'],
});
const toWorkflowRecord = (row) => agentPlanWorkflowRecordSchema.parse({
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
const toWorkflowEventRecord = (row) => agentPlanWorkflowEventRecordSchema.parse({
    eventId: rowString(row, 'event_id'),
    workflowRunId: rowString(row, 'workflow_run_id'),
    planId: rowString(row, 'plan_id'),
    planVersion: rowInteger(row, 'plan_version', { min: 1 }),
    seq: rowInteger(row, 'seq', { min: 0 }),
    createdAt: rowString(row, 'created_at'),
    event: parseWorkflowEvent(rowString(row, 'event_json')),
});
const createInitialState = (record, planHash, parentRunId, replanOfVersion) => {
    const stepIds = record.plan.steps.map((step) => step.id);
    const stepIdempotencyKeys = Object.fromEntries(stepIds.map((stepId) => [
        stepId,
        createStepIdempotencyKey({
            planId: record.planId,
            version: record.version,
            stepId,
        }),
    ]));
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
// -----------------------------------------------------------------------------
// Projection
// -----------------------------------------------------------------------------
class WorkflowProjection {
    status = 'waiting_approval';
    phase = 'approval_gate';
    currentStepId = null;
    mastraRunId = null;
    suspendedAt = null;
    resumedAt = null;
    finishedAt = null;
    errorMessage = null;
    state;
    constructor(initialState) {
        this.state = initialState;
    }
}
const projectWorkflow = (initialState, events) => {
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
                projection.state.failedStepIds = projection.state.failedStepIds.filter((stepId) => stepId !== event.stepId);
                projection.state.executionCursor = projection.state.stepIds.reduce((cursor, stepId, index) => projection.state.completedStepIds.includes(stepId)
                    ? Math.max(cursor, index + 1)
                    : cursor, 0);
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
// -----------------------------------------------------------------------------
// Store implementation
// -----------------------------------------------------------------------------
export class LibsqlAgentPlanWorkflowStore {
    client;
    ownsClient;
    now;
    initialized = null;
    closed = false;
    constructor(options = {}) {
        if (options.client) {
            this.client = options.client;
            this.ownsClient = false;
        }
        else {
            this.client = createClient({ url: options.url ?? resolveMastraStorageUrl() });
            this.ownsClient = true;
        }
        this.now = options.now ?? (() => new Date().toISOString());
    }
    async createForPlan(input) {
        this.assertOpen();
        await this.ensureInitialized();
        const existing = await this.getWorkflowOrNull({
            planId: input.record.planId,
            version: input.record.version,
        });
        if (existing)
            return existing;
        const workflowRunId = randomUUID();
        const createdAt = this.now();
        const planHash = hashApprovedPlan(input.record);
        const initialState = createInitialState(input.record, planHash, toNonEmptyString(input.parentRunId), input.replanOfVersion ?? null);
        const suspendToken = createSuspendToken({
            planId: input.record.planId,
            version: input.record.version,
            reason: 'plan_approval',
        });
        await this.runInTransaction(async (transaction) => {
            await transaction.execute({
                sql: `
                    INSERT INTO ${WORKFLOW_RUN_TABLE} (
                        workflow_run_id, plan_id, plan_version, thread_id,
                        status, phase, current_step_id, execution_cursor,
                        approved_plan_hash, last_heartbeat_at,
                        parent_run_id, replan_of_version,
                        suspend_reason, suspend_token, mastra_run_id,
                        created_at, updated_at,
                        suspended_at, resumed_at, finished_at,
                        error_message, state_json, revision
                    ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, NULL, ?, ?, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, ?, 0)
                `,
                args: [
                    workflowRunId,
                    input.record.planId,
                    input.record.version,
                    input.record.threadId,
                    'waiting_approval',
                    'approval_gate',
                    planHash,
                    initialState.parentRunId,
                    initialState.replanOfVersion,
                    createdAt,
                    createdAt,
                    serializeWorkflowState(initialState),
                ],
            });
            await this.appendEventInTransaction(transaction, workflowRunId, input.record.planId, input.record.version, 0, createdAt, {
                type: 'PlanGenerated',
                planId: input.record.planId,
                version: input.record.version,
                threadId: input.record.threadId,
                planHash,
                stepIds: initialState.stepIds,
            });
            await this.appendEventInTransaction(transaction, workflowRunId, input.record.planId, input.record.version, 1, createdAt, {
                type: 'Suspended',
                reason: 'plan_approval',
                token: suspendToken,
                payload: {
                    planId: input.record.planId,
                    version: input.record.version,
                },
                expiresAt: null,
                resumeContract: buildDefaultResumeContract(),
            });
        });
        return this.reproject({
            planId: input.record.planId,
            version: input.record.version,
        });
    }
    async getWorkflow(input) {
        const record = await this.getWorkflowOrNull(input);
        if (record)
            return record;
        throw new Error(`未找到计划 workflow ${input.planId}@v${input.version}。`);
    }
    async listEvents(input) {
        this.assertOpen();
        await this.ensureInitialized();
        const result = await this.client.execute({
            sql: `
                SELECT ${WORKFLOW_EVENT_SELECT_FIELDS}
                FROM ${WORKFLOW_EVENT_TABLE}
                WHERE plan_id = ? AND plan_version = ?
                ORDER BY seq ASC
            `,
            args: [input.planId, input.version],
        });
        return result.rows.map(toWorkflowEventRecord);
    }
    async approvePlan(record, approvedBy) {
        await this.createForPlan({ record });
        const workflow = await this.getWorkflow({
            planId: record.planId,
            version: record.version,
        });
        const approvedHash = hashApprovedPlan(record);
        if (workflow.state.approvedPlanHash !== approvedHash) {
            throw new Error(`批准计划哈希不一致：${record.planId}@v${record.version}。`);
        }
        if (workflow.status === 'approved' ||
            workflow.status === 'executing' ||
            workflow.status === 'completed') {
            return workflow;
        }
        await this.appendEvents({ planId: record.planId, version: record.version }, [
            {
                type: 'PlanApproved',
                version: record.version,
                approvedHash,
                approvedBy: toNonEmptyString(approvedBy),
            },
            ...(workflow.state.suspend.token
                ? [{
                        type: 'Resumed',
                        token: workflow.state.suspend.token,
                    }]
                : []),
        ]);
        return this.reproject({ planId: record.planId, version: record.version });
    }
    async rejectPlan(record, reason) {
        await this.createForPlan({ record });
        return this.finishPlan({
            planId: record.planId,
            version: record.version,
            status: 'rejected',
            errorMessage: reason,
        });
    }
    async startStep(input) {
        const workflow = await this.getActiveWorkflow(input, '启动步骤');
        const idempotencyKey = workflow.state.stepIdempotencyKeys[input.stepId] ?? createStepIdempotencyKey(input);
        if (workflow.state.completedStepIds.includes(input.stepId)) {
            return workflow;
        }
        await this.appendEvents(input, [
            {
                type: 'StepStarted',
                stepId: input.stepId,
                idempotencyKey,
                mastraRunId: toNonEmptyString(input.mastraRunId),
                toolCall: null,
            },
            {
                type: 'Heartbeat',
                stepId: input.stepId,
                phase: 'step_start',
            },
        ]);
        return this.reproject(input);
    }
    async completeStep(input) {
        const workflow = await this.getActiveWorkflow(input, '完成步骤');
        const idempotencyKey = workflow.state.stepIdempotencyKeys[input.stepId] ?? createStepIdempotencyKey(input);
        if (workflow.state.completedStepIds.includes(input.stepId)) {
            return workflow;
        }
        await this.appendEvents(input, [
            {
                type: 'StepCompleted',
                stepId: input.stepId,
                idempotencyKey,
                resultRef: toNonEmptyString(input.resultRef),
            },
            {
                type: 'Heartbeat',
                stepId: input.stepId,
                phase: 'step_end',
            },
        ]);
        return this.reproject(input);
    }
    async failStep(input) {
        const workflow = await this.getActiveWorkflow(input, '失败步骤');
        const idempotencyKey = workflow.state.stepIdempotencyKeys[input.stepId] ?? createStepIdempotencyKey(input);
        await this.appendEvents(input, [{
                type: 'StepFailed',
                stepId: input.stepId,
                idempotencyKey,
                error: input.error,
                retryable: input.retryable,
            }]);
        return this.reproject(input);
    }
    async heartbeat(input) {
        await this.getActiveWorkflow(input, '发送心跳');
        await this.appendEvents(input, [{
                type: 'Heartbeat',
                stepId: toNonEmptyString(input.stepId),
                phase: input.phase,
            }]);
        return this.reproject(input);
    }
    async suspend(input) {
        await this.getActiveWorkflow(input, '挂起 workflow');
        await this.appendEvents(input, [{
                type: 'Suspended',
                reason: input.reason,
                token: createSuspendToken(input),
                payload: input.payload ?? null,
                expiresAt: toNonEmptyString(input.expiresAt),
                resumeContract: {
                    allowedFields: input.allowedFields ?? buildDefaultResumeContract().allowedFields,
                },
            }]);
        return this.reproject(input);
    }
    async reportValidator(input) {
        await this.getActiveWorkflow(input, '上报 validator');
        const events = [{
                type: 'ValidatorReported',
                report: input.report,
            }];
        if (input.report.needsReplan) {
            events.push({
                type: 'Suspended',
                reason: 'validator_needs_replan',
                token: createSuspendToken({
                    planId: input.planId,
                    version: input.version,
                    reason: 'validator_needs_replan',
                }),
                payload: { report: input.report },
                expiresAt: null,
                resumeContract: {
                    allowedFields: ['decision', 'replanInstruction'],
                },
            });
        }
        await this.appendEvents(input, events);
        return this.reproject(input);
    }
    async issueReplan(input) {
        await this.getActiveWorkflow(input, '触发重新规划');
        // NOTE: 这里只在事件流中记录 fromVersion → toVersion，**不**切换当前 workflow
        // 行的 plan_version。新的版本需要由上层调用 createForPlan 创建独立的 workflow。
        await this.appendEvents(input, [{
                type: 'ReplanIssued',
                fromVersion: input.version,
                toVersion: input.toVersion,
                deltaRef: toNonEmptyString(input.deltaRef),
                delta: input.delta,
            }]);
        return this.reproject(input);
    }
    async finishPlan(input) {
        const workflow = await this.getWorkflow(input);
        if (workflow.status === input.status)
            return workflow;
        await this.appendEvents(input, [{
                type: 'PlanFinished',
                status: input.status,
                errorMessage: toNonEmptyString(input.errorMessage),
            }]);
        return this.reproject(input);
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        if (this.ownsClient)
            this.client.close();
    }
    // ---------------------------------------------------------------------
    // Private
    // ---------------------------------------------------------------------
    assertOpen() {
        if (this.closed) {
            throw new Error('LibsqlAgentPlanWorkflowStore 已关闭，无法再使用。');
        }
    }
    ensureInitialized() {
        if (this.initialized)
            return this.initialized;
        const init = this.runMigrations().catch((error) => {
            this.initialized = null;
            throw error;
        });
        this.initialized = init;
        return init;
    }
    async runMigrations() {
        await this.client.executeMultiple(`
            CREATE TABLE IF NOT EXISTS ${WORKFLOW_META_TABLE} (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS ${WORKFLOW_RUN_TABLE} (
                workflow_run_id TEXT PRIMARY KEY,
                plan_id TEXT NOT NULL,
                plan_version INTEGER NOT NULL,
                thread_id TEXT NOT NULL,
                status TEXT NOT NULL,
                phase TEXT NOT NULL,
                current_step_id TEXT,
                execution_cursor INTEGER NOT NULL DEFAULT 0,
                approved_plan_hash TEXT NOT NULL,
                last_heartbeat_at TEXT,
                parent_run_id TEXT,
                replan_of_version INTEGER,
                suspend_reason TEXT,
                suspend_token TEXT,
                mastra_run_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                suspended_at TEXT,
                resumed_at TEXT,
                finished_at TEXT,
                error_message TEXT,
                state_json TEXT NOT NULL,
                revision INTEGER NOT NULL DEFAULT 0,
                UNIQUE (plan_id, plan_version)
            );
            CREATE TABLE IF NOT EXISTS ${WORKFLOW_EVENT_TABLE} (
                event_id TEXT PRIMARY KEY,
                workflow_run_id TEXT NOT NULL,
                plan_id TEXT NOT NULL,
                plan_version INTEGER NOT NULL,
                seq INTEGER NOT NULL,
                type TEXT NOT NULL,
                event_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE (workflow_run_id, seq)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_plan_workflow_events_plan
                ON ${WORKFLOW_EVENT_TABLE} (plan_id, plan_version, seq);
            CREATE INDEX IF NOT EXISTS idx_agent_plan_workflow_runs_plan
                ON ${WORKFLOW_RUN_TABLE} (plan_id, plan_version);
            CREATE INDEX IF NOT EXISTS idx_agent_plan_workflow_runs_status_heartbeat
                ON ${WORKFLOW_RUN_TABLE} (status, last_heartbeat_at);
        `);
        await this.client.execute({
            sql: `INSERT OR IGNORE INTO ${WORKFLOW_META_TABLE} (key, value) VALUES ('schema_version', ?)`,
            args: [String(WORKFLOW_SCHEMA_VERSION)],
        });
    }
    async getWorkflowOrNull(input) {
        this.assertOpen();
        await this.ensureInitialized();
        const result = await this.client.execute({
            sql: `
                SELECT ${WORKFLOW_RUN_SELECT_FIELDS}
                FROM ${WORKFLOW_RUN_TABLE}
                WHERE plan_id = ? AND plan_version = ?
                LIMIT 1
            `,
            args: [input.planId, input.version],
        });
        const row = result.rows[0];
        return row ? toWorkflowRecord(row) : null;
    }
    async getActiveWorkflow(input, action) {
        const workflow = await this.getWorkflow(input);
        if (!ACTIVE_STATUSES.has(workflow.status)) {
            throw new Error(`计划 workflow ${input.planId}@v${input.version} 当前状态为 ${workflow.status}，无法${action}。`);
        }
        return workflow;
    }
    /**
     * Append events atomically. seq 计算和写入都在同一事务里，避免并发拿到相同 seq
     * 撞 UNIQUE 约束。
     */
    async appendEvents(input, events) {
        if (events.length === 0)
            return;
        const workflow = await this.getWorkflow(input);
        const createdAt = this.now();
        await this.runInTransaction(async (transaction) => {
            const maxResult = await transaction.execute({
                sql: `
                    SELECT COALESCE(MAX(seq), -1) AS max_seq
                    FROM ${WORKFLOW_EVENT_TABLE}
                    WHERE workflow_run_id = ?
                `,
                args: [workflow.workflowRunId],
            });
            const maxSeqRow = maxResult.rows[0];
            const maxSeq = maxSeqRow ? rowInteger(maxSeqRow, 'max_seq', { min: -1 }) : -1;
            let nextSeq = maxSeq + 1;
            for (const event of events) {
                await this.appendEventInTransaction(transaction, workflow.workflowRunId, input.planId, input.version, nextSeq, createdAt, event);
                nextSeq += 1;
            }
        });
    }
    async appendEventInTransaction(transaction, workflowRunId, planId, planVersion, seq, createdAt, event) {
        const parsedEvent = agentPlanWorkflowEventSchema.parse(event);
        await transaction.execute({
            sql: `
                INSERT INTO ${WORKFLOW_EVENT_TABLE} (
                    event_id, workflow_run_id, plan_id, plan_version,
                    seq, type, event_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `,
            args: [
                randomUUID(),
                workflowRunId,
                planId,
                planVersion,
                seq,
                parsedEvent.type,
                serializeWorkflowEvent(parsedEvent),
                createdAt,
            ],
        });
    }
    /**
 * Recompute projection from events and persist it. Uses a `revision` CAS column
 * so concurrent reprojections don't silently overwrite each other.
 */
    async reproject(input) {
        const workflow = await this.getWorkflow(input);
        const events = await this.listEvents(input);
        const projection = projectWorkflow(workflow.state, events);
        const updatedAt = this.now();
        const expectedRevision = await this.readRevision(workflow.workflowRunId);
        const updateResult = await this.client.execute({
            sql: `
                UPDATE ${WORKFLOW_RUN_TABLE}
                SET
                    status = ?,
                    phase = ?,
                    current_step_id = ?,
                    execution_cursor = ?,
                    approved_plan_hash = ?,
                    last_heartbeat_at = ?,
                    parent_run_id = ?,
                    replan_of_version = ?,
                    suspend_reason = ?,
                    suspend_token = ?,
                    mastra_run_id = ?,
                    updated_at = ?,
                    suspended_at = ?,
                    resumed_at = ?,
                    finished_at = ?,
                    error_message = ?,
                    state_json = ?,
                    revision = revision + 1
                WHERE workflow_run_id = ? AND revision = ?
            `,
            args: [
                projection.status,
                projection.phase,
                projection.currentStepId,
                projection.state.executionCursor,
                projection.state.approvedPlanHash,
                projection.state.lastHeartbeatAt,
                projection.state.parentRunId,
                projection.state.replanOfVersion,
                projection.state.suspend.reason,
                projection.state.suspend.token,
                projection.mastraRunId,
                updatedAt,
                projection.suspendedAt,
                projection.resumedAt,
                projection.finishedAt,
                projection.errorMessage,
                serializeWorkflowState(projection.state),
                workflow.workflowRunId,
                expectedRevision,
            ],
        });
        if (updateResult.rowsAffected !== 1) {
            // 另一个并发流程刚好抢先写了一版；重新读最新结果即可。事件流是单调追加，
            // 任何并发的 reproject 最终都会收敛到同一状态。
            return this.getWorkflow(input);
        }
        return this.getWorkflow(input);
    }
    async readRevision(workflowRunId) {
        const result = await this.client.execute({
            sql: `SELECT revision FROM ${WORKFLOW_RUN_TABLE} WHERE workflow_run_id = ? LIMIT 1`,
            args: [workflowRunId],
        });
        const row = result.rows[0];
        if (!row) {
            throw new Error(`workflow run ${workflowRunId} 不存在，无法读取 revision。`);
        }
        return rowInteger(row, 'revision', { min: 0 });
    }
    async runInTransaction(fn) {
        const transaction = await this.client.transaction('write');
        try {
            const result = await fn(transaction);
            await transaction.commit();
            return result;
        }
        catch (error) {
            try {
                await transaction.rollback();
            }
            catch (rollbackError) {
                console.warn(`[agent-plan-workflow-store] 事务回滚失败：${rollbackError.message}`);
            }
            throw error;
        }
        finally {
            transaction.close();
        }
    }
}
export const createAgentPlanWorkflowStore = (options = {}) => new LibsqlAgentPlanWorkflowStore(options);
