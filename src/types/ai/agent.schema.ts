import { z } from 'zod/v3';

import {
  AI_AGENT_NETWORK_PERMISSIONS,
  AI_AGENT_PERMISSION_SCOPES,
  AI_AGENT_PLAN_REFERENCE_TYPES,
  AI_AGENT_PLAN_RISK_LEVELS,
  AI_AGENT_PLAN_STEP_KINDS,
  AI_AGENT_PLAN_STEP_STATUSES,
  AI_AGENT_RUN_STATUSES,
  AI_AGENT_TASK_CLASSIFICATIONS,
  AI_AGENT_TIMELINE_ITEM_STATUSES,
  AI_AGENT_TIMELINE_ITEM_TYPES,
  AI_TOOL_CONFIRMATION_DECISIONS,
  AI_TOOL_CONFIRMATION_OPTION_IDS,
  AI_TOOL_CONFIRMATION_OPTION_TONES,
} from '@/types/ai/agent';
import { aiContextReferenceSchema } from '@/types/ai/context.schema';
import { UNIFIED_DIFF_HUNK_LINE_PREFIXES, UNIFIED_DIFF_NO_NEWLINE_MARKER } from '@/types/ai/schema';
import { AI_AGENT_PERMISSION_LEVELS, AI_AGENT_TOOL_NAMES } from '@/types/ai/tools';
import {
  aiWebFetchInputSchema,
  aiWebSearchInputSchema,
  aiWebSourceEntryStatusSchema,
  aiWebSourceTypeSchema,
} from '@/types/ai/web.schema';

/* ============================================================================
 * Numeric constraints (business rules; named so they're greppable & adjustable
 * in one place rather than scattered as magic numbers)
 * ========================================================================== */

/** 一个 task plan 至少 2 步、最多 6 步 —— 太少没必要 plan,太多 UI 难展示。 */
export const AI_AGENT_PLAN_MIN_STEPS = 2;
export const AI_AGENT_PLAN_MAX_STEPS = 6;

/** `stage_file` tool 一次最多暂存 32 个文件。 */
export const AI_AGENT_STAGE_FILE_MAX_PATHS = 32;

/** `auto_apply_patch` 一次 patch set 最多 20 个文件。 */
export const AI_AGENT_PATCH_SET_MAX_FILES = 20;

/** `create_commit` 的 commit message 上限 500 字符。 */
export const AI_AGENT_COMMIT_MESSAGE_MAX_CHARS = 500;

/** `run_command` 超时窗口:1s ~ 120s。 */
export const AI_AGENT_RUN_COMMAND_MIN_TIMEOUT_MS = 1_000;
export const AI_AGENT_RUN_COMMAND_MAX_TIMEOUT_MS = 120_000;

/** Tool 执行结果状态(只有 succeeded/failed 两种,running 状态是 in-flight 不会出现在 result summary 里)。 */
export const AI_AGENT_TOOL_RESULT_STATUSES = ['succeeded', 'failed'] as const;

/* ============================================================================
 * Enum schemas
 * ========================================================================== */

export const aiAgentToolNameSchema = z.enum(AI_AGENT_TOOL_NAMES);
export const aiAgentPermissionLevelSchema = z.enum(AI_AGENT_PERMISSION_LEVELS);
export const aiAgentPlanStepKindSchema = z.enum(AI_AGENT_PLAN_STEP_KINDS);
export const aiAgentPlanStepStatusSchema = z.enum(AI_AGENT_PLAN_STEP_STATUSES);
export const aiAgentPlanReferenceTypeSchema = z.enum(AI_AGENT_PLAN_REFERENCE_TYPES);
export const aiAgentPlanRiskLevelSchema = z.enum(AI_AGENT_PLAN_RISK_LEVELS);
export const aiAgentTaskClassificationSchema = z.enum(AI_AGENT_TASK_CLASSIFICATIONS);
export const aiAgentPermissionScopeSchema = z.enum(AI_AGENT_PERMISSION_SCOPES);
export const aiAgentNetworkPermissionSchema = z.enum(AI_AGENT_NETWORK_PERMISSIONS);
export const aiAgentRunStatusSchema = z.enum(AI_AGENT_RUN_STATUSES);
export const aiAgentTimelineItemTypeSchema = z.enum(AI_AGENT_TIMELINE_ITEM_TYPES);
export const aiAgentTimelineItemStatusSchema = z.enum(AI_AGENT_TIMELINE_ITEM_STATUSES);
export const aiToolConfirmationOptionIdSchema = z.enum(AI_TOOL_CONFIRMATION_OPTION_IDS);
export const aiToolConfirmationDecisionSchema = z.enum(AI_TOOL_CONFIRMATION_DECISIONS);
export const aiToolConfirmationOptionToneSchema = z.enum(AI_TOOL_CONFIRMATION_OPTION_TONES);
export const aiAgentToolResultStatusSchema = z.enum(AI_AGENT_TOOL_RESULT_STATUSES);

