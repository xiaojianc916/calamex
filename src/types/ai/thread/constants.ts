/* ============================================================================
 * AI Thread 协议层常量（ADR-0011 / ADR-0012）
 *
 * 这些字面量数组是 thread 数据模型的“单一真源”之根：schema 用
 * `z.enum(AI_*)` 引用它们，类型用 `(typeof AI_*)[number]` 推导，与项目
 * 其他 `src/types/ai/*.ts` 的惯例一致（参见 `stream.ts` / `web.ts`）。
 *
 * 语义对齐 Zed `crates/acp_thread/src/acp_thread.rs`：
 * - `AgentThreadEntry` → AI_THREAD_ENTRY_TYPES
 * - `AssistantMessageChunk { Message, Thought }` → AI_ASSISTANT_CHUNK_TYPES
 * - `ToolCallStatus` → AI_TOOL_CALL_STATUSES
 * - `ToolCallContent { ContentBlock, Diff, Terminal }` → AI_TOOL_CALL_CONTENT_TYPES
 * ========================================================================== */

/** 线程条目类型（扁平 entry 列表，对标 `AgentThreadEntry`）。 */
export const AI_THREAD_ENTRY_TYPES = [
  'user_message',
  'assistant_message',
  'tool_call',
  'plan',
  'plan_control',
  'context_compaction',
  'changed_files',
] as const;

/** 助手消息 chunk 类型（正文 / 思维链，对标 `AssistantMessageChunk`）。 */
export const AI_ASSISTANT_CHUNK_TYPES = ['message', 'thought'] as const;

/** 内容块类型（对标 `ContentBlock`；文本 / 图片 / 资源链接 / 来源）。 */
export const AI_CONTENT_BLOCK_TYPES = ['text', 'image', 'resource_link', 'source'] as const;

/**
 * 工具调用状态（对标 `ToolCallStatus`）。
 *
 * 包含 `pending`（已展示但未开始执行），与 Zed 一致。合法转移由 reduce
 * 层（ADR-0013）约束：pending → in_progress → completed | failed；
 * pending | in_progress → canceled。
 */
export const AI_TOOL_CALL_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'failed',
  'canceled',
] as const;

/** 工具调用产出内容类型（对标 `ToolCallContent`）。 */
export const AI_TOOL_CALL_CONTENT_TYPES = ['content', 'diff', 'terminal'] as const;

/**
 * 工具种类（对齐 `acp::ToolKind`）。
 *
 * 开放问题（ADR-0012）：最终取值以边车实际产出为准核对。未知种类由
 * schema 的 `.catch('other')` 兑底，不阻断渲染。
 */
export const AI_TOOL_KINDS = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
] as const;

export type TAiThreadEntryType = (typeof AI_THREAD_ENTRY_TYPES)[number];
export type TAiAssistantChunkType = (typeof AI_ASSISTANT_CHUNK_TYPES)[number];
export type TAiContentBlockType = (typeof AI_CONTENT_BLOCK_TYPES)[number];
export type TAiThreadToolCallStatus = (typeof AI_TOOL_CALL_STATUSES)[number];
export type TAiThreadToolCallContentType = (typeof AI_TOOL_CALL_CONTENT_TYPES)[number];
export type TAiThreadToolKind = (typeof AI_TOOL_KINDS)[number];
