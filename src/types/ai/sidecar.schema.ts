import { z } from 'zod';
import { aiContextReferenceSchema } from '@/types/ai/context.schema';
import {
  aiLanguageModelUsageSchema,
  UNIFIED_DIFF_HUNK_LINE_PREFIXES,
  UNIFIED_DIFF_NO_NEWLINE_MARKER,
} from '@/types/ai/schema';
import {
  AGENT_PLAN_STATUSES,
  AGENT_RUNTIME_EVENT_SCHEMA_VERSION,
  AGENT_RUNTIME_EVENT_TYPES,
  AGENT_SIDECAR_MODES,
  type TAgentRuntimeEvent,
  type TJsonValue,
} from '@/types/ai/sidecar';

/* ============================================================================
 * Primitive recursive types
 * ========================================================================== */

/**
 * Recursive JSON value schema.
 *
 * 注意:Zod v4 把 `z.record(value)` 改成了 `z.record(key, value)` —— 强制
 * 显式 key type。我们的 JSON object 总是 string keys,所以传 `z.string()`。
 */
export const jsonValueSchema: z.ZodType<TJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/* ============================================================================
 * Enum schemas (re-exported as zod schemas of TS const arrays)
 * ========================================================================== */

export const agentSidecarModeSchema = z.enum(AGENT_SIDECAR_MODES);
export const agentPlanStatusSchema = z.enum(AGENT_PLAN_STATUSES);

/* ============================================================================
 * String helpers
 *
 * 这些 helper 把"空白字符串 / null / undefined"都归一化成 `undefined`,以便
 * caller 传任意一种都可以,backend 收到的只有 undefined 或非空字符串两种状态。
 *
 * `optionalWorkspaceRootPathSchema` 是特例:保留 `null`(显式"无工作区") vs
 * `undefined`(未指定)的区分,不归一化 null → undefined。
 * ========================================================================== */

const optionalNonEmptyStringSchema = z.preprocess((value) => {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string' && value.trim().length === 0) {
    return undefined;
  }
  return value;
}, z.string().trim().min(1).optional());

const requiredNonEmptyStringSchema = z.string().trim().min(1);

const optionalAgentModeSchema = z.preprocess((value) => {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string' && value.trim().length === 0) {
    return undefined;
  }
  return value;
}, agentSidecarModeSchema.optional());

const optionalWorkspaceRootPathSchema = z.preprocess((value) => {
  // 保留 null 语义("用户显式声明无工作区根目录"),与 undefined 区分。
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length === 0) {
    return undefined;
  }
  return value;
}, z.string().trim().min(1).nullable().optional());

/* ============================================================================
 * Shared diff hunk schema (与 ai.schema 共享 unified-diff line 约束)
 * ========================================================================== */

const unifiedDiffHunkLineSchema = z
  .string()
  .refine(
    (value) =>
      value === UNIFIED_DIFF_NO_NEWLINE_MARKER ||
      UNIFIED_DIFF_HUNK_LINE_PREFIXES.some((prefix) => value.startsWith(prefix)),
    'Patch hunk line must be a unified diff line.',
  );

const agentDiffHunkSchema = z.object({
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  lines: z.array(unifiedDiffHunkLineSchema),
});

/* ============================================================================
 * Model config (per-request override)
 * ========================================================================== */

const requestScopedModelConfigSchema = z.object({
  modelId: requiredNonEmptyStringSchema,
  apiKey: requiredNonEmptyStringSchema,
  baseUrl: optionalNonEmptyStringSchema,
});

/* ============================================================================
 * Messages
 * ========================================================================== */

export const agentSidecarMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
});

/* ============================================================================
 * Plan
 * ========================================================================== */

export const agentPlanStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  goal: z.string().min(1),
  description: z.string().min(1).optional(),
  status: z.enum(['pending', 'running', 'done', 'failed', 'skipped', 'cancelled']),
  tools: z.array(z.string().min(1)),
  files: z.array(z.string().min(1)).optional(),
  commands: z.array(z.string().min(1)).optional(),
  risks: z.array(z.string().min(1)).optional(),
  acceptanceCriteria: z.array(z.string().min(1)).optional(),
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