/* ============================================================================
 * Generic schema helpers
 *
 * `nullishOptional` 把 null → undefined 归一化,再 `.optional()`。让 caller
 * 传 null / undefined / 不传 都视作"未提供",backend 只见到 undefined。
 * ========================================================================== */

const nullishOptional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === null ? undefined : value), schema.optional());

/** 非空字符串(trim 后),可选。常用于 ID / label / path / reason 等文本字段。 */
const nullableOptionalTextSchema = nullishOptional(z.string().trim().min(1));

/* ============================================================================
 * Unified diff hunk line schema (与 ai.schema / agent-sidecar.schema 共享约束)
 *
 * 三个 schema 文件里同样的 unified-diff line 校验逻辑,通过 ai.schema 共享的
 * 常量(`UNIFIED_DIFF_HUNK_LINE_PREFIXES` / `UNIFIED_DIFF_NO_NEWLINE_MARKER`)
 * 派生,保证 prefix 列表只在一处维护。
 * ========================================================================== */

const unifiedDiffHunkLineSchema = z
  .string()
  .refine(
    (value) =>
      value === UNIFIED_DIFF_NO_NEWLINE_MARKER ||
      UNIFIED_DIFF_HUNK_LINE_PREFIXES.some((prefix) => value.startsWith(prefix)),
    'Patch hunk line must be a unified diff line.',
  );

/* ============================================================================
 * Plan references
 * ========================================================================== */

export const aiAgentPlanReferenceSchema = z.object({
  type: aiAgentPlanReferenceTypeSchema,
  label: z.string().trim().min(1),
  uri: z.string().trim().min(1),
});

/* ============================================================================
 * Tool inputs (per-tool argument schemas — gated by user confirmation /
 * permission level downstream)
 * ========================================================================== */

export const aiRunCommandToolInputSchema = z.object({
  command: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  cwdPolicy: z.literal('workspace-root'),
  timeoutMs: nullishOptional(
    z
      .number()
      .int()
      .min(AI_AGENT_RUN_COMMAND_MIN_TIMEOUT_MS)
      .max(AI_AGENT_RUN_COMMAND_MAX_TIMEOUT_MS),
  ),
});

export const aiStageFileToolInputSchema = z.object({
  paths: z.array(z.string().trim().min(1)).min(1).max(AI_AGENT_STAGE_FILE_MAX_PATHS),
  reason: z.string().trim().min(1),
});

export const aiCreateCommitToolInputSchema = z.object({
  message: z.string().trim().min(1).max(AI_AGENT_COMMIT_MESSAGE_MAX_CHARS),
  reason: z.string().trim().min(1),
  allowEmpty: nullishOptional(z.boolean()),
});

export const aiProposePatchToolInputSchema = z.object({
  path: z.string().trim().min(1),
  originalContent: z.string(),
  updatedContent: z.string(),
  summary: z.string().trim().min(1),
});

export const aiPatchHunkToolInputSchema = z.object({
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  lines: z.array(unifiedDiffHunkLineSchema).min(1),
});

export const aiPatchFileToolInputSchema = z.object({
  path: z.string().trim().min(1),
  originalHash: z.string().trim().min(1),
  originalModifiedAtMs: nullishOptional(z.number().int().nonnegative()),
  hunks: z.array(aiPatchHunkToolInputSchema).min(1),
});

