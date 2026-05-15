import { randomUUID } from 'node:crypto';

import { createClient, type Client, type Row } from '@libsql/client';

import {
    agentPlanRecordSchema,
    agentPlanSchema,
    type TAgentPlan,
    type TAgentPlanRecord,
    type TAgentPlanStatus,
    type TAgentPlanStep,
} from '../schemas/plan.js';

import { resolveMastraStorageUrl } from './mastra-memory.js';

// -----------------------------------------------------------------------------
// Schema constants
// -----------------------------------------------------------------------------

const PLAN_RECORD_TABLE = 'agent_plan_records';
const PLAN_META_TABLE = 'agent_plan_meta';
const PLAN_RECORD_SCHEMA_VERSION = 1;

const PLAN_RECORD_SELECT_FIELDS = [
    'plan_id',
    'thread_id',
    'version',
    'status',
    'user_request',
    'plan_json',
    'created_at',
    'updated_at',
    'approved_at',
    'executed_at',
    'rejection_reason',
    'error_message',
].join(', ');

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface ICreatePendingPlanInput {
    planId?: string | undefined;
    threadId: string;
    userRequest: string;
    plan: TAgentPlan;
}

export interface IPlanVersionInput {
    planId: string;
    version: number;
}

export interface IPlanQueryInput {
    planId: string;
    version?: number | undefined;
}

export interface IRejectPlanInput extends IPlanVersionInput {
    reason?: string | undefined;
}

export interface IFinishPlanInput extends IPlanVersionInput {
    status: Extract<TAgentPlanStatus, 'completed' | 'failed'>;
    errorMessage?: string | undefined;
}

export interface IPrepareExecutionInput extends IPlanVersionInput {
    stepId: string;
}

export interface IAgentPlanStore {
    createPendingPlan(input: ICreatePendingPlanInput): Promise<TAgentPlanRecord>;
    getPlan(input: IPlanQueryInput): Promise<TAgentPlanRecord>;
    listPlanVersions(planId: string): Promise<TAgentPlanRecord[]>;
    approvePlan(input: IPlanVersionInput): Promise<TAgentPlanRecord>;
    rejectPlan(input: IRejectPlanInput): Promise<TAgentPlanRecord>;
    finishPlan(input: IFinishPlanInput): Promise<TAgentPlanRecord>;
    prepareExecution(input: IPrepareExecutionInput): Promise<{
        record: TAgentPlanRecord;
        step: TAgentPlanStep;
    }>;
    /** Release the underlying libsql client. Idempotent. */
    close(): Promise<void>;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const toNonEmptyString = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};

const serializePlan = (plan: TAgentPlan): string =>
    JSON.stringify(agentPlanSchema.parse(plan));

const parsePlan = (value: string): TAgentPlan =>
    agentPlanSchema.parse(JSON.parse(value) as unknown);

const rowString = (row: Row, key: string): string => {
    const value = row[key];
    if (typeof value !== 'string') {
        throw new Error(`计划记录字段 ${key} 不是字符串。`);
    }
    return value;
};

const rowNullableString = (row: Row, key: string): string | null => {
    const value = row[key];
    if (value === null) return null;
    if (typeof value !== 'string') {
        throw new Error(`计划记录字段 ${key} 不是字符串或 null。`);
    }
    return value;
};

const rowInteger = (
    row: Row,
    key: string,
    { min }: { min: number },
): number => {
    const value = row[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= min) {
        return value;
    }
    if (
        typeof value === 'bigint' &&
        value >= BigInt(min) &&
        value <= BigInt(Number.MAX_SAFE_INTEGER)
    ) {
        return Number(value);
    }
    throw new Error(`计划记录字段 ${key} 不是 >= ${min} 的整数。`);
};

const toPlanRecord = (row: Row): TAgentPlanRecord =>
    agentPlanRecordSchema.parse({
        planId: rowString(row, 'plan_id'),
        threadId: rowString(row, 'thread_id'),
        version: rowInteger(row, 'version', { min: 1 }),
        status: rowString(row, 'status'),
        userRequest: rowString(row, 'user_request'),
        plan: parsePlan(rowString(row, 'plan_json')),
        createdAt: rowString(row, 'created_at'),
        updatedAt: rowString(row, 'updated_at'),
        approvedAt: rowNullableString(row, 'approved_at'),
        executedAt: rowNullableString(row, 'executed_at'),
        rejectionReason: rowNullableString(row, 'rejection_reason'),
        errorMessage: rowNullableString(row, 'error_message'),
    });

