import { z } from 'zod';
import {
  aiAgentClassifyTaskPayloadSchema,
  aiAgentClassifyTaskRequestSchema,
  aiAgentListRunsPayloadSchema,
  aiAgentNetworkPermissionPayloadSchema,
  aiAgentNetworkPermissionSchema,
  aiAgentPermissionLevelSchema,
  aiAgentPermissionScopeSchema,
  aiAgentPermissionStateSchema,
  aiAgentPlanReferenceSchema,
  aiAgentPlanReferenceTypeSchema,
  aiAgentPlanRiskLevelSchema,
  aiAgentPlanStepKindSchema,
  aiAgentPlanStepStatusSchema,
  aiAgentResolveToolConfirmationRequestSchema,
  aiAgentRunIdRequestSchema,
  aiAgentRunPayloadSchema,
  aiAgentRunPlanRequestSchema,
  aiAgentRunSchema,
  aiAgentRunStatusSchema,
  aiAgentRunStepRequestSchema,
  aiAgentSetNetworkPermissionRequestSchema,
  aiAgentStepDetailSchema,
  aiAgentStepToolResultSummarySchema,
  aiAgentStepWebSourceSummarySchema,
  aiAgentTaskClassificationSchema,
  aiAgentTimelineItemSchema,
  aiAgentTimelineItemStatusSchema,
  aiAgentTimelineItemTypeSchema,
  aiAgentToolNameSchema,
  aiTaskPlanStepSchema,
} from '@/types/ai/agent.schema';
import {
  aiContextKindSchema,
  aiContextRangeSchema,
  aiContextReferenceSchema,
} from '@/types/ai/context.schema';
import {
  aiAgentChangedFileSchema,
  aiAgentChangedFileStatusSchema,
  aiAgentPatchSummarySchema,
  aiDiffEditorPreviewSchema,
  aiDiffHunkPreviewSchema,
  aiDiffPreviewLineKindSchema,
  aiDiffPreviewLineSchema,
} from '@/types/ai/patch.schema';
import { agentRuntimeEventSchema } from '@/types/ai/sidecar.schema';
import {
  aiWebActivityStateSchema,
  aiWebFetchInputSchema,
  aiWebFetchPayloadSchema,
  aiWebFetchResultSchema,
  aiWebSearchInputSchema,
  aiWebSearchIntentSchema,
  aiWebSearchPayloadSchema,
  aiWebSearchRecencySchema,
  aiWebSearchResultSchema,
  aiWebSourceEntryStatusSchema,
  aiWebSourceTypeSchema,
} from '@/types/ai/web.schema';

/* ============================================================================
 * Constants
 * ========================================================================== */

/** 对话标题最大字符数(刻意极简)。 */
const CONVERSATION_TITLE_MAX_LENGTH = 10;

/** 建议词池数量边界(请求 count 与响应 suggestions.length 共用)。 */
const SUGGESTION_POOL_MIN_COUNT = 9;
const SUGGESTION_POOL_MAX_COUNT = 90;

/** 建议词池可指定的主题数量上限。 */
const SUGGESTION_POOL_TOPICS_MAX = 24;

/** 单行 unified diff hunk 合法前缀(行首字符)。 */
export const UNIFIED_DIFF_HUNK_LINE_PREFIXES: readonly string[] = [' ', '+', '-'];

/** "文件末尾无换行符" 在 unified diff 中的固定标记行。 */
export const UNIFIED_DIFF_NO_NEWLINE_MARKER = '\\ No newline at end of file';

/* ============================================================================
 * Patch
 * ========================================================================== */

/**
 * 单行 unified diff hunk content。
 *
 * 合法形式:
 *   - `' '` 前缀:context line
 *   - `'+'` 前缀:added line
 *   - `'-'` 前缀:removed line
 *   - 字符串等于 `\\ No newline at end of file`:文件末尾无换行标记
 *
 * **不接受** hunk header (`@@ ... @@`) 与文件头 (`---`/`+++`),这些应在外层结构中。
 */
const aiUnifiedDiffHunkLineSchema = z
  .string()
  .refine(
    (value) =>
      value === UNIFIED_DIFF_NO_NEWLINE_MARKER ||
      UNIFIED_DIFF_HUNK_LINE_PREFIXES.some((prefix) => value.startsWith(prefix)),
    'Patch hunk line must be a unified diff line.',
  );