export const aiPatchSetToolInputSchema = z.object({
  summary: z.string().trim().min(1),
  files: z.array(aiPatchFileToolInputSchema).min(1).max(AI_AGENT_PATCH_SET_MAX_FILES),
});

export const aiApplyPatchMetadataToolInputSchema = z.object({
  taskId: nullableOptionalTextSchema,
  turnId: nullableOptionalTextSchema,
  reason: nullableOptionalTextSchema,
  toolCallId: nullableOptionalTextSchema,
  confirmedByUser: nullishOptional(z.boolean()),
  agentRunId: nullableOptionalTextSchema,
  agentStepId: nullableOptionalTextSchema,
  workspaceRootPath: nullableOptionalTextSchema,
});

export const aiAutoApplyPatchToolInputSchema = z.object({
  patch: aiPatchSetToolInputSchema,
  metadata: nullishOptional(aiApplyPatchMetadataToolInputSchema),
});

export const aiAgentToolInputsSchema = nullishOptional(
  z.object({
    webSearch: nullishOptional(aiWebSearchInputSchema),
    webFetch: nullishOptional(aiWebFetchInputSchema),
    proposePatch: nullishOptional(aiProposePatchToolInputSchema),
    autoApplyPatch: nullishOptional(aiAutoApplyPatchToolInputSchema),
    runCommand: nullishOptional(aiRunCommandToolInputSchema),
    stageFile: nullishOptional(aiStageFileToolInputSchema),
    createCommit: nullishOptional(aiCreateCommitToolInputSchema),
  }),
);

/* ============================================================================
 * Task plan steps
 * ========================================================================== */

export const aiTaskPlanStepSchema = z.object({
  id: z.string().trim().min(1),
  index: z.number().int().nonnegative(),
  title: z.string().trim().min(1),
  goal: z.string().trim().min(1),
  kind: aiAgentPlanStepKindSchema,
  status: aiAgentPlanStepStatusSchema,
  expectedOutput: z.string().trim().min(1),
  tools: z.array(aiAgentToolNameSchema).min(1),
  toolInputs: aiAgentToolInputsSchema,
  references: nullishOptional(z.array(aiAgentPlanReferenceSchema)),
  isActive: nullishOptional(z.boolean()),
  requiresUserApproval: z.boolean(),
  riskLevel: aiAgentPlanRiskLevelSchema,
  rollbackStrategy: nullableOptionalTextSchema,
});

/* ============================================================================
 * Classify
 * ========================================================================== */

export const aiAgentClassifyTaskRequestSchema = z.object({
  goal: z.string().trim().min(1),
  // 与 aiAgentRunPlanRequestSchema 对齐:context 可省略,缺省空数组。
  context: z.array(aiContextReferenceSchema).default([]),
});

export const aiAgentClassifyTaskPayloadSchema = z.object({
  classification: aiAgentTaskClassificationSchema,
  shouldEnterPlanMode: z.boolean(),
  reason: z.string().trim().min(1),
});

/* ============================================================================
 * Run / run requests / run payloads
 * ========================================================================== */

export const aiAgentRunSchema = z.object({
  id: z.string().trim().min(1),
  goal: z.string().trim().min(1),
  status: aiAgentRunStatusSchema,
  steps: z.array(aiTaskPlanStepSchema).min(AI_AGENT_PLAN_MIN_STEPS).max(AI_AGENT_PLAN_MAX_STEPS),
  currentStepId: z.string().trim().min(1).nullable(),
  createdAt: z.string().trim().min(1),
  updatedAt: z.string().trim().min(1),
  startedAt: z.string().trim().min(1).nullable(),
  completedAt: z.string().trim().min(1).nullable(),
  errorMessage: z.string().trim().min(1).nullable(),
});

export const aiAgentRunPlanRequestSchema = z.object({
  goal: z.string().trim().min(1),
  steps: z.array(aiTaskPlanStepSchema).min(AI_AGENT_PLAN_MIN_STEPS).max(AI_AGENT_PLAN_MAX_STEPS),
  context: z.array(aiContextReferenceSchema).default([]),
});

