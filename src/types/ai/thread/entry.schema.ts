import { z } from 'zod';

import { aiTaskPlanStepSchema } from '@/types/ai/agent.schema';
import { aiContextReferenceSchema } from '@/types/ai/context.schema';
import { aiAgentPatchSummarySchema } from '@/types/ai/patch.schema';
import { aiThreadContentBlockSchema } from '@/types/ai/thread/content-block.schema';
import {
  aiThreadScrollStateSchema,
  aiThreadTitleStatusSchema,
} from '@/types/ai/thread/meta.schema';
import { aiThreadToolCallSchema } from '@/types/ai/thread/tool-call.schema';

/* ============================================================================
 * ThreadEntry / AssistantChunk / Thread（对标 Zed `AgentThreadEntry` 与
 * `AssistantMessage { chunks }`）
 *
 * 单一真源：本文件定义 schema，类型在 `index.ts` 由 `z.infer` 推导，
 * 不手写并行接口（终结现状 `IAiChatMessage` 与 schema 的漂移）。
 * ========================================================================== */

/**
 * 助手消息 chunk：正文与思维链是同一条 `chunks` 流的两种 variant，
 * 保证两者按到达顺序自然交织（对标 `AssistantMessageChunk`）。
 */
export const aiThreadAssistantChunkSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), block: aiThreadContentBlockSchema }),
  z.object({ type: z.literal('thought'), block: aiThreadContentBlockSchema }),
]);

export const aiThreadUserMessageEntrySchema = z.object({
  type: z.literal('user_message'),
  id: z.string().min(1),
  createdAt: z.string().min(1),
  content: z.array(aiThreadContentBlockSchema),
  references: z.array(aiContextReferenceSchema).default([]),
});

export const aiThreadAssistantMessageEntrySchema = z.object({
  type: z.literal('assistant_message'),
  id: z.string().min(1),
  createdAt: z.string().min(1),
  chunks: z.array(aiThreadAssistantChunkSchema),
  /** 对标 Zed `indented`（嵌套子代理输出的缩进展示）。 */
  indented: z.boolean().optional(),
  /** 对标 Zed `is_subagent_output`。 */
  isSubagentOutput: z.boolean().optional(),
});

/**
 * Plan entry（对标 `CompletedPlan`）。复用现有 `aiTaskPlanStepSchema` 作为
 * 计划步骤的单一真源。开放问题（ADR-0012）：是否由当前边车产生待确认，
 * 未产生时可定义但暂不渲染。
 */
export const aiThreadPlanEntrySchema = z.object({
  type: z.literal('plan'),
  id: z.string().min(1),
  createdAt: z.string().min(1),
  steps: z.array(aiTaskPlanStepSchema),
});

/**
 * Plan 控制 entry（审批 / 运行控制，对标渲染层 plan-control）。承载目标与引用，
 * phase 区分待批准 / 运行中。由 legacy-adapter 从 agentConfirmation 映射，
 * 投影层据此把审批卡并入平铺时间线（非独立仪表盘）。
 */
export const aiThreadPlanControlEntrySchema = z.object({
  type: z.literal('plan_control'),
  id: z.string().min(1),
  createdAt: z.string().min(1),
  goal: z.string().min(1),
  references: z.array(aiContextReferenceSchema).default([]),
  phase: z.enum(['awaiting-approval', 'running']),
});

/** Context compaction entry（对标 `ContextCompaction`）。 */
export const aiThreadContextCompactionEntrySchema = z.object({
  type: z.literal('context_compaction'),
  id: z.string().min(1),
  createdAt: z.string().min(1),
  message: z.string().optional(),
});

/**
 * Changed-files entry：内嵌完整 patch 摘要快照，使 thread entries 自洽可持久化。
 * 投影层据此渲染 changed-files-summary；应用/撤销同一 patch 按 id upsert，
 * 避免与 aiAgent store 的 patch 摘要错位（位置由首次 createdAt 固定）。
 */
export const aiThreadChangedFilesEntrySchema = z.object({
  type: z.literal('changed_files'),
  id: z.string().min(1),
  createdAt: z.string().min(1),
  summary: aiAgentPatchSummarySchema,
});

export const aiThreadEntrySchema = z.discriminatedUnion('type', [
  aiThreadUserMessageEntrySchema,
  aiThreadAssistantMessageEntrySchema,
  aiThreadToolCallSchema,
  aiThreadPlanEntrySchema,
  aiThreadPlanControlEntrySchema,
  aiThreadContextCompactionEntrySchema,
  aiThreadChangedFilesEntrySchema,
]);

/**
 * 线程：沿用现有 `aiConversationThreadSchema` 的元信息（title / titleStatus /
 * scrollState）以最小化迁移面，差异在于用 `entries`（ThreadEntry[]）
 * 取代扁平的 `messages`。
 */
export const aiThreadSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  titleStatus: aiThreadTitleStatusSchema.catch('temporary'),
  createdAt: z.string().trim().min(1),
  updatedAt: z.string().trim().min(1),
  entries: z.array(aiThreadEntrySchema),
  scrollState: aiThreadScrollStateSchema.optional(),
});
