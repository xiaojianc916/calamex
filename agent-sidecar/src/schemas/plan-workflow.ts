import { z } from 'zod';
import type { JSONValue } from '../types/json-value.js';
import { agentPlanStepSchema } from './plan.js';

// ----------------------------------------------------------------------
// Schema version
// ----------------------------------------------------------------------

/**
 * 工作流事件记录 schema 版本。
 * - 事件是 append-only 持久化的；任何 event payload 改动必须 bump 该版本。
 * - 不为新增 optional 字段 bump（向后兼容）。
 */
export const AGENT_PLAN_WORKFLOW_EVENT_SCHEMA_VERSION = 1 as const;
export type TAgentPlanWorkflowEventSchemaVersion = typeof AGENT_PLAN_WORKFLOW_EVENT_SCHEMA_VERSION;

// ----------------------------------------------------------------------
// JSON value
// ----------------------------------------------------------------------

/**
 * TODO: 与 `../schemas/events.ts` 中的 `jsonValueSchema` 是重复定义。
 * 建议挪到 `../types/json-value.ts` 与 `JSONValue` type 并列 export。
 */
const jsonValueSchema: z.ZodType<JSONValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

// ----------------------------------------------------------------------
// Enums
// ----------------------------------------------------------------------

/**
 * 工作流逻辑状态。
 *
 * 注意：**没有 `'suspended'`**。Suspend / Resume 是叠加在 `executing` 或
 * `waiting_approval` 之上的正交维度，通过 `state.suspend.reason !== null`
 * 表达。这是有意设计，不要轻易增加 `'suspended'` 值。
 */
export const agentPlanWorkflowStatusSchema = z.enum([
  'waiting_approval',
  'approved',
  'executing',
  'completed',
  'failed',
  'rejected',
  'cancelled',
]);

/** 工作流执行阶段（与单步生命周期 `Heartbeat.phase` 是不同概念）。 */
export const agentPlanWorkflowPhaseSchema = z.enum([
  'approval_gate',
  'execute_plan',
  'validate_result',
  'replan',
  'finish',
]);

export const agentPlanWorkflowSuspendReasonSchema = z.enum([
  'plan_approval',
  'validator_needs_replan',
  'ask_user',
  'tool_external_wait',
]);

/** 终止态子集 —— 派生自 `agentPlanWorkflowStatusSchema` 以避免漂移。 */
export const AGENT_PLAN_WORKFLOW_TERMINAL_STATUSES = [
  'completed',
  'failed',
  'rejected',
  'cancelled',
] as const satisfies ReadonlyArray<z.infer<typeof agentPlanWorkflowStatusSchema>>;

export const agentPlanWorkflowTerminalStatusSchema = z.enum(AGENT_PLAN_WORKFLOW_TERMINAL_STATUSES);

// ----------------------------------------------------------------------
// State sub-objects
// ----------------------------------------------------------------------

const approvalSubstateSchema = z.object({
  required: z.boolean(),
  approved: z.boolean(),
  rejected: z.boolean(),
  reason: z.string().min(1).nullable(),
}).refine(
  (value) => !(value.approved && value.rejected),
  { message: 'approval 不能同时 approved 与 rejected', path: ['approved'] },
).refine(
  (value) => value.rejected ? value.reason !== null : true,
  { message: 'approval.rejected 时必须填写 reason', path: ['reason'] },
);

const resumeContractSchema = z.object({
  allowedFields: z.array(z.string().min(1)),
});

const suspendSubstateSchema = z.object({
  reason: agentPlanWorkflowSuspendReasonSchema.nullable(),
  token: z.string().min(1).nullable(),
  payload: jsonValueSchema.nullable(),
  expiresAt: z.string().datetime().nullable(),         // ⚠️ 改 datetime
  resumeContract: resumeContractSchema.nullable(),
}).refine(
  (value) => {
    // 全部 null：未挂起。reason !== null：必须 token / resumeContract 同时有值。
    if (value.reason === null) {
      return value.token === null && value.payload === null
        && value.expiresAt === null && value.resumeContract === null;
    }
    return value.token !== null && value.resumeContract !== null;
  },
  { message: 'suspend 子状态字段必须全 null 或满足 reason+token+resumeContract 同时存在' },
);

const validatorSubstateSchema = z.object({
  status: z.enum(['pending', 'running', 'passed', 'failed', 'needs_replan', 'skipped']),
  summary: z.string().min(1).nullable(),
  needsReplan: z.boolean(),
});

// ----------------------------------------------------------------------
// State
// ----------------------------------------------------------------------

