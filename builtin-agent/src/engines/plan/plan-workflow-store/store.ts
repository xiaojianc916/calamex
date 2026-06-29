import { randomUUID } from 'node:crypto';

import { createClient, type Client, type Transaction } from '@libsql/client';

import {
    agentPlanWorkflowEventSchema,
    type TAgentPlanWorkflowEvent,
    type TAgentPlanWorkflowEventRecord,
    type TAgentPlanWorkflowRecord,
} from '../../../schemas/plan-workflow.js';
import type { TAgentPlanRecord } from '../../../schemas/plan.js';

import { resolveMastraStorageUrl } from '../../context/memory.js';

import {
    ACTIVE_STATUSES,
    WORKFLOW_EVENT_SELECT_FIELDS,
    WORKFLOW_EVENT_TABLE,
    WORKFLOW_META_TABLE,
    WORKFLOW_RUN_SELECT_FIELDS,
    WORKFLOW_RUN_TABLE,
    WORKFLOW_SCHEMA_VERSION,
} from './constants.js';
import type {
    IAgentPlanWorkflowStore,
    ICompletePlanWorkflowStepInput,
    ICreatePlanWorkflowInput,
    IFailPlanWorkflowStepInput,
    IFinishPlanWorkflowInput,
    IHeartbeatPlanWorkflowInput,
    IIssuePlanReplanInput,
    IPlanWorkflowVersionInput,
    IReportPlanValidatorInput,
    IStartPlanWorkflowStepInput,
    ISuspendPlanWorkflowInput,
} from './types.js';
import { rowInteger, toNonEmptyString } from './row-helpers.js';
import {
    buildDefaultResumeContract,
    createInitialState,
    createStepIdempotencyKey,
    createSuspendToken,
    hashApprovedPlan,
    serializeWorkflowEvent,
    serializeWorkflowState,
    toWorkflowEventRecord,
    toWorkflowRecord,
} from './serialization.js';
import { projectWorkflow } from './projection.js';

// -----------------------------------------------------------------------------
// Store implementation
// -----------------------------------------------------------------------------

// reproject 的 CAS 乐观锁在并发落败时的有界重投影重试上限，防止陈旧投影覆盖较新投影。
const REPROJECT_MAX_ATTEMPTS = 5;

export class LibsqlAgentPlanWorkflowStore implements IAgentPlanWorkflowStore {
    private readonly client: Client;
    private readonly ownsClient: boolean;
    private readonly now: () => string;
    private initialized: Promise<void> | null = null;
    private closed = false;

    constructor(options: { client?: Client; url?: string; now?: () => string } = {}) {
        if (options.client) {
            this.client = options.client;
            this.ownsClient = false;
        } else {
            this.client = createClient({ url: options.url ?? resolveMastraStorageUrl() });
            this.ownsClient = true;
        }
        this.now = options.now ?? (() => new Date().toISOString());
    }

