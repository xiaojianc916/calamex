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
import type { IAiChatMessage } from '@/types/ai';
import type { IAiConversationThread } from '@/types/ai/conversation.schema';
import type {
  IAiThread,
  IAiThreadAssistantMessageEntry,
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
    name: toolCall.name,
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
  const assistantChunks: IAiThreadAssistantMessageEntry['chunks'] =
    message.content.trim().length > 0
      ? [{ type: 'message', block: { type: 'text', text: message.content } }]
      : [];
  // 有正文 / 流式快照 / acpToolCalls 任一即生成 assistant_message entry，使 stream 与
  // acpToolCalls 在「仅工具调用、无最终正文」的回合也不被丢弃（逆投影据此无损还原）。
  if (
    assistantChunks.length > 0 ||
    message.stream !== undefined ||
    (message.acpToolCalls?.length ?? 0) > 0
  ) {
    const assistantEntry: IAiThreadAssistantMessageEntry = {
      type: 'assistant_message',
      id: message.id,
      createdAt: message.createdAt,
      chunks: assistantChunks,
      ...(message.stream !== undefined ? { stream: message.stream } : {}),
      ...(message.acpToolCalls !== undefined ? { acpToolCalls: message.acpToolCalls } : {}),
      ...(message.patches && message.patches.length > 0 ? { patches: [...message.patches] } : {}),
    };
    entries.push(assistantEntry);
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

type IAiThreadUserMessageContent = Extract<IAiThreadEntry, { type: 'user_message' }>['content'];
type IAiThreadAssistantChunks = Extract<IAiThreadEntry, { type: 'assistant_message' }>['chunks'];

/* ============================================================================
 * Thread -> Legacy 逆投影（ADR-0014 Step 8 ④：entries 单一真源 -> 旧编排器工作缓冲）
 *
 * 正向把 message 展开为 entries；本逆向把 entries 折叠回 useAiAssistant 所需的
 * IAiChatMessage[] 工作缓冲。entries 成为持久化与渲染唯一真源后，编排器在切换/水合
 * 线程时用本逆投影重建 message 缓冲（续聊上下文 toSidecarMessages、历史首轮、会话内
 * checkpoint 计算），不再读取 legacy store。
 *
 * 无损往返（ADR-0014 ④.1 Approach B）：
 * - assistant_message entry 承载 stream（status/runtimeEvents/activityText/token/usage/
 *   finalAnswerStarted）与 acpToolCalls；tool_call entry 承载原始 name。故 messages ↔
 *   entries 往返保真：会话内 checkpoint（依赖 runtime events）、token 统计、工具名均还原。
 * - 折叠规则与正向对称：相邻 tool_call 归并到其后的 assistant_message；changed_files
 *   回挂到对应 assistant；plan / plan_control / context_compaction 续聊无需，跳过。
 * 残余有损（不影响编排器工作缓冲）：tool_call 的 targetPreview/detailItems 合并为
 *   detailItems；plan_control（agentConfirmation）续聊不还原。
 * ========================================================================== */

/** 新状态机 -> 旧工具状态（LEGACY_TOOL_STATUS_MAP 的逆）。 */
const REVERSE_TOOL_STATUS_MAP: Record<TAiThreadToolCallStatus, LegacyToolStatus> = {
  pending: 'pending',
  in_progress: 'running',
  completed: 'succeeded',
  failed: 'failed',
  canceled: 'denied',
};

function toolCallEntryContentToDetailItems(content: IAiThreadToolCall['content']): string[] {
  return content.flatMap((item) =>
    item.type === 'content' && item.block.type === 'text' ? [item.block.text] : [],
  );
}

function threadToolCallEntryToLegacy(entry: IAiThreadToolCall): LegacyToolCall {
  const detailItems = toolCallEntryContentToDetailItems(entry.content);
  const rawOutput = entry.rawOutput as { elapsedMs?: number } | undefined;
  const elapsedMs = typeof rawOutput?.elapsedMs === 'number' ? rawOutput.elapsedMs : undefined;
  return {
    id: entry.id,
    name: entry.name ?? entry.title,
    summary: entry.title,
    status: REVERSE_TOOL_STATUS_MAP[entry.status],
    ...(detailItems.length > 0 ? { detailItems } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
  };
}

function userEntryContentToText(content: IAiThreadUserMessageContent): string {
  return content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n\n');
}

function assistantChunksToText(chunks: IAiThreadAssistantChunks): string {
  return chunks
    .flatMap((chunk) =>
      chunk.type === 'message' && chunk.block.type === 'text' ? [chunk.block.text] : [],
    )
    .join('');
}

/**
 * 把 entries 折叠为 IAiChatMessage[]（legacyMessageToEntries 的逆）。
 * 用于编排器从 entries 真源重建 message 工作缓冲；有损项见文件头说明。
 */
export function threadEntriesToMessages(entries: readonly IAiThreadEntry[]): IAiChatMessage[] {
  const messages: IAiChatMessage[] = [];
  let pendingToolCalls: LegacyToolCall[] = [];
  let pendingToolCreatedAt: string | null = null;

  const flushPendingToolCalls = (): void => {
    if (pendingToolCalls.length === 0) {
      return;
    }
    messages.push({
      role: 'assistant',
      id: pendingToolCalls[0]!.id + ':assistant',
      content: '',
      createdAt: pendingToolCreatedAt ?? new Date().toISOString(),
      references: [],
      toolCalls: pendingToolCalls,
    });
    pendingToolCalls = [];
    pendingToolCreatedAt = null;
  };

  for (const entry of entries) {
    switch (entry.type) {
      case 'user_message': {
        flushPendingToolCalls();
        messages.push({
          role: 'user',
          id: entry.id,
          content: userEntryContentToText(entry.content),
          createdAt: entry.createdAt,
          references: entry.references,
        });
        break;
      }
      case 'tool_call': {
        pendingToolCalls.push(threadToolCallEntryToLegacy(entry));
        pendingToolCreatedAt = pendingToolCreatedAt ?? entry.createdAt;
        break;
      }
      case 'assistant_message': {
        const message: IAiChatMessage = {
          role: 'assistant',
          id: entry.id,
          content: assistantChunksToText(entry.chunks),
          createdAt: entry.createdAt,
          references: [],
          ...(pendingToolCalls.length > 0 ? { toolCalls: pendingToolCalls } : {}),
          ...(entry.stream !== undefined ? { stream: entry.stream } : {}),
          ...(entry.acpToolCalls !== undefined ? { acpToolCalls: entry.acpToolCalls } : {}),
          ...(entry.patches !== undefined ? { patches: entry.patches } : {}),
        };
        pendingToolCalls = [];
        pendingToolCreatedAt = null;
        messages.push(message);
        break;
      }
      case 'changed_files': {
        flushPendingToolCalls();
        const target = messages.at(-1);
        if (target && target.role === 'assistant' && !target.changedFilesSummary) {
          target.changedFilesSummary = entry.summary;
        } else {
          messages.push({
            role: 'assistant',
            id: entry.summary.id + ':assistant',
            content: '',
            createdAt: entry.createdAt,
            references: [],
            changedFilesSummary: entry.summary,
          });
        }
        break;
      }
      default:
        // plan / plan_control / context_compaction：续聊上下文与历史首轮无需，跳过（有损可接受）。
        break;
    }
  }

  flushPendingToolCalls();
  return messages;
}

/** 把 IAiThread（entries）折叠回 legacy 会话线程（legacyThreadToThread 的逆，沿用元信息）。 */
export function threadToLegacyThread(thread: IAiThread): IAiConversationThread {
  return {
    id: thread.id,
    title: thread.title,
    titleStatus: thread.titleStatus,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    messages: threadEntriesToMessages(thread.entries),
    ...(thread.scrollState ? { scrollState: thread.scrollState } : {}),
  };
}
