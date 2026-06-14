/* ============================================================================
 * reduceThread：AI 会话流式事件的唯一写入真源（ADR-0013）
 *
 * 纯函数、无 I/O、无副作用、不突变输入：结构共享，未变 entry 保持原
 * 引用（为渲染层的稳定 key 复用提供基础）。可在 Node 单测中脱离 Vue/Tauri 运行。
 *
 * 对标 Zed `crates/acp_thread/src/acp_thread.rs`：
 * - push_assistant_content_block：文本 delta 合并进最后一个同通道 chunk
 * - upsert_tool_call：按 id upsert，绝不重复 append
 * - ToolCallStatus：终态不可回退的单向收敛
 * ========================================================================== */
import type {
  IAiThread,
  IAiThreadAssistantChunk,
  IAiThreadAssistantMessageEntry,
  IAiThreadContentBlock,
  IAiThreadEntry,
  IAiThreadToolCall,
  TAiThreadToolCallStatus,
} from '@/types/ai/thread';
import type {
  TAiAssistantChannel,
  TAiThreadReduceEvent,
  TAiThreadReduceEventByKind,
} from '@/store/aiThread/events';

/* ----- Tool-call status state machine ------------------------------------ */
const TERMINAL_TOOL_STATUSES: ReadonlySet<TAiThreadToolCallStatus> = new Set([
  'completed',
  'failed',
  'canceled',
]);

export function isTerminalToolStatus(status: TAiThreadToolCallStatus): boolean {
  return TERMINAL_TOOL_STATUSES.has(status);
}

/**
 * 状态转移：终态（completed | failed | canceled）不可回退。其余转移接受
 * 请求状态。对标 Zed ToolCallStatus 的单向收敛。
 */
export function nextToolStatus(
  current: TAiThreadToolCallStatus,
  requested: TAiThreadToolCallStatus,
): TAiThreadToolCallStatus {
  if (isTerminalToolStatus(current)) {
    return current;
  }
  return requested;
}

/* ----- Immutable helpers -------------------------------------------------- */
function replaceAt<T>(items: readonly T[], index: number, next: T): T[] {
  const copy = items.slice();
  copy[index] = next;
  return copy;
}

/* ----- Assistant chunk merging (push_assistant_content_block) ------------- */
function appendAssistantText(
  entry: IAiThreadAssistantMessageEntry,
  channel: TAiAssistantChannel,
  text: string,
): IAiThreadAssistantMessageEntry {
  const { chunks } = entry;
  const last = chunks[chunks.length - 1];
  if (last && last.type === channel && last.block.type === 'text') {
    const mergedChunk = {
      ...last,
      block: { ...last.block, text: last.block.text + text },
    } as IAiThreadAssistantChunk;
    return { ...entry, chunks: [...chunks.slice(0, -1), mergedChunk] };
  }
  const newChunk = {
    type: channel,
    block: { type: 'text', text },
  } as IAiThreadAssistantChunk;
  return { ...entry, chunks: [...chunks, newChunk] };
}

function pushAssistantBlock(
  entry: IAiThreadAssistantMessageEntry,
  channel: TAiAssistantChannel,
  block: IAiThreadContentBlock,
): IAiThreadAssistantMessageEntry {
  const newChunk = { type: channel, block } as IAiThreadAssistantChunk;
  return { ...entry, chunks: [...entry.chunks, newChunk] };
}

function upsertAssistantChunk(
  thread: IAiThread,
  event: TAiThreadReduceEventByKind<'assistant_delta' | 'assistant_block'>,
): IAiThread {
  const index = thread.entries.findIndex(
    (entry) => entry.type === 'assistant_message' && entry.id === event.messageId,
  );

  const applyTo = (entry: IAiThreadAssistantMessageEntry): IAiThreadAssistantMessageEntry =>
    event.kind === 'assistant_delta'
      ? appendAssistantText(entry, event.channel, event.text)
      : pushAssistantBlock(entry, event.channel, event.block);

  if (index === -1) {
    const seeded = applyTo({
      type: 'assistant_message',
      id: event.messageId,
      createdAt: event.createdAt,
      chunks: [],
    });
    return { ...thread, entries: [...thread.entries, seeded] };
  }

  const current = thread.entries[index] as IAiThreadAssistantMessageEntry;
  return { ...thread, entries: replaceAt(thread.entries, index, applyTo(current)) };
}

