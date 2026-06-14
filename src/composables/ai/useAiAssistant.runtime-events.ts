import type { IAiChatMessage } from '@/types/ai';
import type { IAgentCheckpointEvent, TAgentRuntimeEvent } from '@/types/ai/sidecar';

// ---------------------------------------------------------------------------
// Scoped ids + runtime-event timeline helpers (extracted from useAiAssistant.ts)
// ---------------------------------------------------------------------------

const AGENT_RUNTIME_TIMELINE_LIMIT = 32;

export interface IAiConversationCheckpoint {
  id: string;
  messageId: string;
  runId: string;
  snapshotId: string;
  sessionId: string;
  createdAt: string;
}

export const createScopedId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const createMessageId = (role: IAiChatMessage['role']): string => createScopedId(role);

export const buildInitialAgentActivityText = (): string => '';

const getRuntimeReasoningOverlapLength = (previous: string, incoming: string): number => {
  const maxLength = Math.min(previous.length, incoming.length);

  for (let length = maxLength; length > 0; length -= 1) {
    if (previous.slice(-length) === incoming.slice(0, length)) {
      return length;
    }
  }

  return 0;
};

const mergeRuntimeReasoningText = (previous: string, incoming: string): string => {
  if (!previous) {
    return incoming;
  }

  if (!incoming || previous.startsWith(incoming)) {
    return previous;
  }

  if (incoming.startsWith(previous)) {
    return incoming;
  }

  const overlapLength = getRuntimeReasoningOverlapLength(previous, incoming);

  return previous + incoming.slice(overlapLength);
};

export const compactRuntimeEvents = (
  events: readonly TAgentRuntimeEvent[],
): TAgentRuntimeEvent[] => {
  const compacted: TAgentRuntimeEvent[] = [];

  for (const event of events) {
    if (event.type === 'agent.text.delta') {
      continue;
    }

    const previous = compacted.at(-1);
    if (previous?.type === 'agent.reasoning.delta' && event.type === 'agent.reasoning.delta') {
      compacted[compacted.length - 1] = {
        ...previous,
        text: mergeRuntimeReasoningText(previous.text, event.text),
        timestamp: event.timestamp,
        seq: event.seq,
      };
      continue;
    }

    compacted.push(event);
  }

  return compacted.slice(-AGENT_RUNTIME_TIMELINE_LIMIT);
};

export const mergeRuntimeEvents = (
  currentEvents: readonly TAgentRuntimeEvent[] | undefined,
  incomingEvents: readonly TAgentRuntimeEvent[] | undefined,
): TAgentRuntimeEvent[] | undefined => {
  const nextEvents = [...(currentEvents ?? [])];

  if (!incomingEvents?.length) {
    const compactedEvents = compactRuntimeEvents(nextEvents);

    return compactedEvents.length ? compactedEvents : undefined;
  }

  const seenIds = new Set(nextEvents.map((event) => event.id));

  for (const event of incomingEvents) {
    if (seenIds.has(event.id)) {
      continue;
    }

    seenIds.add(event.id);
    nextEvents.push(event);
  }

  const compactedEvents = compactRuntimeEvents(nextEvents);

  return compactedEvents.length ? compactedEvents : undefined;
};

const isCheckpointCreatedRuntimeEvent = (
  event: TAgentRuntimeEvent,
): event is IAgentCheckpointEvent => event.type === 'rollback.checkpoint.created';

export const buildConversationCheckpoints = (
  currentMessages: readonly IAiChatMessage[],
): IAiConversationCheckpoint[] => {
  // 流式输出期间,每 token 都会让 messages 末条(正在生成的 assistant 消息)变化;
  // 而 checkpoints 计算刻意跳过末条(messageIndex >= length - 1 见下),结果其实不变。
  // 用「被实际处理的非末条消息」签名做 memo,token 增量命中缓存直接返回旧结果。
  const checkpointKey = buildCheckpointSignature(currentMessages);
  const cached = checkpointMemoCache.get(checkpointKey);
  if (cached) {
    return cached;
  }

  const checkpoints: IAiConversationCheckpoint[] = [];

  currentMessages.forEach((message, messageIndex) => {
    if (message.role !== 'assistant' || messageIndex >= currentMessages.length - 1) {
      return;
    }

    const runtimeEvents = message.stream?.runtimeEvents ?? [];

    for (let eventIndex = runtimeEvents.length - 1; eventIndex >= 0; eventIndex -= 1) {
      const event = runtimeEvents[eventIndex];

      if (!event || !isCheckpointCreatedRuntimeEvent(event)) {
        continue;
      }

      checkpoints.push({
        id: event.id,
        messageId: message.id,
        runId: event.runId,
        snapshotId: event.snapshotId?.trim() || event.runId,
        sessionId: event.sessionId,
        createdAt: event.timestamp,
      });
      break;
    }
  });

  checkpointMemoCache.set(checkpointKey, checkpoints);
  return checkpoints;
};

// checkpoint 计算只依赖「非末条 assistant 消息的 checkpoint 事件」,签名由这些消息的
// id + runtimeEvents 数组长度组成(checkpoint 事件 append-only,长度变才有新事件)。
// 末条消息(流式中的那条)不参与签名,token 增量不会改变签名 → memo 命中。
const checkpointMemoCache = new Map<string, IAiConversationCheckpoint[]>();
const CHECKPOINT_MEMO_MAX = 8;

const buildCheckpointSignature = (messages: readonly IAiChatMessage[]): string => {
  // 只取会被 buildConversationCheckpoints 实际遍历的部分:前 N-1 条。
  const last = messages.length - 1;
  let signature = '';
  for (let i = 0; i < last; i += 1) {
    const message = messages[i];
    if (message?.role !== 'assistant') continue;
    const eventCount = message.stream?.runtimeEvents?.length ?? 0;
    signature += `${message.id}:${eventCount}|`;
  }
  // 限制 memo 容量,LRU 淘汰(线程级单例,会话切换时旧 key 自然失效)
  if (checkpointMemoCache.size > CHECKPOINT_MEMO_MAX) {
    checkpointMemoCache.delete(checkpointMemoCache.keys().next().value as string);
  }
  return signature;
};

export const getLatestCheckpointEvent = (message: IAiChatMessage): IAgentCheckpointEvent | null => {
  const runtimeEvents = message.stream?.runtimeEvents ?? [];

  for (let index = runtimeEvents.length - 1; index >= 0; index -= 1) {
    const event = runtimeEvents[index];

    if (event && isCheckpointCreatedRuntimeEvent(event)) {
      return event;
    }
  }

  return null;
};

export const collectConversationRuntimeEvents = (
  currentMessages: readonly IAiChatMessage[],
): TAgentRuntimeEvent[] => {
  let collectedEvents: TAgentRuntimeEvent[] | undefined;

  for (const message of currentMessages) {
    collectedEvents = mergeRuntimeEvents(collectedEvents, message.stream?.runtimeEvents);
  }

  return collectedEvents ?? [];
};
