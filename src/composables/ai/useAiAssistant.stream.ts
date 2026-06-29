import { extractVisibleAgentRuntimeEvents } from '@/composables/ai/useAiAssistant.runtime-events';
import type { useAiStream } from '@/composables/ai/useAiStream';
import type { IAiChatMessage, IAiChatStreamRenderState } from '@/types/ai';
import type { IAiEditOperation, IAiEditTimelineEntry } from '@/types/ai/edit';
import type { TAgentRuntimeEvent, TAgentUiEvent } from '@/types/ai/sidecar';

// ---------------------------------------------------------------------------
// Stream status/token + sidecar live-event helpers (extracted from useAiAssistant.ts)
// ---------------------------------------------------------------------------

const SIDECAR_MESSAGE_DELTA_PHASE_FALLBACK = 'stage';

export const mapStreamStatus = (
  status: ReturnType<typeof useAiStream>['status']['value'],
): NonNullable<IAiChatMessage['stream']>['status'] => {
  if (status === 'cancelled') {
    return 'cancelled';
  }

  if (status === 'completed') {
    return 'completed';
  }

  return 'streaming';
};

export const isNonNegativeFiniteNumber = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

export const hasMeaningfulAssistantText = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export const isAiEditOperationEntry = (
  entry: IAiEditTimelineEntry,
): entry is IAiEditTimelineEntry & { type: 'operation'; data: IAiEditOperation } =>
  entry.type === 'operation';

export const getOperationAppliedTime = (operation: IAiEditOperation): number => {
  const timestamp = Date.parse(operation.appliedAt);

  return Number.isFinite(timestamp) ? timestamp : 0;
};

export interface ILatestSidecarLiveEvents {
  errorEvent: Extract<TAgentUiEvent, { type: 'error' }> | null;
  doneEvent: Extract<TAgentUiEvent, { type: 'done' }> | null;
  messageEvent: Extract<TAgentUiEvent, { type: 'message_delta' }> | null;
}

type TUiFlushHandle =
  | { kind: 'raf'; id: number }
  | { kind: 'timeout'; id: ReturnType<typeof setTimeout> };

export interface ISidecarLiveEventBuffer {
  readonly events: readonly TAgentUiEvent[];
  push: (event: TAgentUiEvent) => void;
  flush: () => void;
  dispose: () => void;
}

/**
 * 流式 token 快照 = 共享 usage VM(aiLanguageModelUsageSchema 派生)。
 * 不再用 render-state 上已弃用的 flat inputTokens/outputTokens/totalTokens 字段。
 */
export type TSidecarStreamTokenSnapshot = NonNullable<IAiChatStreamRenderState['usage']>;

export interface ISidecarAnswerStreamMetadata {
  messageId: string;
  threadId: string | null;
  toolCalls: IAiChatMessage['toolCalls'];
  streamStatus: NonNullable<IAiChatMessage['stream']>['status'];
  activityText: string | undefined;
  runtimeEvents: NonNullable<IAiChatMessage['stream']>['runtimeEvents'] | undefined;
  streamTokenSnapshot?: TSidecarStreamTokenSnapshot;
}

export const getLatestSidecarLiveEvents = (
  events: readonly TAgentUiEvent[],
): ILatestSidecarLiveEvents => {
  const latest: ILatestSidecarLiveEvents = {
    errorEvent: null,
    doneEvent: null,
    messageEvent: null,
  };

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (!event) {
      continue;
    }

    if (!latest.errorEvent && event.type === 'error') {
      latest.errorEvent = event;
    }

    if (!latest.doneEvent && event.type === 'done') {
      latest.doneEvent = event;
    }

    if (event.type === 'message_delta') {
      if (!latest.messageEvent) {
        latest.messageEvent = event;
      }
    }

    if (latest.errorEvent && latest.doneEvent && latest.messageEvent) {
      break;
    }
  }

  return latest;
};

/**
 * done 事件 / 历史快照可能只携带已弃用的 flat token 字段(无 usage)。
 * 经此结构化视图读取旧字段,规避 TS6385(deprecated)告警,同时保留对旧负载的兼容。
 */
type TLegacyFlatTokenFields = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export const resolveSidecarDoneStreamTokenSnapshot = (
  event: Extract<TAgentUiEvent, { type: 'done' }> | null | undefined,
): TSidecarStreamTokenSnapshot | undefined => {
  if (!event) {
    return undefined;
  }

  // usage 是唯一非弃用真源:存在即直接采用。
  if (event.usage) {
    return event.usage;
  }

  // 回退:旧负载仅带 flat 字段时,经结构化视图读取(规避 deprecated 告警)并补齐为 usage VM。
  const legacyTokens: TLegacyFlatTokenFields = event;
  const inputTokens = isNonNegativeFiniteNumber(legacyTokens.inputTokens)
    ? legacyTokens.inputTokens
    : undefined;
  const outputTokens = isNonNegativeFiniteNumber(legacyTokens.outputTokens)
    ? legacyTokens.outputTokens
    : undefined;
  const totalTokens = isNonNegativeFiniteNumber(legacyTokens.totalTokens)
    ? legacyTokens.totalTokens
    : undefined;

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
  };
};

// 高水位游标:以「事件数组的引用」为 key 记录已处理到的下标。依赖调用方始终传入
// 同一个被原地 mutate 的 buffer.events 引用(见 createSidecarLiveEventBuffer);若传入
// 每次新建的数组,游标会失效并把全部事件当作新事件重复下发。
const processedRuntimeEventCountsByEvents = new WeakMap<readonly TAgentUiEvent[], number>();