export const agentPlanRecordSchema = z.object({
  planId: z.string().min(1),
  threadId: z.string().min(1),
  version: z.number().int().positive(),
  status: agentPlanStatusSchema,
  userRequest: z.string(),
  plan: agentPlanSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  approvedAt: z.string().min(1).nullable(),
  executedAt: z.string().min(1).nullable(),
  rejectionReason: z.string().min(1).nullable(),
  errorMessage: z.string().min(1).nullable(),
});

/* ============================================================================
 * Approval / diff
 * ========================================================================== */

export const approvalRequestSchema = z.object({
  id: z.string().min(1),
  toolName: z.string().min(1),
  question: z.string().min(1),
  summary: z.string().min(1),
  riskLevel: z.enum(['low', 'medium', 'high']),
  reversible: z.boolean(),
  createdAt: z.string().min(1),
});

export const diffFileSchema = z.object({
  path: z.string().min(1),
  hunks: z.array(agentDiffHunkSchema),
});

/* ============================================================================
 * Runtime events (base + passthrough)
 *
 * 🚧 TODO(schema-first refactor): 当前 schema 只校验 21 种 event 的**公共字段**,
 * 用 `.passthrough()` 兜底变体特有字段。这意味着 `z.infer<typeof
 * agentRuntimeEventSchema>` 会带 `[k: string]: unknown` 索引签名,**无法**直接
 * 当作 handwritten `TAgentRuntimeEvent` 联合用。
 *
 * 等 agent-sidecar.ts 切到 schema 派生时(类似 ai.ts 的重构),需要把这里展开
 * 成 21 个变体的 `z.discriminatedUnion('type', [...])`,删掉 passthrough。
 * 这是较大工作量,暂列 TODO。
 *
 * 在那之前,**handwritten `TAgentRuntimeEvent` 是该域的类型层 SoT**,本 schema
 * 仅做 runtime 校验,不参与 TS 推断链路。
 * ========================================================================== */

export const agentRuntimeEventSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(AGENT_RUNTIME_EVENT_TYPES),
    runId: z.string().min(1),
    sessionId: z.string().min(1),
    agentId: z.string().min(1),
    timestamp: z.string().min(1),
    seq: z.number().int().nonnegative(),
    schemaVersion: z.literal(AGENT_RUNTIME_EVENT_SCHEMA_VERSION),
    redacted: z.literal(true),
    visibility: z.enum(['user', 'debug']),
    level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
    parentId: z.string().min(1).optional(),
    spanId: z.string().min(1).optional(),
  })
  .passthrough() as unknown as z.ZodType<TAgentRuntimeEvent>;

/* ============================================================================
 * UI events (sidecar response stream)
 * ========================================================================== */

export const agentUiEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message_delta'),
    text: z.string(),
    phase: z.enum(['stage', 'final']).optional(),
  }),
  z.object({
    type: z.literal('agent_event'),
    event: agentRuntimeEventSchema,
  }),
  z.object({
    type: z.literal('plan_ready'),
    planId: z.string().min(1),
    threadId: z.string().min(1).optional(),
    version: z.number().int().positive(),
    status: agentPlanStatusSchema,
    createdAt: z.string().min(1).optional(),
    updatedAt: z.string().min(1).optional(),
    approvedAt: z.string().min(1).nullable().optional(),
    executedAt: z.string().min(1).nullable().optional(),
    rejectionReason: z.string().min(1).nullable().optional(),
    errorMessage: z.string().min(1).nullable().optional(),
    plan: agentPlanSchema,
  }),
  z.object({
    type: z.literal('plan_record'),
    record: agentPlanRecordSchema,
    versions: z.array(agentPlanRecordSchema),
  }),
  z.object({
    type: z.literal('tool_start'),
    toolName: z.string().min(1),
    input: jsonValueSchema,
  }),
  z.object({
    type: z.literal('tool_result'),
    toolName: z.string().min(1),
    output: jsonValueSchema,
  }),
  z.object({
    type: z.literal('approval_required'),
    request: approvalRequestSchema,
  }),
  z.object({
    type: z.literal('diff_ready'),
    files: z.array(diffFileSchema),
  }),
  z.object({
    type: z.literal('done'),
    result: z.string(),
    /** @deprecated 使用 `usage.inputTokens`。 */
    promptTokens: z.number().nonnegative().optional(),
    /** @deprecated 使用 `usage.outputTokens`。 */
    completionTokens: z.number().nonnegative().optional(),
    /** @deprecated 使用 `usage.totalTokens`。 */
    totalTokens: z.number().nonnegative().optional(),
    // 复用 ai.schema 的共享 schema,避免双 SoT 与 passthrough 索引签名。
    usage: z
      .lazy(() => aiLanguageModelUsageSchema)
      .nullable()
      .optional(),
  }),
  z.object({
    type: z.literal('error'),
    message: z.string().min(1),
  }),
]);

