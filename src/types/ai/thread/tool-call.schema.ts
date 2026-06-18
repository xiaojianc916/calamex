import { z } from 'zod';

import { aiDiffEditorPreviewSchema } from '@/types/ai/patch.schema';
import { AI_TOOL_CALL_STATUSES, AI_TOOL_KINDS } from '@/types/ai/thread/constants';
import { aiThreadContentBlockSchema } from '@/types/ai/thread/content-block.schema';

/* ============================================================================
 * ToolCall（对标 Zed `ToolCall` / `ToolCallStatus` / `ToolCallContent`）
 *
 * 工具调用是带显式状态机的独立 entry（与 assistant_message 同级）。
 * reduce 层（ADR-0013）按 `id` 对它 upsert，绝不重复 append。
 * ========================================================================== */

export const aiThreadToolCallStatusSchema = z.enum(AI_TOOL_CALL_STATUSES);

/** 未知工具种类兑底为 `other`，不阻断渲染（见 constants 的开放问题）。 */
export const aiThreadToolKindSchema = z.enum(AI_TOOL_KINDS).catch('other');

/* ----- ToolCallContent variants ------------------------------------------ */
export const aiThreadToolCallContentBlockSchema = z.object({
  type: z.literal('content'),
  block: aiThreadContentBlockSchema,
});

/** diff 内容复用现有 `aiDiffEditorPreviewSchema`，保持单一真源（不另造 diff 模型）。 */
export const aiThreadToolCallDiffSchema = z.object({
  type: z.literal('diff'),
  diff: aiDiffEditorPreviewSchema,
});

export const aiThreadToolCallTerminalSchema = z.object({
  type: z.literal('terminal'),
  terminalId: z.string().min(1),
});

export const aiThreadToolCallContentSchema = z.discriminatedUnion('type', [
  aiThreadToolCallContentBlockSchema,
  aiThreadToolCallDiffSchema,
  aiThreadToolCallTerminalSchema,
]);

/* ----- ToolCallLocation --------------------------------------------------- */
/**
 * 工具触及的文件位置（对标 ACP `ToolCallLocation` / Zed follow-along）。
 * `line` 为可选行号（缺省表示仅定位到文件）。仅 ACP 源会携带 locations；
 * runtime / wire 源不产出，故在 ToolCall 上整体可选。
 */
export const aiThreadToolCallLocationSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().nonnegative().optional(),
});

/* ----- ToolCall entry ----------------------------------------------------- */
export const aiThreadToolCallSchema = z.object({
  type: z.literal('tool_call'),
  /** 对标 `acp::ToolCallId`；reduce 按它 upsert。 */
  id: z.string().min(1),
  createdAt: z.string().min(1),
  /** 对标 `label`（预解析展示名）。 */
  title: z.string(),
  kind: aiThreadToolKindSchema,
  status: aiThreadToolCallStatusSchema,
  content: z.array(aiThreadToolCallContentSchema),
  /** 工具触及的文件位置；出现即整体替换（对齐 content 的 ACP upsert 语义）。 */
  locations: z.array(aiThreadToolCallLocationSchema).optional(),
  /** 透传工具原始入/出参（任意形状，仅调试/详情展示用）。 */
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
});
