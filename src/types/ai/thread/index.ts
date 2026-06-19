/* ============================================================================
 * AI Thread 协议层公共入口（ADR-0011 / ADR-0012）
 *
 * 单一真源 = `*.schema.ts` 的 Zod schema；类型一律 `z.infer` 推导，
 * 严禁与 schema 并存的手写定义。同时承载类型与其背后的值（常量数组）。
 *
 * 注：本 sub-barrel 为纯新增，暂不在 `src/types/ai/index.ts` 主 barrel 里
 * 转出（接线在后续迁移步骤完成），以保证 step 1 零风险。
 * ========================================================================== */
import type { z } from 'zod';

import type {
  aiThreadContentBlockSchema,
  aiThreadImageBlockSchema,
  aiThreadResourceLinkBlockSchema,
  aiThreadSourceBlockSchema,
  aiThreadTextBlockSchema,
} from '@/types/ai/thread/content-block.schema';
import type {
  aiThreadAssistantChunkSchema,
  aiThreadAssistantMessageEntrySchema,
  aiThreadChangedFilesEntrySchema,
  aiThreadContextCompactionEntrySchema,
  aiThreadEntrySchema,
  aiThreadPlanControlEntrySchema,
  aiThreadPlanEntrySchema,
  aiThreadSchema,
  aiThreadUserMessageEntrySchema,
} from '@/types/ai/thread/entry.schema';
import type {
  aiThreadToolCallContentSchema,
  aiThreadToolCallLocationSchema,
  aiThreadToolCallSchema,
  aiThreadToolCallStatusSchema,
  aiThreadToolKindSchema,
} from '@/types/ai/thread/tool-call.schema';

/* ----- Schema-inferred types (single source of truth) -------------------- */
export type IAiThreadContentBlock = z.infer<typeof aiThreadContentBlockSchema>;
export type IAiThreadTextBlock = z.infer<typeof aiThreadTextBlockSchema>;
export type IAiThreadImageBlock = z.infer<typeof aiThreadImageBlockSchema>;
export type IAiThreadResourceLinkBlock = z.infer<typeof aiThreadResourceLinkBlockSchema>;
export type IAiThreadSourceBlock = z.infer<typeof aiThreadSourceBlockSchema>;

export type IAiThreadToolCall = z.infer<typeof aiThreadToolCallSchema>;
export type IAiThreadToolCallContent = z.infer<typeof aiThreadToolCallContentSchema>;
export type IAiThreadToolCallLocation = z.infer<typeof aiThreadToolCallLocationSchema>;
export type TAiThreadToolCallStatus = z.infer<typeof aiThreadToolCallStatusSchema>;
export type TAiThreadToolKind = z.infer<typeof aiThreadToolKindSchema>;

export type IAiThreadAssistantChunk = z.infer<typeof aiThreadAssistantChunkSchema>;
export type IAiThreadUserMessageEntry = z.infer<typeof aiThreadUserMessageEntrySchema>;
export type IAiThreadAssistantMessageEntry = z.infer<typeof aiThreadAssistantMessageEntrySchema>;
export type IAiThreadPlanEntry = z.infer<typeof aiThreadPlanEntrySchema>;
export type IAiThreadPlanControlEntry = z.infer<typeof aiThreadPlanControlEntrySchema>;
export type IAiThreadContextCompactionEntry = z.infer<typeof aiThreadContextCompactionEntrySchema>;
export type IAiThreadChangedFilesEntry = z.infer<typeof aiThreadChangedFilesEntrySchema>;
export type IAiThreadEntry = z.infer<typeof aiThreadEntrySchema>;
export type IAiThread = z.infer<typeof aiThreadSchema>;

export type {
  TAiAssistantChunkType,
  TAiContentBlockType,
  TAiThreadEntryType,
  TAiThreadToolCallContentType,
} from '@/types/ai/thread/constants';
/* ----- Constant value + literal-union type re-exports -------------------- */
export {
  AI_ASSISTANT_CHUNK_TYPES,
  AI_CONTENT_BLOCK_TYPES,
  AI_THREAD_ENTRY_TYPES,
  AI_TOOL_CALL_CONTENT_TYPES,
  AI_TOOL_CALL_STATUSES,
  AI_TOOL_KINDS,
} from '@/types/ai/thread/constants';
/* ----- Schema value re-exports ------------------------------------------- */
export {
  aiThreadContentBlockSchema,
  aiThreadImageBlockSchema,
  aiThreadResourceLinkBlockSchema,
  aiThreadSourceBlockSchema,
  aiThreadTextBlockSchema,
} from '@/types/ai/thread/content-block.schema';
export {
  aiThreadAssistantChunkSchema,
  aiThreadAssistantMessageEntrySchema,
  aiThreadChangedFilesEntrySchema,
  aiThreadContextCompactionEntrySchema,
  aiThreadEntrySchema,
  aiThreadPlanControlEntrySchema,
  aiThreadPlanEntrySchema,
  aiThreadSchema,
  aiThreadUserMessageEntrySchema,
} from '@/types/ai/thread/entry.schema';
export {
  aiThreadToolCallContentBlockSchema,
  aiThreadToolCallContentSchema,
  aiThreadToolCallDiffSchema,
  aiThreadToolCallLocationSchema,
  aiThreadToolCallSchema,
  aiThreadToolCallStatusSchema,
  aiThreadToolCallTerminalSchema,
  aiThreadToolKindSchema,
} from '@/types/ai/thread/tool-call.schema';