/* ============================================================================
 * Health
 * ========================================================================== */

export const agentSidecarHealthPayloadSchema = z.object({
  ok: z.boolean(),
  status: z.string().min(1),
  engine: z.string().min(1),
  version: z.string().min(1).nullable(),
  protocolVersion: z.string().min(1).nullable().optional(),
  implementationVersion: z.string().min(1).nullable().optional(),
  mcp: z.object({
    configuredServers: z.number().int().nonnegative(),
    serverNames: z.array(z.string()),
    errors: z.array(z.string()),
  }),
});

export const agentSidecarWarmupPayloadSchema = z.object({
  ok: z.boolean(),
  providerId: z.string().min(1).nullable(),
  origin: z.string().min(1).nullable(),
  statusCode: z.number().int().positive().nullable(),
  durationMs: z.number().int().nonnegative(),
  skipped: z.boolean(),
  reason: z.string().min(1).nullable().optional(),
});

/* ============================================================================
 * Requests
 * ========================================================================== */

const agentSidecarBaseRequestSchema = z.object({
  sessionId: optionalNonEmptyStringSchema,
  goal: optionalNonEmptyStringSchema,
  messages: z.array(agentSidecarMessageSchema),
  workspaceRootPath: optionalWorkspaceRootPathSchema,
  context: z.array(aiContextReferenceSchema).default([]),
  modelConfig: requestScopedModelConfigSchema.optional(),
  threadId: optionalNonEmptyStringSchema,
  planId: optionalNonEmptyStringSchema,
  planVersion: z.number().int().positive().optional(),
  planStepId: optionalNonEmptyStringSchema,
});

export const agentSidecarChatRequestSchema = agentSidecarBaseRequestSchema.extend({
  mode: optionalAgentModeSchema,
});

export const agentSidecarPlanRequestSchema = agentSidecarBaseRequestSchema.extend({
  goal: requiredNonEmptyStringSchema,
});

export const agentSidecarExecuteRequestSchema = agentSidecarBaseRequestSchema.extend({
  goal: requiredNonEmptyStringSchema,
  planId: requiredNonEmptyStringSchema,
  planVersion: z.number().int().positive(),
  planStepId: requiredNonEmptyStringSchema,
});

/**
 * Approval resolve:大部分 base 字段都可不传(只需 sessionId + requestId + decision)。
 * 用 `.partial()` 把 base 全部变 optional,然后 `.extend` 只重新声明必填字段。
 * `sessionId` 在 partial 后已经 optional,这里不再重复声明,保持精简。
 */
export const agentSidecarApprovalResolveRequestSchema = agentSidecarBaseRequestSchema
  .partial()
  .extend({
    requestId: z.string().min(1),
    decision: z.string().min(1),
  });

export const agentSidecarRollbackStepSchema = z.union([
  requiredNonEmptyStringSchema,
  z.array(requiredNonEmptyStringSchema).min(1),
]);

export const agentSidecarCheckpointRestoreRequestSchema = z.object({
  sessionId: optionalNonEmptyStringSchema,
  runId: requiredNonEmptyStringSchema,
  snapshotId: optionalNonEmptyStringSchema,
  step: agentSidecarRollbackStepSchema.optional(),
});

/* ============================================================================
 * Responses
 * ========================================================================== */

export const agentSidecarResponsePayloadSchema = z.object({
  sessionId: z.string().min(1),
  events: z.array(agentUiEventSchema),
  result: z.string().nullable(),
});

export const agentSidecarStreamEventPayloadSchema = z.object({
  sessionId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  event: agentUiEventSchema,
});
