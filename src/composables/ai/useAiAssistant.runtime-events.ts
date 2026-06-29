import type { IAiChatMessage } from '@/types/ai';
import type { IAgentCheckpointEvent, TAgentRuntimeEvent, TAgentUiEvent } from '@/types/ai/sidecar';
import type { IAiThreadEntry } from '@/types/ai/thread';

// ---------------------------------------------------------------------------
// Scoped ids + runtime-event timeline helpers (extracted from useAiAssistant.ts)
// ---------------------------------------------------------------------------

// builtin 专属遥测（非 ACP 标准）：从宿主 UI 事件流抽出对用户可见的运行时事件。
// visibility==='user' 直出；另放行两类 token 诊断事件（acontext.token.checked /
// acontext.provider_payload.checked）供运行时时间线与上下文预算读取。
const TIMELINE_DEBUG_EVENT_TYPES: ReadonlySet<TAgentRuntimeEvent['type']> = new Set([
  'acontext.token.checked',
  'acontext.provider_payload.checked',
]);

export const extractVisibleAgentRuntimeEvents = (
  events: readonly TAgentUiEvent[],
): TAgentRuntimeEvent[] =>
  events
    .filter(
      (event): event is Extract<TAgentUiEvent, { type: 'agent_event' }> =>
        event.type === 'agent_event' &&
        (event.event.visibility === 'user' || TIMELINE_DEBUG_EVENT_TYPES.has(event.event.type)),
    )
    .map((event) => event.event);

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

export const buildConversationCheckpointsFromEntries = (
  entries: readonly IAiThreadEntry[],
): IAiConversationCheckpoint[] => {
  // 对标 Zed AcpThread：检查点直接由权威 entries 派生（不再经 legacy messages 投影）。
  // 跳过「最后一条 assistant_message」——正在流式的当前回合，其 runtimeEvents 每 token
  // 变化且不应提供回滚点；其余 assistant 段各取最近一个 rollback.checkpoint.created。
  let lastAssistantIndex = -1;
  entries.forEach((entry, index) => {
    if (entry.type === 'assistant_message') {
      lastAssistantIndex = index;
    }
  });

  const checkpoints: IAiConversationCheckpoint[] = [];

  entries.forEach((entry, index) => {
    if (entry.type !== 'assistant_message' || index === lastAssistantIndex) {
      return;
    }

    const runtimeEvents = entry.stream?.runtimeEvents ?? [];

    for (let eventIndex = runtimeEvents.length - 1; eventIndex >= 0; eventIndex -= 1) {
      const event = runtimeEvents[eventIndex];

      if (!event || !isCheckpointCreatedRuntimeEvent(event)) {
        continue;
      }

      checkpoints.push({
        id: event.id,
        messageId: entry.id,
        runId: event.runId,
        snapshotId: event.snapshotId?.trim() || event.runId,
        sessionId: event.sessionId,
        createdAt: event.timestamp,
      });
      break;
    }
  });

  return checkpoints;
};

export const getLatestCheckpointEvent = (
  runtimeEvents: readonly TAgentRuntimeEvent[],
): IAgentCheckpointEvent | null => {
  for (let index = runtimeEvents.length - 1; index >= 0; index -= 1) {
    const event = runtimeEvents[index];

    if (event && isCheckpointCreatedRuntimeEvent(event)) {
      return event;
    }
  }

  return null;
};

export const collectConversationRuntimeEventsFromEntries = (
  entries: readonly IAiThreadEntry[],
): TAgentRuntimeEvent[] => {
  let collectedEvents: TAgentRuntimeEvent[] | undefined;

  for (const entry of entries) {
    if (entry.type !== 'assistant_message') {
      continue;
    }

    collectedEvents = mergeRuntimeEvents(collectedEvents, entry.stream?.runtimeEvents);
  }

  return collectedEvents ?? [];
};