export const aiAgentRunStepRequestSchema = z.object({
  runId: z.string().trim().min(1),
  stepId: z.string().trim().min(1).optional(),
  skipToolExecution: z.boolean().optional(),
});

export const aiAgentRunIdRequestSchema = z.object({
  runId: z.string().trim().min(1),
});

export const aiAgentRunPayloadSchema = z.object({
  run: aiAgentRunSchema,
});

export const aiAgentListRunsPayloadSchema = z.object({
  runs: z.array(aiAgentRunSchema),
});

/* ============================================================================
 * Step detail (web sources + tool result summaries)
 * ========================================================================== */

export const aiAgentStepWebSourceSummarySchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  url: z.string().url(),
  sourceType: aiWebSourceTypeSchema,
  status: aiWebSourceEntryStatusSchema,
  queryPreview: z.string(),
  fetchedAt: z.string().trim().min(1),
  textRef: nullableOptionalTextSchema,
  excerpt: nullishOptional(z.string()),
});

export const aiAgentStepToolResultSummarySchema = z.object({
  id: z.string().trim().min(1),
  runId: z.string().trim().min(1),
  stepId: z.string().trim().min(1),
  toolName: aiAgentToolNameSchema,
  // 用命名常量,而非 inline 字面量
  status: aiAgentToolResultStatusSchema,
  summary: z.string().trim().min(1),
  startedAt: z.string().trim().min(1),
  endedAt: z.string().trim().min(1),
  outputRef: nullableOptionalTextSchema,
});

export const aiAgentStepDetailSchema = z.object({
  runId: z.string().trim().min(1),
  stepId: z.string().trim().min(1),
  webSources: z.array(aiAgentStepWebSourceSummarySchema),
  toolResults: z.array(aiAgentStepToolResultSummarySchema),
  updatedAt: z.string().trim().min(1),
});

export const aiAgentTimelineItemSchema = z.object({
  id: z.string().trim().min(1),
  runId: z.string().trim().min(1),
  stepId: z.string().trim().min(1),
  type: aiAgentTimelineItemTypeSchema,
  title: z.string().trim().min(1),
  status: aiAgentTimelineItemStatusSchema,
  createdAt: z.string().trim().min(1),
  subtitle: nullableOptionalTextSchema,
  detailRef: nullableOptionalTextSchema,
});

/* ============================================================================
 * Network permissions
 * ========================================================================== */

export const aiAgentSetNetworkPermissionRequestSchema = z.object({
  permission: aiAgentNetworkPermissionSchema,
});

export const aiAgentNetworkPermissionPayloadSchema = z.object({
  permission: aiAgentNetworkPermissionSchema,
});

export const aiAgentPermissionStateSchema = z.object({
  level: aiAgentPermissionLevelSchema,
  scope: aiAgentPermissionScopeSchema,
  grantedAt: z.string().trim().min(1),
  expiresAt: z.string().trim().min(1).optional(),
  allowedHighRiskTools: z.array(aiAgentToolNameSchema),
});

/* ============================================================================
 * Tool confirmations
 * ========================================================================== */

export const aiToolConfirmationOptionSchema = z.object({
  id: aiToolConfirmationOptionIdSchema,
  label: z.string().trim().min(1),
  // 用 nullishOptional helper,与文件其他地方一致
  tone: nullishOptional(aiToolConfirmationOptionToneSchema),
});

export const aiToolConfirmationRequestSchema = z.object({
  id: z.string().trim().min(1),
  runId: z.string().trim().min(1),
  stepId: z.string().trim().min(1),
  toolName: aiAgentToolNameSchema,
  question: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  riskLevel: aiAgentPlanRiskLevelSchema,
  impact: nullableOptionalTextSchema,
  reversible: z.boolean(),
  createdAt: z.string().trim().min(1),
  options: z.array(aiToolConfirmationOptionSchema).min(1),
});

export const aiAgentResolveToolConfirmationRequestSchema = z.object({
  runId: z.string().trim().min(1),
  confirmationId: z.string().trim().min(1),
  decision: aiToolConfirmationDecisionSchema,
});
