import { z } from 'zod';

// -----------------------------------------------------------------------
// 基础 schema 工具
// -----------------------------------------------------------------------

const agentModeSchema = z.enum(['ask', 'plan', 'agent', 'patch', 'review']);

const approvalDecisionSchema = z.enum(['approve', 'reject', 'cancel', 'modify']);

const optionalNonEmptyStringSchema = z.preprocess((value) => {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string' && value.trim().length === 0) {
    return undefined;
  }
  return value;
}, z.string().trim().min(1).optional()).optional();

const requiredNonEmptyStringSchema = z.string().trim().min(1);

const optionalAgentModeSchema = z.preprocess((value) => {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string' && value.trim().length === 0) {
    return undefined;
  }
  return value;
}, agentModeSchema.optional()).optional();

const optionalWorkspaceRootPathSchema = z.preprocess((value) => {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length === 0) {
    return undefined;
  }
  return value;
}, z.string().trim().min(1).nullable().optional()).optional();

const agentMessageInputSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
});

const agentContextReferenceSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  label: z.string().min(1),
  path: z.string().nullable(),
  range: z.object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  }).nullable(),
  contentPreview: z.string(),
  redacted: z.boolean(),
});

const requestScopedModelConfigSchema = z.object({
  modelId: requiredNonEmptyStringSchema,
  apiKey: requiredNonEmptyStringSchema,
  baseUrl: optionalNonEmptyStringSchema,
});

// -----------------------------------------------------------------------
// Request schemas
// -----------------------------------------------------------------------

export const baseAgentRequestSchema = z.object({
  sessionId: optionalNonEmptyStringSchema,
  mode: optionalAgentModeSchema,
  goal: optionalNonEmptyStringSchema,
  messages: z.array(agentMessageInputSchema).default([]),
  workspaceRootPath: optionalWorkspaceRootPathSchema,
  context: z.array(agentContextReferenceSchema).default([]),
  modelConfig: requestScopedModelConfigSchema.optional(),
  threadId: optionalNonEmptyStringSchema,
  planId: optionalNonEmptyStringSchema,
  planVersion: z.number().int().positive().optional(),
  planStepId: optionalNonEmptyStringSchema,
});

export const agentSidecarChatRequestSchema = baseAgentRequestSchema;

export const agentSidecarPlanRequestSchema = baseAgentRequestSchema.extend({
  goal: requiredNonEmptyStringSchema,
});

export const agentSidecarExecuteRequestSchema = baseAgentRequestSchema.extend({
  goal: requiredNonEmptyStringSchema,
  planId: requiredNonEmptyStringSchema,
  planVersion: z.number().int().positive(),
  planStepId: requiredNonEmptyStringSchema,
});

export const agentSidecarPlanValidateRequestSchema = baseAgentRequestSchema.extend({
  planId: requiredNonEmptyStringSchema,
  planVersion: z.number().int().positive(),
});

export const agentSidecarPlanReplanRequestSchema = baseAgentRequestSchema.extend({
  goal: requiredNonEmptyStringSchema,
  planId: requiredNonEmptyStringSchema,
  planVersion: z.number().int().positive(),
});

const planVersionRequestSchema = z.object({
  sessionId: optionalNonEmptyStringSchema,
  planId: requiredNonEmptyStringSchema,
  version: z.number().int().positive(),
});

export const agentSidecarPlanApproveRequestSchema = planVersionRequestSchema;

export const agentSidecarPlanRejectRequestSchema = planVersionRequestSchema.extend({
  reason: optionalNonEmptyStringSchema,
});

export const agentSidecarPlanFinishRequestSchema = planVersionRequestSchema.extend({
  status: z.enum(['completed', 'failed']),
  errorMessage: optionalNonEmptyStringSchema,
});

export const agentSidecarPlanQueryRequestSchema = z.object({
  sessionId: optionalNonEmptyStringSchema,
  planId: requiredNonEmptyStringSchema,
  version: z.number().int().positive().optional(),
});

export const approvalResolutionSchema = baseAgentRequestSchema.extend({
  sessionId: optionalNonEmptyStringSchema,
  requestId: z.string().min(1),
  decision: approvalDecisionSchema,
});

/**
 * 把单字符串归一为单元素数组；输出永远是 `string[]`，
 * 结构上兼容 `TRollbackStepPath = readonly string[]`。
 */
const rollbackStepSchema = z.preprocess(
  (value) => (typeof value === 'string' ? [value] : value),
  z.array(requiredNonEmptyStringSchema).min(1),
);

export const agentSidecarRollbackRestoreRequestSchema = z.object({
  sessionId: optionalNonEmptyStringSchema,
  runId: requiredNonEmptyStringSchema,
  snapshotId: optionalNonEmptyStringSchema,
  step: rollbackStepSchema.optional(),
  modelConfig: requestScopedModelConfigSchema.optional(),
});

// Phase 2：原生编排 workflow 入口（默认关闭，AGENT_ORCHESTRATION_WORKFLOW=1 才启用）。
export const agentSidecarOrchestrateRequestSchema = z.object({
  goal: requiredNonEmptyStringSchema,
  threadId: optionalNonEmptyStringSchema,
  modelConfig: requestScopedModelConfigSchema.optional(),
});

// Phase 2b：恢复一个被挂起的编排 run（需携带 start 返回的 runId）。
// 三类挂起点统一走此入口：计划审批门(approve/reject)、工具审批(approve/reject)、
// 逐步闸门(continue/cancel)；server 只透传 decision，step 内部读 suspendData.reason 解释。
// Phase 3b：modelConfig 可选：内存未命中需从快照重建 run 时，用它传递请求级模型。
export const agentSidecarOrchestrateResumeRequestSchema = z.object({
  runId: requiredNonEmptyStringSchema,
  decision: z.enum(['approve', 'reject', 'continue', 'cancel']),
  reason: optionalNonEmptyStringSchema,
  modelConfig: requestScopedModelConfigSchema.optional(),
});