export const agentPlanWorkflowStateSchema = z.object({
  planId: z.string().min(1),
  planVersion: z.number().int().positive(),
  threadId: z.string().min(1),
  stepIds: z.array(z.string().min(1)),
  stepIdempotencyKeys: z.record(z.string().min(1), z.string().min(1)),
  executionCursor: z.number().int().nonnegative(),
  approvedPlanHash: z.string().min(1),
  currentStepId: z.string().min(1).nullable(),
  completedStepIds: z.array(z.string().min(1)),
  failedStepIds: z.array(z.string().min(1)),
  lastHeartbeatAt: z.string().datetime().nullable(),    // ⚠️ datetime
  parentRunId: z.string().min(1).nullable(),
  replanOfVersion: z.number().int().positive().nullable(),
  suspend: suspendSubstateSchema,
  approval: approvalSubstateSchema,
  validator: validatorSubstateSchema,
}).refine(
  (value) => value.executionCursor <= value.stepIds.length,
  { message: 'executionCursor 不能超过 stepIds.length', path: ['executionCursor'] },
).refine(
  (value) => {
    const stepIdSet = new Set(value.stepIds);
    return Object.keys(value.stepIdempotencyKeys).every((k) => stepIdSet.has(k));
  },
  { message: 'stepIdempotencyKeys 的 key 必须属于 stepIds', path: ['stepIdempotencyKeys'] },
);

// ----------------------------------------------------------------------
// Workflow record
// ----------------------------------------------------------------------

export const agentPlanWorkflowRecordSchema = z.object({
  workflowRunId: z.string().min(1),
  planId: z.string().min(1),
  planVersion: z.number().int().positive(),
  threadId: z.string().min(1),
  status: agentPlanWorkflowStatusSchema,
  phase: agentPlanWorkflowPhaseSchema,
  currentStepId: z.string().min(1).nullable(),
  mastraRunId: z.string().min(1).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  suspendedAt: z.string().datetime().nullable(),
  resumedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  errorMessage: z.string().min(1).nullable(),
  state: agentPlanWorkflowStateSchema,
});

// ----------------------------------------------------------------------
// Validation report
// ----------------------------------------------------------------------

export const agentPlanValidationReportSchema = z.object({
  status: z.enum(['passed', 'failed', 'needs_replan']),
  summary: z.string().min(1),
  checkedStepIds: z.array(z.string().min(1)),
  needsReplan: z.boolean(),
  findings: z.array(z.object({
    stepId: z.string().min(1).nullable(),
    severity: z.enum(['low', 'medium', 'high']),
    title: z.string().min(1),
    detail: z.string().min(1),
    retryable: z.boolean(),
  })),
  acceptance: z.array(z.object({
    criterion: z.string().min(1),
    passed: z.boolean(),
    detail: z.string().min(1),
  })),
});

// ----------------------------------------------------------------------
// Plan delta / step patch
// ----------------------------------------------------------------------

/**
 * Step 增量补丁。
 *
 * 维护提示：本 schema 与 `agentPlanStepSchema` 是手动镜像关系；
 * 如果将来 step 加了新字段，记得**同步**到这里。
 *
 * 偷懒方案：`agentPlanStepSchema.partial().omit({ id: true })`，
 * 但需要确认 step 的所有字段都允许被 patch（比如 id / index 这类不可改字段必须 omit）。
 */
export const agentPlanStepPatchSchema = z.object({
  title: z.string().min(1).optional(),
  goal: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  tools: z.array(z.string().min(1)).optional(),
  files: z.array(z.string().min(1)).optional(),
  commands: z.array(z.string().min(1)).optional(),
  risks: z.array(z.string().min(1)).optional(),
  acceptanceCriteria: z.array(z.string().min(1)).optional(),
  riskLevel: z.enum(['low', 'medium', 'high']).optional(),
  requiresApproval: z.boolean().optional(),
  expectedOutput: z.string().min(1).optional(),
});

export const agentPlanDeltaSchema = z.object({
  summary: z.string().min(1),
  added: z.array(agentPlanStepSchema),
  modified: z.array(z.object({
    id: z.string().min(1),
    patch: agentPlanStepPatchSchema,
  })),
  removed: z.array(z.string().min(1)),
});

// ----------------------------------------------------------------------
// Workflow events
// ----------------------------------------------------------------------