const findPlanStep = (
    record: TAgentPlanRecord,
    stepId: string,
): TAgentPlanStep | null =>
    record.plan.steps.find((step) => step.id === stepId) ?? null;

const formatPlanVersion = (input: IPlanVersionInput): string =>
    `${input.planId}@v${input.version}`;

const isPositiveVersion = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value > 0;

// -----------------------------------------------------------------------------
// Store implementation
// -----------------------------------------------------------------------------

export class LibsqlAgentPlanStore implements IAgentPlanStore {
    private readonly client: Client;
    private readonly ownsClient: boolean;
    private readonly now: () => string;
    private initialized: Promise<void> | null = null;
    private closed = false;

    constructor(
        options: { client?: Client; url?: string; now?: () => string } = {},
    ) {
        if (options.client) {
            this.client = options.client;
            this.ownsClient = false;
        } else {
            this.client = createClient({
                url: options.url ?? resolveMastraStorageUrl(),
            });
            this.ownsClient = true;
        }
        this.now = options.now ?? (() => new Date().toISOString());
    }

    // ---------------------------------------------------------------------
    // CRUD
    // ---------------------------------------------------------------------

    async createPendingPlan(
        input: ICreatePendingPlanInput,
    ): Promise<TAgentPlanRecord> {
        this.assertOpen();

        const planId = toNonEmptyString(input.planId) ?? randomUUID();
        const threadId = toNonEmptyString(input.threadId) ?? planId;
        const planJson = serializePlan(input.plan);
        const createdAt = this.now();

        await this.ensureInitialized();

        const transaction = await this.client.transaction('write');
        try {
            const latestVersionResult = await transaction.execute({
                sql: `SELECT COALESCE(MAX(version), 0) AS latest_version FROM ${PLAN_RECORD_TABLE} WHERE plan_id = ?`,
                args: [planId],
            });
            const latestVersionRow = latestVersionResult.rows[0];
            const latestVersion = latestVersionRow
                ? rowInteger(latestVersionRow, 'latest_version', { min: 0 })
                : 0;
            const version = latestVersion + 1;

            const insertResult = await transaction.execute({
                sql: `
                    INSERT INTO ${PLAN_RECORD_TABLE} (
                        plan_id, thread_id, version, status,
                        user_request, plan_json,
                        created_at, updated_at,
                        approved_at, executed_at,
                        rejection_reason, error_message
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
                    RETURNING ${PLAN_RECORD_SELECT_FIELDS}
                `,
                args: [
                    planId,
                    threadId,
                    version,
                    'pending_approval',
                    input.userRequest,
                    planJson,
                    createdAt,
                    createdAt,
                ],
            });

            await transaction.commit();

            const row = insertResult.rows[0];
            if (!row) {
                throw new Error(
                    `创建计划 ${planId}@v${version} 后没有返回行，可能是 libsql 不支持 RETURNING。`,
                );
            }
            return toPlanRecord(row);
        } catch (error) {
            try {
                await transaction.rollback();
            } catch (rollbackError) {
                console.warn(
                    `[agent-plan-store] 事务回滚失败：${(rollbackError as Error).message}`,
                );
            }
            throw error;
        } finally {
            transaction.close();
        }
    }

    async getPlan(input: IPlanQueryInput): Promise<TAgentPlanRecord> {
        this.assertOpen();

        if (isPositiveVersion(input.version)) {
            return this.getPlanByVersionOrThrow({
                planId: input.planId,
                version: input.version,
            });
        }

        const latest = await this.getLatestPlan(input.planId);
        if (latest) return latest;
        throw new Error(`未找到计划 ${input.planId}。`);
    }

    async listPlanVersions(planId: string): Promise<TAgentPlanRecord[]> {
        this.assertOpen();
        await this.ensureInitialized();

        const result = await this.client.execute({
            sql: `
                SELECT ${PLAN_RECORD_SELECT_FIELDS}
                FROM ${PLAN_RECORD_TABLE}
                WHERE plan_id = ?
                ORDER BY version DESC
            `,
            args: [planId],
        });
        return result.rows.map(toPlanRecord);
    }