/* ============================================================================
 * Provider / model
 * ========================================================================== */

export const aiProviderTypeSchema = z.enum(['mastra']);
export const aiModelRoleSchema = z.enum(['main', 'narrator']);

/* ============================================================================
 * Chat message
 * ========================================================================== */

export const aiChatMessageActionSchema = z.object({
  id: z.enum(['allow-agent-execution']),
  label: z.string().min(1),
  disabled: z.boolean().optional(),
});

export const aiAgentConfirmationStateSchema = z.object({
  goal: z.string().min(1),
  references: z.array(aiContextReferenceSchema),
  status: z.enum(['pending', 'running']),
});

/* ----- Language model usage ---------------------------------------------- */

export const aiLanguageModelUsageInputDetailsSchema = z.object({
  noCacheTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cacheWriteTokens: z.number().nonnegative(),
});

export const aiLanguageModelUsageOutputDetailsSchema = z.object({
  textTokens: z.number().nonnegative(),
  reasoningTokens: z.number().nonnegative(),
});

/**
 * Language model 计费 / token 使用详情。
 *
 * **重要**:此 schema **不使用 `.passthrough()`**。原因:
 * - 顶层 `.passthrough()` 会在 `z.infer` 推断类型上引入 `[x: string]: unknown`
 *   索引签名,阻塞与外部库类型(例如 `LanguageModelUsage`)的赋值兼容。
 * - 需要透传 provider-specific 额外字段时,使用 `raw: unknown` 装载;
 *   schema strip 未声明字段是预期行为。
 */
export const aiLanguageModelUsageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  inputTokenDetails: aiLanguageModelUsageInputDetailsSchema.optional(),
  outputTokens: z.number().nonnegative(),
  outputTokenDetails: aiLanguageModelUsageOutputDetailsSchema.optional(),
  totalTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative().optional(),
  reasoningTokens: z.number().nonnegative().optional(),
  /** 透传 provider 原始 usage 结构(任意形状)。 */
  raw: z.unknown().optional(),
});

/* ----- Tool call --------------------------------------------------------- */

export const aiChatMessageToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'denied']),
  summary: z.string(),
  targetPreview: z.string().min(1).optional(),
  detailItems: z.array(z.string().min(1)).optional(),
  elapsedMs: z.number().nonnegative().optional(),
});

/* ----- Stream snapshot (on persisted message) ---------------------------- */

/**
 * 当 assistant message 处于流式或刚结束流式时,挂载在 message.stream 上的运行态快照。
 *
 * 注意:`promptTokens` / `completionTokens` / `totalTokens` 与 `usage` 字段
 * **包含同一份信息**。`usage` 优先,flat 三字段保留用于兼容旧消费方。
 */
export const aiChatMessageStreamSnapshotSchema = z.object({
  status: z.enum(['streaming', 'waiting-confirmation', 'completed', 'cancelled']),
  activityText: z.string().min(1).optional(),
  runtimeEvents: z.array(z.lazy(() => agentRuntimeEventSchema)).optional(),
  finalAnswerStarted: z.boolean().optional(),
  /** @deprecated 优先使用 `usage.inputTokens`;此字段仅为兼容旧 client 保留。 */
  promptTokens: z.number().nonnegative().optional(),
  /** @deprecated 优先使用 `usage.outputTokens`;此字段仅为兼容旧 client 保留。 */
  completionTokens: z.number().nonnegative().optional(),
  /** @deprecated 优先使用 `usage.totalTokens`;此字段仅为兼容旧 client 保留。 */
  totalTokens: z.number().nonnegative().optional(),
  usage: aiLanguageModelUsageSchema.optional(),
});

/* ----- Chat message ------------------------------------------------------ */

export const aiChatMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  createdAt: z.string().min(1),
  references: z.array(aiContextReferenceSchema),
  toolCalls: z.array(aiChatMessageToolCallSchema).optional(),
  actions: z.array(aiChatMessageActionSchema).optional(),
  agentConfirmation: aiAgentConfirmationStateSchema.optional(),
  stream: aiChatMessageStreamSnapshotSchema.optional(),
});

/* ============================================================================
 * Provider config / credentials
 * ========================================================================== */

export const aiModelEndpointConfigPayloadSchema = z.object({
  providerType: aiProviderTypeSchema,
  selectedModel: z.string().nullable(),
  baseUrl: z.string().nullable(),
  isBaseUrlConfigured: z.boolean(),
  hasCredentials: z.boolean(),
  isConfigured: z.boolean(),
});