    async createForPlan(input: ICreatePlanWorkflowInput): Promise<TAgentPlanWorkflowRecord> {
        this.assertOpen();
        await this.ensureInitialized();

        const existing = await this.getWorkflowOrNull({
            planId: input.record.planId,
            version: input.record.version,
        });
        if (existing) return existing;

        const workflowRunId = randomUUID();
        const createdAt = this.now();
        const planHash = hashApprovedPlan(input.record);
        const initialState = createInitialState(
            input.record,
            planHash,
            toNonEmptyString(input.parentRunId),
            input.replanOfVersion ?? null,
        );
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

            await this.appendEventInTransaction(
                transaction,
                workflowRunId,
                input.record.planId,
                input.record.version,
                0,
                createdAt,
                {
                    type: 'PlanGenerated',
                    planId: input.record.planId,
                    version: input.record.version,
                    threadId: input.record.threadId,
                    planHash,
                    stepIds: initialState.stepIds,
                },
            );
            await this.appendEventInTransaction(
                transaction,
                workflowRunId,
                input.record.planId,
                input.record.version,
                1,
                createdAt,
                {
                    type: 'Suspended',
                    reason: 'plan_approval',
                    token: suspendToken,
                    payload: {
                        planId: input.record.planId,
                        version: input.record.version,
                    },
                    expiresAt: null,
                    resumeContract: buildDefaultResumeContract(),
                },
            );
        });

        return this.reproject({
            planId: input.record.planId,
            version: input.record.version,
        });
    }

    async getWorkflow(input: IPlanWorkflowVersionInput): Promise<TAgentPlanWorkflowRecord> {
        const record = await this.getWorkflowOrNull(input);
        if (record) return record;
        throw new Error(`未找到计划 workflow ${input.planId}@v${input.version}。`);
    }

    async listEvents(input: IPlanWorkflowVersionInput): Promise<TAgentPlanWorkflowEventRecord[]> {
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

    async approvePlan(
        record: TAgentPlanRecord,
        approvedBy?: string | undefined,
    ): Promise<TAgentPlanWorkflowRecord> {
        await this.createForPlan({ record });
        const workflow = await this.getWorkflow({
            planId: record.planId,
            version: record.version,
        });

        const approvedHash = hashApprovedPlan(record);
        if (workflow.state.approvedPlanHash !== approvedHash) {
            throw new Error(`批准计划哈希不一致：${record.planId}@v${record.version}。`);
        }

        if (
            workflow.status === 'approved' ||
            workflow.status === 'executing' ||
            workflow.status === 'completed'
        ) {
            return workflow;
        }

        await this.appendEvents(
            { planId: record.planId, version: record.version },
            [
                {
                    type: 'PlanApproved',
                    version: record.version,
                    approvedHash,
                    approvedBy: toNonEmptyString(approvedBy),
                },
                ...(workflow.state.suspend.token
                    ? [{
                        type: 'Resumed' as const,
                        token: workflow.state.suspend.token,
                    }]
                    : []),
            ],
        );

        return this.reproject({ planId: record.planId, version: record.version });
    }

    async rejectPlan(
        record: TAgentPlanRecord,
        reason?: string | undefined,
    ): Promise<TAgentPlanWorkflowRecord> {
        await this.createForPlan({ record });
        return this.finishPlan({
            planId: record.planId,
            version: record.version,
            status: 'rejected',
            errorMessage: reason,
        });
    }

    async startStep(input: IStartPlanWorkflowStepInput): Promise<TAgentPlanWorkflowRecord> {
        const workflow = await this.getActiveWorkflow(input, '启动步骤');
        const idempotencyKey =
            workflow.state.stepIdempotencyKeys[input.stepId] ?? createStepIdempotencyKey(input);

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

    async completeStep(input: ICompletePlanWorkflowStepInput): Promise<TAgentPlanWorkflowRecord> {
        const workflow = await this.getActiveWorkflow(input, '完成步骤');
        const idempotencyKey =
            workflow.state.stepIdempotencyKeys[input.stepId] ?? createStepIdempotencyKey(input);

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

    async failStep(input: IFailPlanWorkflowStepInput): Promise<TAgentPlanWorkflowRecord> {
        const workflow = await this.getActiveWorkflow(input, '失败步骤');
        const idempotencyKey =
            workflow.state.stepIdempotencyKeys[input.stepId] ?? createStepIdempotencyKey(input);

        await this.appendEvents(input, [{
            type: 'StepFailed',
            stepId: input.stepId,
            idempotencyKey,
            error: input.error,
            retryable: input.retryable,
        }]);
        return this.reproject(input);
    }

    async heartbeat(input: IHeartbeatPlanWorkflowInput): Promise<TAgentPlanWorkflowRecord> {
        await this.getActiveWorkflow(input, '发送心跳');
        await this.appendEvents(input, [{
            type: 'Heartbeat',
            stepId: toNonEmptyString(input.stepId),
            phase: input.phase,
        }]);
        return this.reproject(input);
    }

    async suspend(input: ISuspendPlanWorkflowInput): Promise<TAgentPlanWorkflowRecord> {
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

    async reportValidator(input: IReportPlanValidatorInput): Promise<TAgentPlanWorkflowRecord> {
        await this.getActiveWorkflow(input, '上报 validator');

        const events: TAgentPlanWorkflowEvent[] = [{
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

    async issueReplan(input: IIssuePlanReplanInput): Promise<TAgentPlanWorkflowRecord> {
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

    async finishPlan(input: IFinishPlanWorkflowInput): Promise<TAgentPlanWorkflowRecord> {
        const workflow = await this.getWorkflow(input);
        if (workflow.status === input.status) return workflow;

        await this.appendEvents(input, [{
            type: 'PlanFinished',
            status: input.status,
            errorMessage: toNonEmptyString(input.errorMessage),
        }]);
        return this.reproject(input);
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        if (this.ownsClient) this.client.close();
    }

    // ---------------------------------------------------------------------
    // Private
    // ---------------------------------------------------------------------

    private assertOpen(): void {
        if (this.closed) {
            throw new Error('LibsqlAgentPlanWorkflowStore 已关闭，无法再使用。');
        }
    }

    private ensureInitialized(): Promise<void> {
        if (this.initialized) return this.initialized;
        const init = this.runMigrations().catch((error) => {
            this.initialized = null;
            throw error;
        });
        this.initialized = init;
        return init;
    }

    private async runMigrations(): Promise<void> {
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

    private async getWorkflowOrNull(
        input: IPlanWorkflowVersionInput,
    ): Promise<TAgentPlanWorkflowRecord | null> {
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

    private async getActiveWorkflow(
        input: IPlanWorkflowVersionInput,
        action: string,
    ): Promise<TAgentPlanWorkflowRecord> {
        const workflow = await this.getWorkflow(input);
        if (!ACTIVE_STATUSES.has(workflow.status)) {
            throw new Error(
                `计划 workflow ${input.planId}@v${input.version} 当前状态为 ${workflow.status}，无法${action}。`,
            );
        }
        return workflow;
    }

    /**
     * Append events atomically. seq 计算和写入都在同一事务里，避免并发拿到相同 seq
     * 撞 UNIQUE 约束。
     */
    private async appendEvents(
        input: IPlanWorkflowVersionInput,
        events: TAgentPlanWorkflowEvent[],
    ): Promise<void> {
        if (events.length === 0) return;

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
                await this.appendEventInTransaction(
                    transaction,
                    workflow.workflowRunId,
                    input.planId,
                    input.version,
                    nextSeq,
                    createdAt,
                    event,
                );
                nextSeq += 1;
            }
        });
    }

    private async appendEventInTransaction(
        transaction: Transaction,
        workflowRunId: string,
        planId: string,
        planVersion: number,
        seq: number,
        createdAt: string,
        event: TAgentPlanWorkflowEvent,
    ): Promise<void> {
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
    private async reproject(
        input: IPlanWorkflowVersionInput,
        attempt = 0,
    ): Promise<TAgentPlanWorkflowRecord> {
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
            // CAS 落败：有并发 reproject 抢先写入。若直接返回，较旧（事件更少）的投影
            // 可能已覆盖较新的投影，导致持久化状态落后于事件流；故重读事件流后重投影重试。
            if (attempt + 1 < REPROJECT_MAX_ATTEMPTS) {
                return this.reproject(input, attempt + 1);
            }
            return this.getWorkflow(input);
        }
        return this.getWorkflow(input);
    }

    private async readRevision(workflowRunId: string): Promise<number> {
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

    private async runInTransaction<T>(
        fn: (transaction: Transaction) => Promise<T>,
    ): Promise<T> {
        const transaction = await this.client.transaction('write');
        try {
            const result = await fn(transaction);
            await transaction.commit();
            return result;
        } catch (error) {
            try {
                await transaction.rollback();
            } catch (rollbackError) {
                console.warn(
                    `[agent-plan-workflow-store] 事务回滚失败：${(rollbackError as Error).message}`,
                );
            }
            throw error;
        } finally {
            transaction.close();
        }
    }
}

export const createAgentPlanWorkflowStore = (
    options: { url?: string; now?: () => string } = {},
): IAgentPlanWorkflowStore => new LibsqlAgentPlanWorkflowStore(options);