    async approvePlan(input: IPlanVersionInput): Promise<TAgentPlanRecord> {
        this.assertOpen();
        const record = await this.getPlanByVersionOrThrow(input);

        // Idempotent for already-progressed states.
        if (
            record.status === 'approved' ||
            record.status === 'executing' ||
            record.status === 'completed'
        ) {
            return record;
        }
        if (record.status !== 'pending_approval') {
            throw new Error(
                `计划 ${formatPlanVersion(input)} 当前状态为 ${record.status}，不能批准。`,
            );
        }

        return this.updatePlanStatus(input, {
            expectedStatus: record.status,
            nextStatus: 'approved',
            approvedAt: this.now(),
        });
    }

    async rejectPlan(input: IRejectPlanInput): Promise<TAgentPlanRecord> {
        this.assertOpen();
        const record = await this.getPlanByVersionOrThrow(input);

        if (record.status === 'rejected') return record;
        if (
            record.status === 'executing' ||
            record.status === 'completed' ||
            record.status === 'failed'
        ) {
            throw new Error(
                `计划 ${formatPlanVersion(input)} 已进入 ${record.status} 状态，不能拒绝。`,
            );
        }

        return this.updatePlanStatus(input, {
            expectedStatus: record.status,
            nextStatus: 'rejected',
            rejectionReason: toNonEmptyString(input.reason),
        });
    }

    async finishPlan(input: IFinishPlanInput): Promise<TAgentPlanRecord> {
        this.assertOpen();
        const record = await this.getPlanByVersionOrThrow(input);

        if (record.status === input.status) return record;
        if (
            record.status === 'rejected' ||
            record.status === 'completed' ||
            record.status === 'failed'
        ) {
            throw new Error(
                `计划 ${formatPlanVersion(input)} 当前状态为 ${record.status}，不能收口。`,
            );
        }

        return this.updatePlanStatus(input, {
            expectedStatus: record.status,
            nextStatus: input.status,
            executedAt: record.executedAt ?? this.now(),
            errorMessage:
                input.status === 'failed'
                    ? toNonEmptyString(input.errorMessage)
                    : null,
        });
    }

    async prepareExecution(input: IPrepareExecutionInput): Promise<{
        record: TAgentPlanRecord;
        step: TAgentPlanStep;
    }> {
        this.assertOpen();
        const record = await this.getPlanByVersionOrThrow(input);

        if (record.status !== 'approved' && record.status !== 'executing') {
            throw new Error(
                `计划 ${formatPlanVersion(input)} 当前状态为 ${record.status}，必须批准后才能执行。`,
            );
        }

        const step = findPlanStep(record, input.stepId);
        if (!step) {
            throw new Error(
                `计划 ${formatPlanVersion(input)} 中不存在步骤 ${input.stepId}。`,
            );
        }

        if (record.status === 'executing') {
            return { record, step };
        }

        const executingRecord = await this.updatePlanStatus(input, {
            expectedStatus: record.status,
            nextStatus: 'executing',
            executedAt: this.now(),
        });
        return { record: executingRecord, step };
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        if (this.ownsClient) {
            this.client.close();
        }
    }

    // ---------------------------------------------------------------------
    // Private
    // ---------------------------------------------------------------------

    private assertOpen(): void {
        if (this.closed) {
            throw new Error('LibsqlAgentPlanStore 已关闭，无法再使用。');
        }
    }

    /**
     * Run schema migrations idempotently. On failure, clears the cached
     * promise so the next call can retry instead of permanently failing.
     */
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
        // v1: initial tables + index.
        await this.client.executeMultiple(`
            CREATE TABLE IF NOT EXISTS ${PLAN_META_TABLE} (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS ${PLAN_RECORD_TABLE} (
                plan_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                version INTEGER NOT NULL,
                status TEXT NOT NULL,
                user_request TEXT NOT NULL,
                plan_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                approved_at TEXT,
                executed_at TEXT,
                rejection_reason TEXT,
                error_message TEXT,
                PRIMARY KEY (plan_id, version)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_plan_records_thread_updated
                ON ${PLAN_RECORD_TABLE} (thread_id, updated_at);
        `);

        await this.client.execute({
            sql: `INSERT OR IGNORE INTO ${PLAN_META_TABLE} (key, value) VALUES ('schema_version', ?)`,
            args: [String(PLAN_RECORD_SCHEMA_VERSION)],
        });