export const aiCredentialStatusPayloadSchema = z.object({
  providerId: z.string().min(1),
  hasCredentials: z.boolean(),
  alias: z.string().default('厂商 API Key'),
  keyPreview: z.string().default(''),
});

export const aiConfigPayloadSchema = z.object({
  providerType: aiProviderTypeSchema,
  selectedModel: z.string().nullable(),
  baseUrl: z.string().nullable(),
  isBaseUrlConfigured: z.boolean(),
  hasCredentials: z.boolean(),
  isConfigured: z.boolean(),
  inlineCompletionEnabled: z.boolean(),
  chatEnabled: z.boolean(),
  agentEnabled: z.boolean(),
  narrator: aiModelEndpointConfigPayloadSchema,
  credentials: z.array(aiCredentialStatusPayloadSchema).default([]),
});

export const aiSaveCredentialsRequestSchema = z.object({
  providerId: z.string().min(1),
  alias: z.string().min(1).optional(),
  apiKey: z.string().min(1),
});

export const aiProviderConnectionRequestSchema = z.object({
  role: aiModelRoleSchema.optional(),
  providerId: z.string().min(1).nullable().optional(),
  providerType: aiProviderTypeSchema,
  selectedModel: z.string().nullable(),
  baseUrl: z.string().nullable(),
  inlineCompletionEnabled: z.boolean(),
  chatEnabled: z.boolean(),
  agentEnabled: z.boolean(),
  apiKey: z.string().nullable(),
});

export const aiProviderTestPayloadSchema = z.object({
  ok: z.boolean(),
  code: z.string(),
  message: z.string(),
});

export const aiProviderConnectionPayloadSchema = z.object({
  config: aiConfigPayloadSchema,
  test: aiProviderTestPayloadSchema,
});

/* ============================================================================
 * Chat request / streaming
 * ========================================================================== */

export const aiChatRequestSchema = z.object({
  threadId: z.string().nullable(),
  messages: z.array(aiChatMessageSchema).min(1),
  references: z.array(aiContextReferenceSchema),
});

export const aiChatStreamPayloadSchema = z.object({
  streamId: z.string().min(1),
  assistantMessageId: z.string().min(1),
  providerType: aiProviderTypeSchema,
  model: z.string().min(1),
});

/**
 * 流式 chat event payload。
 *
 * 字段 nullable 政策(与 `aiChatMessageStreamSnapshotSchema` 一致,均使用
 * `.optional()` 而不混 `.nullable()`):
 * - 未提供 → undefined
 * - "明确清零" 语义请用 0 / 空 usage,避免 null/undefined 二义。
 */
export const aiChatStreamEventPayloadSchema = z.object({
  streamId: z.string().min(1),
  assistantMessageId: z.string().min(1),
  kind: z.enum(['start', 'delta', 'done', 'error', 'cancelled']),
  delta: z.string().nullable(),
  message: z.string().nullable(),
  model: z.string().nullable(),
  /** @deprecated 优先使用 `usage.inputTokens`。 */
  promptTokens: z.number().nonnegative().optional(),
  /** @deprecated 优先使用 `usage.outputTokens`。 */
  completionTokens: z.number().nonnegative().optional(),
  /** @deprecated 优先使用 `usage.totalTokens`。 */
  totalTokens: z.number().nonnegative().optional(),
  usage: aiLanguageModelUsageSchema.optional(),
});

/* ============================================================================
 * Conversation title generation
 * ========================================================================== */

export const aiConversationTitleRequestSchema = z.object({
  userMessage: z.string().min(1),
  assistantMessage: z.string().min(1),
});

export const aiConversationTitlePayloadSchema = z.object({
  title: z.string().min(1).max(CONVERSATION_TITLE_MAX_LENGTH),
  model: z.string().min(1),
});

/* ============================================================================
 * Suggestion pool
 * ========================================================================== */

export const aiSuggestionPoolRequestSchema = z.object({
  count: z.number().int().min(SUGGESTION_POOL_MIN_COUNT).max(SUGGESTION_POOL_MAX_COUNT),
  locale: z.string().min(1),
  topics: z.array(z.string().min(1)).min(1).max(SUGGESTION_POOL_TOPICS_MAX),
});