/**
 * 命名风格注释：本 schema 的事件 `type` 使用 PascalCase（`'PlanGenerated'`）
 * 因为它面向**内部事件溯源 / DB log**，与领域事件命名约定对齐。
 *
 * 与 `events.ts` 中 `agentUiEventSchema` 的 snake_case 是有意区分：
 * 后者面向**对外 UI 协议**，遵循 JSON message 命名约定。
 */
export const agentPlanWorkflowEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('PlanGenerated'),
    planId: z.string().min(1),
    version: z.number().int().positive(),
    threadId: z.string().min(1),
    planHash: z.string().min(1),
    stepIds: z.array(z.string().min(1)),
  }),
  z.object({
    type: z.literal('PlanApproved'),
    version: z.number().int().positive(),
    approvedHash: z.string().min(1),
    approvedBy: z.string().min(1).nullable(),
  }),
  z.object({
    type: z.literal('StepStarted'),
    stepId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    mastraRunId: z.string().min(1).nullable(),
    toolCall: jsonValueSchema.nullable(),
  }),
  z.object({
    type: z.literal('StepCompleted'),
    stepId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    resultRef: z.string().min(1).nullable(),
  }),
  z.object({
    type: z.literal('StepFailed'),
    stepId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    error: z.string().min(1),
    retryable: z.boolean(),
  }),
  z.object({
    type: z.literal('ValidatorReported'),
    report: agentPlanValidationReportSchema,
  }),
  z.object({
    type: z.literal('ReplanIssued'),
    fromVersion: z.number().int().positive(),
    toVersion: z.number().int().positive(),
    deltaRef: z.string().min(1).nullable(),
    delta: agentPlanDeltaSchema,
  }),
  z.object({
    type: z.literal('Suspended'),
    reason: agentPlanWorkflowSuspendReasonSchema,
    token: z.string().min(1),
    payload: jsonValueSchema.nullable(),
    expiresAt: z.string().datetime().nullable(),
    resumeContract: resumeContractSchema,
  }),
  z.object({
    type: z.literal('Resumed'),
    token: z.string().min(1),
  }),
  z.object({
    type: z.literal('Heartbeat'),
    stepId: z.string().min(1).nullable(),
    /**
     * 注意：这里的 phase 是**单步生命周期**位置，
     * 与 `agentPlanWorkflowPhaseSchema`（工作流阶段）是不同维度。
     */
    phase: z.enum(['before_tool', 'after_tool', 'step_start', 'step_end']),
  }),
  z.object({
    type: z.literal('PlanFinished'),
    status: agentPlanWorkflowTerminalStatusSchema,
    errorMessage: z.string().min(1).nullable(),
  }),
]);

export const agentPlanWorkflowEventRecordSchema = z.object({
  eventId: z.string().min(1),
  eventSchemaVersion: z.literal(AGENT_PLAN_WORKFLOW_EVENT_SCHEMA_VERSION),
  workflowRunId: z.string().min(1),
  planId: z.string().min(1),
  planVersion: z.number().int().positive(),
  seq: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  event: agentPlanWorkflowEventSchema,
});

export const agentPlanWorkflowRecordWithEventsSchema = agentPlanWorkflowRecordSchema.extend({
  events: z.array(agentPlanWorkflowEventRecordSchema),
});

// ----------------------------------------------------------------------
// Inferred types
// ----------------------------------------------------------------------

export type TAgentPlanWorkflowStatus = z.infer<typeof agentPlanWorkflowStatusSchema>;
export type TAgentPlanWorkflowPhase = z.infer<typeof agentPlanWorkflowPhaseSchema>;
export type TAgentPlanWorkflowSuspendReason = z.infer<typeof agentPlanWorkflowSuspendReasonSchema>;
export type TAgentPlanWorkflowTerminalStatus = z.infer<typeof agentPlanWorkflowTerminalStatusSchema>;
export type TAgentPlanValidationReport = z.infer<typeof agentPlanValidationReportSchema>;
export type TAgentPlanStepPatch = z.infer<typeof agentPlanStepPatchSchema>;
export type TAgentPlanDelta = z.infer<typeof agentPlanDeltaSchema>;
export type TAgentPlanWorkflowState = z.infer<typeof agentPlanWorkflowStateSchema>;
export type TAgentPlanWorkflowRecord = z.infer<typeof agentPlanWorkflowRecordSchema>;
export type TAgentPlanWorkflowEvent = z.infer<typeof agentPlanWorkflowEventSchema>;
export type TAgentPlanWorkflowEventRecord = z.infer<typeof agentPlanWorkflowEventRecordSchema>;
export type TAgentPlanWorkflowRecordWithEvents = z.infer<typeof agentPlanWorkflowRecordWithEventsSchema>;