        // Future migrations should:
        //   1) Read current schema_version from PLAN_META_TABLE.
        //   2) Apply diffs sequentially.
        //   3) UPDATE schema_version row.
    }

    private async getPlanByVersionOrThrow(
        input: IPlanVersionInput,
    ): Promise<TAgentPlanRecord> {
        const record = await this.getPlanByVersion(input);
        if (record) return record;

        const latest = await this.getLatestPlan(input.planId);
        if (latest) {
            throw new Error(
                `计划版本不匹配：${input.planId} 当前最新版本为 v${latest.version}，收到 v${input.version}。`,
            );
        }
        throw new Error(`未找到计划 ${formatPlanVersion(input)}。`);
    }

    private async getPlanByVersion(
        input: IPlanVersionInput,
    ): Promise<TAgentPlanRecord | null> {
        await this.ensureInitialized();
        const result = await this.client.execute({
            sql: `
                SELECT ${PLAN_RECORD_SELECT_FIELDS}
                FROM ${PLAN_RECORD_TABLE}
                WHERE plan_id = ? AND version = ?
                LIMIT 1
            `,
            args: [input.planId, input.version],
        });
        const row = result.rows[0];
        return row ? toPlanRecord(row) : null;
    }

    private async getLatestPlan(
        planId: string,
    ): Promise<TAgentPlanRecord | null> {
        await this.ensureInitialized();
        const result = await this.client.execute({
            sql: `
                SELECT ${PLAN_RECORD_SELECT_FIELDS}
                FROM ${PLAN_RECORD_TABLE}
                WHERE plan_id = ?
                ORDER BY version DESC
                LIMIT 1
            `,
            args: [planId],
        });
        const row = result.rows[0];
        return row ? toPlanRecord(row) : null;
    }

    /**
     * Optimistic-concurrency status transition. Returns the updated record
     * directly via RETURNING — no second SELECT round trip.
     *
     * Field semantics:
     * - `nextStatus`: required new status.
     * - `expectedStatus`: row must currently be in this status (CAS).
     * - `approvedAt` / `executedAt`: pass a value to set, omit/undefined to
     *   leave unchanged (COALESCE). Use `null` only if you really mean "clear",
     *   which currently no caller does.
     * - `rejectionReason` / `errorMessage`: pass a string to set, `null` to
     *   clear, omit/undefined to leave unchanged (COALESCE).
     */
    private async updatePlanStatus(
        input: IPlanVersionInput,
        update: {
            nextStatus: TAgentPlanStatus;
            expectedStatus: TAgentPlanStatus;
            approvedAt?: string | undefined;
            executedAt?: string | undefined;
            rejectionReason?: string | null | undefined;
            errorMessage?: string | null | undefined;
        },
    ): Promise<TAgentPlanRecord> {
        await this.ensureInitialized();
        const updatedAt = this.now();

        // For optional fields: undefined means "leave alone" (handled via
        // COALESCE bound to NULL); explicit null means "clear".
        const toBind = <T>(value: T | undefined): T | null =>
            value === undefined ? (null as T | null) : (value as T | null);

        const result = await this.client.execute({
            sql: `
                UPDATE ${PLAN_RECORD_TABLE}
                SET
                    status = ?,
                    updated_at = ?,
                    approved_at = COALESCE(?, approved_at),
                    executed_at = COALESCE(?, executed_at),
                    rejection_reason = CASE WHEN ? = 1 THEN ? ELSE rejection_reason END,
                    error_message  = CASE WHEN ? = 1 THEN ? ELSE error_message  END
                WHERE plan_id = ? AND version = ? AND status = ?
                RETURNING ${PLAN_RECORD_SELECT_FIELDS}
            `,
            args: [
                update.nextStatus,
                updatedAt,
                toBind(update.approvedAt),
                toBind(update.executedAt),
                // rejection_reason: only touch if caller explicitly set the field.
                update.rejectionReason === undefined ? 0 : 1,
                update.rejectionReason ?? null,
                // error_message: same convention.
                update.errorMessage === undefined ? 0 : 1,
                update.errorMessage ?? null,
                input.planId,
                input.version,
                update.expectedStatus,
            ],
        });

        const row = result.rows[0];
        if (!row) {
            const latest = await this.getPlanByVersion(input);
            const latestStatus = latest?.status ?? 'missing';
            throw new Error(
                `更新计划 ${formatPlanVersion(input)} 状态失败：期望 ${update.expectedStatus}，当前 ${latestStatus}。`,
            );
        }
        return toPlanRecord(row);
    }
}

export const createAgentPlanStore = (
    options: { url?: string; now?: () => string } = {},
): IAgentPlanStore => new LibsqlAgentPlanStore(options);

export type { TAgentPlanRecord };
