import { z } from 'zod/v3';

// ----------------------------------------------------------------------
// Schema version
// ----------------------------------------------------------------------

/**
 * 计划记录 schema 版本。
 * - 与 `plan-workflow.ts` 的 `AGENT_PLAN_WORKFLOW_EVENT_SCHEMA_VERSION` 是
 *   **独立**版本号（两套持久化分别演化）。
 */
export const AGENT_PLAN_RECORD_SCHEMA_VERSION = 1 as const;
export type TAgentPlanRecordSchemaVersion = typeof AGENT_PLAN_RECORD_SCHEMA_VERSION;

// ----------------------------------------------------------------------
// Step defaults (PLAN.md → strict plan bridge 用 / 文档用)
// ----------------------------------------------------------------------

/**
 * 当 PLAN.md 的 Steps 区只提供步骤标题时，桥接到严格 step schema 所需的默认值。
 */
export const PLAN_STEP_DEFAULTS = {
  riskLevel: 'low',
  requiresApproval: false,
  expectedOutput: '（未指定）',
} as const;

// ----------------------------------------------------------------------
// Status enums
// ----------------------------------------------------------------------

/**
 * 计划状态。**与 `agentPlanWorkflowStatusSchema` 是两个不同的生命周期**：
 * - 此处描述计划文档本身（草稿 → 审批 → 执行 → 终态）。
 * - 工作流状态描述某次执行运行（同一份计划可能被多次重新执行）。
 *
 * 该枚举**没有** `'cancelled'`。如果用户取消了正在执行的工作流，
 * 计划本身回退到 `'approved'`（可重新执行），工作流记录则进入 `'cancelled'`。
 */
export const agentPlanStatusSchema = z.enum([
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'executing',
  'completed',
  'failed',
]);

export const agentPlanStepStatusSchema = z.enum([
  'pending',
  'running',
  'done',
  'failed',
  'skipped',
  'cancelled',
]);

/**
 * Step 终态映射（投影 / 报表用）：
 * - `done`      → 进入 `completedStepIds`
 * - `skipped`   → 进入 `completedStepIds`（视作成功跳过）
 * - `failed`    → 进入 `failedStepIds`
 * - `cancelled` → 不进入任一集合（中止）
 * - `pending` / `running` → 进行中，不进入终态集合
 */
export const PLAN_STEP_TERMINAL_BUCKETS = {
  completed: ['done', 'skipped'],
  failed: ['failed'],
  aborted: ['cancelled'],
  inProgress: ['pending', 'running'],
} as const satisfies Record<string, ReadonlyArray<z.infer<typeof agentPlanStepStatusSchema>>>;

// ----------------------------------------------------------------------
// Step / plan (strict)
// ----------------------------------------------------------------------

export const agentPlanStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  goal: z.string().min(1),
  description: z.string().min(1).optional(),
  status: agentPlanStepStatusSchema,
  tools: z.array(z.string().min(1)).default([]),
  files: z.array(z.string().min(1)).default([]),
  commands: z.array(z.string().min(1)).default([]),
  risks: z.array(z.string().min(1)).default([]),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
  riskLevel: z.enum(['low', 'medium', 'high']),
  requiresApproval: z.boolean(),
  expectedOutput: z.string().min(1),
});

export const agentPlanSchema = z.object({
  goal: z.string().min(1),
  summary: z.string().min(1).optional(),
  requiresApproval: z.boolean().optional(),
  steps: z.array(agentPlanStepSchema).min(1),
});

// ----------------------------------------------------------------------
// Plan record (持久化)
// ----------------------------------------------------------------------

export const agentPlanRecordSchema = z.object({
  schemaVersion: z.literal(AGENT_PLAN_RECORD_SCHEMA_VERSION),
  planId: z.string().min(1),
  threadId: z.string().min(1),
  version: z.number().int().positive(),
  status: agentPlanStatusSchema,
  /**
   * 触发该计划的用户消息。允许空串以兼容 system-initiated 的计划
   * （比如定时任务自动启动、由其它 agent 调用）。
   */
  userRequest: z.string(),
  plan: agentPlanSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  approvedAt: z.string().datetime().nullable(),
  executedAt: z.string().datetime().nullable(),
  rejectionReason: z.string().min(1).nullable(),
  errorMessage: z.string().min(1).nullable(),
}).refine(
  (value) => {
    // rejectionReason 与 'rejected' 状态绑定。
    if (value.status === 'rejected') {
      return value.rejectionReason !== null;
    }
    return value.rejectionReason === null;
  },
  { message: 'rejectionReason 仅且必须在 status="rejected" 时设置', path: ['rejectionReason'] },
).refine(
  (value) => {
    // errorMessage 仅在 'failed' 状态出现。
    if (value.status === 'failed') {
      return value.errorMessage !== null;
    }
    return value.errorMessage === null;
  },
  { message: 'errorMessage 仅且必须在 status="failed" 时设置', path: ['errorMessage'] },
).refine(
  (value) => {
    // approvedAt 在 approved / executing / completed / failed 时必须有值。
    const POST_APPROVAL: ReadonlyArray<z.infer<typeof agentPlanStatusSchema>> = [
      'approved', 'executing', 'completed', 'failed',
    ];
    const isPostApproval = POST_APPROVAL.includes(value.status);
    if (isPostApproval) {
      return value.approvedAt !== null;
    }
    // draft / pending_approval / rejected 不应有 approvedAt。
    return value.approvedAt === null;
  },
  { message: 'approvedAt 必须与 status 一致（approved/executing/completed/failed 时必填）', path: ['approvedAt'] },
).refine(
  (value) => {
    // executedAt 在 executing / completed / failed 时必须有值。
    const POST_EXECUTION: ReadonlyArray<z.infer<typeof agentPlanStatusSchema>> = [
      'executing', 'completed', 'failed',
    ];
    const isPostExecution = POST_EXECUTION.includes(value.status);
    if (isPostExecution) {
      return value.executedAt !== null;
    }
    return value.executedAt === null;
  },
  { message: 'executedAt 必须与 status 一致（executing/completed/failed 时必填）', path: ['executedAt'] },
);

// ----------------------------------------------------------------------
// Inferred types
// ----------------------------------------------------------------------

export type TAgentPlanStatus = z.infer<typeof agentPlanStatusSchema>;
export type TAgentPlanStepStatus = z.infer<typeof agentPlanStepStatusSchema>;
export type TAgentPlanStep = z.infer<typeof agentPlanStepSchema>;
export type TAgentPlan = z.infer<typeof agentPlanSchema>;
export type TAgentPlanRecord = z.infer<typeof agentPlanRecordSchema>;
