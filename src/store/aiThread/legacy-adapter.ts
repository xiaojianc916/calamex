/* ============================================================================
 * Legacy -> Thread 适配器（ADR-0013 / ADR-0014 Step 3）
 *
 * 把旧的扁平 `IAiChatMessage[]` 会话映射为新的 `IAiThread.entries`。
 * 纯函数、无副作用，供双轨期的“只读投影”与持久化迁移（Step 7）复用。
 *
 * 设计取舍：
 * - 旧模型中工具调用作为字段挂在 assistant message 上；新模型里 tool_call
 *   是与 assistant_message 同级的独立 entry（对标 Zed）。迁移时一条旧 assistant
 *   message 展开为：其 tool_call entries（按运行顺序在前）+ assistant_message
 *   entry（最终回答在后）。
 * - 旧消息的 `content` 是单一字符串，映射为单个 text content block。
 * - 旧消息的 references 原样透传到 user_message entry；附件映射为富块留待后续细化。
 * ========================================================================== */
import { attachChangedFileDiffsToToolCalls } from '@/components/business/ai/thread/projection/attach-changed-file-diffs';
import type { IAiConversationThread } from '@/store/aiConversation';
import type { IAiChatMessage } from '@/types/ai';
import type {
  IAiThread,
  IAiThreadEntry,
  IAiThreadToolCall,
  IAiThreadToolCallContent,
  TAiThreadToolCallStatus,
  TAiThreadToolKind,
} from '@/types/ai/thread';

type LegacyToolCall = NonNullable<IAiChatMessage['toolCalls']>[number];
type LegacyToolStatus = LegacyToolCall['status'];

/** 旧工具状态 -> 新状态机。denied 视为用户拒绝，归为 canceled 终态。 */
const LEGACY_TOOL_STATUS_MAP: Record<LegacyToolStatus, TAiThreadToolCallStatus> = {
  pending: 'pending',
  running: 'in_progress',
  succeeded: 'completed',
  failed: 'failed',
  denied: 'canceled',
};

/** 由工具名启发式推断种类；未命中兑底 other（schema 层也 .catch('other')）。 */
const TOOL_KIND_KEYWORDS: ReadonlyArray<readonly [RegExp, TAiThreadToolKind]> = [
  [/(read|cat|open|view|get[_-]?file|list)/i, 'read'],
  [/(edit|write|apply|patch|create[_-]?file|update|insert)/i, 'edit'],
  [/(delete|remove|\brm\b|unlink)/i, 'delete'],
  [/(move|rename|mv)/i, 'move'],
  [/(search|grep|find|query|lookup)/i, 'search'],
  [/(exec|run|shell|command|terminal|bash|process)/i, 'execute'],
  [/(think|reason|plan|analyze)/i, 'think'],
  [/(fetch|http|web|browse|url|download)/i, 'fetch'],
  [/(switch[_-]?mode|mode)/i, 'switch_mode'],
];

export function inferToolKind(name: string): TAiThreadToolKind {
  for (const [pattern, kind] of TOOL_KIND_KEYWORDS) {
    if (pattern.test(name)) {
      return kind;
    }
  }
  return 'other';
}

function legacyToolCallContent(toolCall: LegacyToolCall): IAiThreadToolCallContent[] {
  const content: IAiThreadToolCallContent[] = [];
  if (toolCall.targetPreview) {
    content.push({ type: 'content', block: { type: 'text', text: toolCall.targetPreview } });
  }
  for (const item of toolCall.detailItems ?? []) {
    content.push({ type: 'content', block: { type: 'text', text: item } });
  }
  return content;
}

function legacyToolCallToEntry(toolCall: LegacyToolCall, createdAt: string): IAiThreadToolCall {
  return {
    type: 'tool_call',
    id: toolCall.id,
    createdAt,
    title: toolCall.summary || toolCall.name,
    kind: inferToolKind(toolCall.name),
    status: LEGACY_TOOL_STATUS_MAP[toolCall.status],
    content: legacyToolCallContent(toolCall),
    ...(toolCall.elapsedMs !== undefined ? { rawOutput: { elapsedMs: toolCall.elapsedMs } } : {}),
  };
}

/**
 * 把一条旧消息展开为 0..n 条 entries。
 * - user -> 单条 user_message（有文本才加 text block）
 * - 其余角色 -> tool_call entries（在前）+ assistant_message（有文本才生成）
 *   + changed_files（assistant message 带 changedFilesSummary 时追加在末尾）
 *   并把改动文件内联 diff 原地挂到对应 tool_call entry（与 build-thread-entries 同源）
 */
export function legacyMessageToEntries(message: IAiChatMessage): IAiThreadEntry[] {
  if (message.role === 'user') {
    const text = message.content;
    return [
      {
        type: 'user_message',
        id: message.id,
        createdAt: message.createdAt,
        content: text.trim().length > 0 ? [{ type: 'text', text }] : [],
        references: message.references,
      },
    ];
  }

  const entries: IAiThreadEntry[] = [];
  const toolCallEntries: IAiThreadToolCall[] = [];
  for (const toolCall of message.toolCalls ?? []) {
    const toolCallEntry = legacyToolCallToEntry(toolCall, message.createdAt);
    toolCallEntries.push(toolCallEntry);
    entries.push(toolCallEntry);
  }
  if (message.content.trim().length > 0) {
    entries.push({
      type: 'assistant_message',
      id: message.id,
      createdAt: message.createdAt,
      chunks: [{ type: 'message', block: { type: 'text', text: message.content } }],
    });
  }
  if (message.agentConfirmation) {
    entries.push({
      type: 'plan_control',
      id: `${message.id}:plan-control`,
      createdAt: message.createdAt,
      goal: message.agentConfirmation.goal,
      references: message.agentConfirmation.references,
      phase: message.agentConfirmation.status === 'running' ? 'running' : 'awaiting-approval',
    });
  }
  if (message.changedFilesSummary) {
    const summary = message.changedFilesSummary;
    attachChangedFileDiffsToToolCalls(toolCallEntries, summary, message.patches ?? []);
    entries.push({
      type: 'changed_files',
      id: summary.id,
      createdAt: summary.appliedAt ?? message.createdAt,
      summary,
    });
  }
  return entries;
}

/** 把一整个 legacy 会话线程投影为 `IAiThread`（沿用元信息，仅换 entries）。 */
export function legacyThreadToThread(thread: IAiConversationThread): IAiThread {
  return {
    id: thread.id,
    title: thread.title,
    titleStatus: thread.titleStatus,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    entries: thread.messages.flatMap(legacyMessageToEntries),
    ...(thread.scrollState ? { scrollState: thread.scrollState } : {}),
  };
}