const scheduleUiFlush = (flush: () => void): TUiFlushHandle => {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return {
      kind: 'raf',
      id: globalThis.requestAnimationFrame(() => {
        flush();
      }),
    };
  }

  return {
    kind: 'timeout',
    id: setTimeout(flush, 0),
  };
};

const cancelUiFlush = (handle: TUiFlushHandle | null): void => {
  if (!handle) {
    return;
  }

  if (handle.kind === 'raf') {
    globalThis.cancelAnimationFrame?.(handle.id);
    return;
  }

  clearTimeout(handle.id);
};

// message_delta 下发的是「增量片段」而非累计完整文本，因此同一 phase 的多条 delta 必须按
// 到达顺序拼接，才能得到完整文本。若只取最新一条会丢失先前内容，表现为文字一段段闪现替换、
// 最后由 done 事件一次性补全（即最初的流式 bug）。
const mergeMessageDeltaText = (
  existing: Extract<TAgentUiEvent, { type: 'message_delta' }>,
  incoming: Extract<TAgentUiEvent, { type: 'message_delta' }>,
): Extract<TAgentUiEvent, { type: 'message_delta' }> => ({
  ...incoming,
  text: `${existing.text}${incoming.text}`,
});

export const createSidecarLiveEventBuffer = (
  onFlush: (events: readonly TAgentUiEvent[], freshEvents: readonly TAgentUiEvent[]) => void,
): ISidecarLiveEventBuffer => {
  const events: TAgentUiEvent[] = [];
  const messageDeltaIndexes = new Map<string, number>();
  let pendingEvents: TAgentUiEvent[] = [];
  let scheduledFlush: TUiFlushHandle | null = null;
  let isFlushScheduled = false;
  let isDisposed = false;

  const retainEvent = (event: TAgentUiEvent): void => {
    if (event.type !== 'message_delta') {
      events.push(event);
      return;
    }

    const phase = event.phase ?? SIDECAR_MESSAGE_DELTA_PHASE_FALLBACK;
    const existingIndex = messageDeltaIndexes.get(phase);
    const existingEvent = existingIndex !== undefined ? events[existingIndex] : undefined;

    if (existingIndex !== undefined && existingEvent?.type === 'message_delta') {
      // 按到达顺序拼接增量片段：保证保留的 events 中该 phase 的 message_delta 始终是完整累计文本。
      events[existingIndex] = mergeMessageDeltaText(existingEvent, event);
      return;
    }

    messageDeltaIndexes.set(phase, events.length);
    events.push(event);
  };

  const retainPendingMessageDelta = (
    event: Extract<TAgentUiEvent, { type: 'message_delta' }>,
  ): void => {
    const phase = event.phase ?? SIDECAR_MESSAGE_DELTA_PHASE_FALLBACK;
    const existingIndex = pendingEvents.findIndex(
      (pendingEvent) =>
        pendingEvent.type === 'message_delta' &&
        (pendingEvent.phase ?? SIDECAR_MESSAGE_DELTA_PHASE_FALLBACK) === phase,
    );

    if (existingIndex >= 0) {
      const existingEvent = pendingEvents[existingIndex];

      // 同一帧内多条 message_delta 同样按到达顺序拼接，得到该帧的完整增量。
      pendingEvents[existingIndex] =
        existingEvent?.type === 'message_delta'
          ? mergeMessageDeltaText(existingEvent, event)
          : event;
      return;
    }

    pendingEvents.push(event);
  };

  const flush = (): void => {
    scheduledFlush = null;
    isFlushScheduled = false;

    if (isDisposed || pendingEvents.length === 0) {
      return;
    }

    const freshEvents = pendingEvents;
    pendingEvents = [];
    freshEvents.forEach(retainEvent);
    onFlush(events, freshEvents);
  };

  return {
    get events() {
      return events;
    },
    push: (event) => {
      if (isDisposed) {
        return;
      }

      if (event.type === 'message_delta') {
        retainPendingMessageDelta(event);

        if (isFlushScheduled) {
          return;
        }

        isFlushScheduled = true;
        scheduledFlush = scheduleUiFlush(flush);
        return;
      }

      pendingEvents.push(event);

      if (isFlushScheduled) {
        return;
      }

      isFlushScheduled = true;
      scheduledFlush = scheduleUiFlush(flush);
    },
    flush,
    dispose: () => {
      isDisposed = true;
      cancelUiFlush(scheduledFlush);
      scheduledFlush = null;
      isFlushScheduled = false;
      pendingEvents = [];
      events.length = 0;
      messageDeltaIndexes.clear();
    },
  };
};

export const extractNewVisibleRuntimeEvents = (
  events: readonly TAgentUiEvent[],
): TAgentRuntimeEvent[] | undefined => {
  if (events.length === 0) {
    return undefined;
  }

  const previousCount = processedRuntimeEventCountsByEvents.get(events) ?? 0;
  const startIndex = Math.min(previousCount, events.length);

  processedRuntimeEventCountsByEvents.set(events, events.length);

  if (startIndex >= events.length) {
    return undefined;
  }

  const visibleEvents = extractVisibleAgentRuntimeEvents(events.slice(startIndex));

  return visibleEvents.length ? visibleEvents : undefined;
};