/* ----- Tool-call upsert (upsert_tool_call) -------------------------------- */
function applyToolEvent(
  current: IAiThreadToolCall,
  event: TAiThreadReduceEventByKind<
    'tool_started' | 'tool_progress' | 'tool_completed' | 'tool_canceled'
  >,
): IAiThreadToolCall {
  switch (event.kind) {
    case 'tool_started':
      return {
        ...current,
        title: event.title || current.title,
        kind: event.toolKind ?? current.kind,
        status: nextToolStatus(current.status, event.status ?? 'in_progress'),
      };
    case 'tool_progress':
      return {
        ...current,
        status: nextToolStatus(current.status, 'in_progress'),
        content: event.appendContent
          ? [...current.content, ...event.appendContent]
          : current.content,
      };
    case 'tool_completed':
      return {
        ...current,
        status: nextToolStatus(current.status, event.ok ? 'completed' : 'failed'),
        content: event.appendContent
          ? [...current.content, ...event.appendContent]
          : current.content,
      };
    case 'tool_canceled':
      return { ...current, status: nextToolStatus(current.status, 'canceled') };
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return current;
    }
  }
}

function upsertToolCall(
  thread: IAiThread,
  event: TAiThreadReduceEventByKind<
    'tool_started' | 'tool_progress' | 'tool_completed' | 'tool_canceled'
  >,
): IAiThread {
  const index = thread.entries.findIndex(
    (entry) => entry.type === 'tool_call' && entry.id === event.id,
  );

  if (index === -1) {
    // 对尚不存在的 tool_call 的 progress/completed/canceled：鲁棒兑底，忽略
    // （记 warning 的职责在 listener 层）。仅 tool_started 创建新条目。
    if (event.kind !== 'tool_started') {
      return thread;
    }
    const entry: IAiThreadEntry = {
      type: 'tool_call',
      id: event.id,
      createdAt: event.createdAt,
      title: event.title,
      kind: event.toolKind,
      status: event.status ?? 'in_progress',
      content: [],
    };
    return { ...thread, entries: [...thread.entries, entry] };
  }

  const current = thread.entries[index] as IAiThreadToolCall;
  return { ...thread, entries: replaceAt(thread.entries, index, applyToolEvent(current, event)) };
}

/* ----- Stream finalization ------------------------------------------------ */
function finalizeNonTerminalTools(
  thread: IAiThread,
  terminal: Extract<TAiThreadToolCallStatus, 'canceled' | 'failed'>,
): IAiThread {
  let changed = false;
  const entries = thread.entries.map((entry) => {
    if (entry.type === 'tool_call' && !isTerminalToolStatus(entry.status)) {
      changed = true;
      return { ...entry, status: terminal };
    }
    return entry;
  });
  return changed ? { ...thread, entries } : thread;
}

/* ----- Public reducer ----------------------------------------------------- */
export function reduceThread(thread: IAiThread, event: TAiThreadReduceEvent): IAiThread {
  switch (event.kind) {
    case 'user_message': {
      const entry: IAiThreadEntry = {
        type: 'user_message',
        id: event.id,
        createdAt: event.createdAt,
        content: event.blocks,
      };
      return { ...thread, entries: [...thread.entries, entry] };
    }
    case 'assistant_delta':
    case 'assistant_block':
      return upsertAssistantChunk(thread, event);
    case 'tool_started':
    case 'tool_progress':
    case 'tool_completed':
    case 'tool_canceled':
      return upsertToolCall(thread, event);
    case 'stream_cancelled':
      return finalizeNonTerminalTools(thread, 'canceled');
    case 'stream_error':
      return finalizeNonTerminalTools(thread, 'failed');
    case 'stream_completed':
      return thread;
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return thread;
    }
  }
}

/** 依次应用一段事件序列（事件回放）。 */
export function reduceThreadAll(
  thread: IAiThread,
  events: readonly TAiThreadReduceEvent[],
): IAiThread {
  return events.reduce(reduceThread, thread);
}