/**
 * 注意:`suggestions.length` 与 request 的 `count` 不强制相等,只保证落在
 * `[SUGGESTION_POOL_MIN_COUNT, SUGGESTION_POOL_MAX_COUNT]` 区间内。
 */
export const aiSuggestionPoolPayloadSchema = z.object({
  suggestions: z
    .array(z.string().min(1))
    .min(SUGGESTION_POOL_MIN_COUNT)
    .max(SUGGESTION_POOL_MAX_COUNT),
  model: z.string().min(1),
  generatedAt: z.string().min(1),
});

/* ============================================================================
 * Patch
 * ========================================================================== */

export const aiPatchSetSchema = z.object({
  summary: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      originalHash: z.string(),
      originalModifiedAtMs: z.number().int().nonnegative().optional().nullable(),
      hunks: z.array(
        z.object({
          oldStart: z.number().int().nonnegative(),
          oldLines: z.number().int().nonnegative(),
          newStart: z.number().int().nonnegative(),
          newLines: z.number().int().nonnegative(),
          lines: z.array(aiUnifiedDiffHunkLineSchema),
        }),
      ),
    }),
  ),
});

/**
 * AI 自动 patch 的可选元数据。
 *
 * 字段语义注意:每个字段都是 `.nullable().optional()` = `T | null | undefined`。
 * 协议层区分:
 * - `undefined` = 未提供
 * - `null` = 显式置空(例如清除之前关联的 turnId)
 *
 * 不要把两者合并;消费方应同时处理两种情况。
 */
export const aiApplyPatchMetadataSchema = z.object({
  taskId: z.string().min(1).nullable().optional(),
  turnId: z.string().min(1).nullable().optional(),
  reason: z.string().min(1).nullable().optional(),
  toolCallId: z.string().min(1).nullable().optional(),
  confirmedByUser: z.boolean().nullable().optional(),
  agentRunId: z.string().min(1).nullable().optional(),
  agentStepId: z.string().min(1).nullable().optional(),
  workspaceRootPath: z.string().min(1).nullable().optional(),
});

/* ============================================================================
 * Re-exports (barrel: external schemas re-surfaced for downstream convenience)
 * ========================================================================== */

export {
  aiAgentChangedFileSchema,
  aiAgentChangedFileStatusSchema,
  aiAgentClassifyTaskPayloadSchema,
  aiAgentClassifyTaskRequestSchema,
  aiAgentListRunsPayloadSchema,
  aiAgentNetworkPermissionPayloadSchema,
  aiAgentNetworkPermissionSchema,
  aiAgentPatchSummarySchema,
  aiAgentPermissionLevelSchema,
  aiAgentPermissionScopeSchema,
  aiAgentPermissionStateSchema,
  aiAgentPlanReferenceSchema,
  aiAgentPlanReferenceTypeSchema,
  aiAgentPlanRiskLevelSchema,
  aiAgentPlanStepKindSchema,
  aiAgentPlanStepStatusSchema,
  aiAgentResolveToolConfirmationRequestSchema,
  aiAgentRunIdRequestSchema,
  aiAgentRunPayloadSchema,
  aiAgentRunPlanRequestSchema,
  aiAgentRunSchema,
  aiAgentRunStatusSchema,
  aiAgentRunStepRequestSchema,
  aiAgentSetNetworkPermissionRequestSchema,
  aiAgentStepDetailSchema,
  aiAgentStepToolResultSummarySchema,
  aiAgentStepWebSourceSummarySchema,
  aiAgentTaskClassificationSchema,
  aiAgentTimelineItemSchema,
  aiAgentTimelineItemStatusSchema,
  aiAgentTimelineItemTypeSchema,
  aiAgentToolNameSchema,
  aiContextKindSchema,
  aiContextRangeSchema,
  aiContextReferenceSchema,
  aiDiffEditorPreviewSchema,
  aiDiffHunkPreviewSchema,
  aiDiffPreviewLineKindSchema,
  aiDiffPreviewLineSchema,
  aiTaskPlanStepSchema,
  aiWebActivityStateSchema,
  aiWebFetchInputSchema,
  aiWebFetchPayloadSchema,
  aiWebFetchResultSchema,
  aiWebSearchInputSchema,
  aiWebSearchIntentSchema,
  aiWebSearchPayloadSchema,
  aiWebSearchRecencySchema,
  aiWebSearchResultSchema,
  aiWebSourceEntryStatusSchema,
  aiWebSourceTypeSchema,
};
