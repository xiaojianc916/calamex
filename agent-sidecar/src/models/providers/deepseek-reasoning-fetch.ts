/**
 * DeepSeek V4 thinking-mode replay shim.
 *
 * Why this exists
 * ---------------
 * DeepSeek V4 (deepseek-v4-flash / deepseek-v4-pro, hybrid thinking) enforces
 * the following replay contract:
 *
 *   1. When thinking is enabled AND an assistant message contains `tool_calls`,
 *      every subsequent request that includes that assistant message MUST also
 *      include its original `reasoning_content`. Missing it triggers HTTP 400
 *      "The `reasoning_content` in the thinking mode must be passed back to the
 *      API." V4 extends this requirement across user-message boundaries
 *      (interleaved thinking).
 *
 *   2. When thinking is explicitly disabled (`thinking.type === "disabled"`),
 *      historical `reasoning_content` on replayed assistant messages must be
 *      stripped — otherwise DeepSeek rejects the mixed-mode history.
 *
 * This fetch wrapper:
 *   - Captures `reasoning_content` from streaming + non-streaming responses,
 *     keyed by (sessionId, runId, sorted tool_call ids).
 *   - On the next outbound request, injects the captured reasoning back onto
 *     assistant messages whose `tool_calls` match. If thinking is disabled, it
 *     strips reasoning instead.
 *   - Emits per-request payload telemetry via `onRequestPayload`.
 *
 * It is a no-op for requests outside `runWithDeepSeekReasoningContext` and for
 * non-DeepSeek bodies (no `messages` array).
 */

import { createParser, type EventSourceMessage, type EventSourceParser } from 'eventsource-parser';
import { AsyncLocalStorage } from 'node:async_hooks';
import { toNonEmptyString, toRecord } from '../../engines/utils.js';
import { countJsonChars, countTextChars, estimateInputTokensByChars, stringifyForJson as stringifyForStats } from '../../text-metrics.js';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type TJsonRecord = Record<string, unknown>;

export interface IDeepSeekRequestPayloadStats {
  provider: 'deepseek';
  model?: string;
  stream?: boolean;
  thinkingMode?: 'enabled' | 'disabled' | 'default';
  requestBodyCharCount: number;
  projectedInputTokens: number;
  messageCharCount: number;
  systemMessageCharCount: number;
  userMessageCharCount: number;
  assistantMessageCharCount: number;
  toolMessageCharCount: number;
  reasoningReplayCharCount: number;
  toolSchemaCharCount: number;
  toolCount: number;
  responseFormatCharCount: number;
  reasoningInjected: boolean;
  reasoningStripped: boolean;
}

export interface IDeepSeekReasoningContext {
  sessionId: string;
  runId: string;
  onRequestPayload?: (stats: IDeepSeekRequestPayloadStats) => void;
}

interface IReasoningStoreEntry {
  createdAt: number;
  reasoning: string;
  toolCallIds: string[];
}

// -----------------------------------------------------------------------------
// Module state
// -----------------------------------------------------------------------------

const textEncoder = new TextEncoder();
const reasoningStore = new Map<string, IReasoningStoreEntry>();
export const deepseekReasoningContext = new AsyncLocalStorage<IDeepSeekReasoningContext>();

/** TTL for stored reasoning entries. Past this, entries are considered stale. */
const REASONING_TTL_MS = 30 * 60 * 1000; // 30 minutes
/** Hard cap on store size; oldest entries are evicted FIFO when exceeded. */
const REASONING_STORE_MAX_ENTRIES = 1_000;

/** Debug flag read once at module load. */
const REASONING_DEBUG_ENABLED =
  process.env.AGENT_SIDECAR_DEEPSEEK_REASONING_DEBUG === '1';

// -----------------------------------------------------------------------------
// Generic helpers

const isRecord = (value: unknown): value is TJsonRecord =>
  toRecord(value) !== null;

const logReasoningDebug = (
  event: string,
  fields: Record<string, string | number | boolean | null>,
): void => {
  if (!REASONING_DEBUG_ENABLED) return;
  console.info('[deepseek-reasoning]', { event, ...fields });
};

const logReasoningWarning = (
  event: string,
  fields: Record<string, string | number | boolean | null>,
  error?: unknown,
): void => {
  console.warn('[deepseek-reasoning]', {
    event,
    ...fields,
    ...(error instanceof Error ? { error: error.message } : {}),
  });
};

// -----------------------------------------------------------------------------
// Key construction
// -----------------------------------------------------------------------------

const normalizeToolCallIds = (toolCallIds: readonly string[]): string[] =>
  [...new Set(
    toolCallIds
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  )].sort();

export const createDeepSeekReasoningKey = (
  context: IDeepSeekReasoningContext | undefined,
  toolCallIds: readonly string[],
): string => {
  const sessionId = context?.sessionId ?? 'anon';
  const runId = context?.runId ?? 'anon';
  return `${sessionId}::${runId}::${normalizeToolCallIds(toolCallIds).join('|')}`;
};

/** Prefix shared by all entries belonging to a (sessionId, runId) pair. */
export const createDeepSeekReasoningRunPrefix = (
  sessionId: string,
  runId: string,
): string => `${sessionId}::${runId}::`;

const createDeepSeekReasoningContextPrefix = (
  context: IDeepSeekReasoningContext | undefined,
): string =>
  createDeepSeekReasoningRunPrefix(
    context?.sessionId ?? 'anon',
    context?.runId ?? 'anon',
  );

// -----------------------------------------------------------------------------
// Store lifecycle
// -----------------------------------------------------------------------------

const evictStaleEntries = (now: number): void => {
  for (const [key, entry] of reasoningStore) {
    if (now - entry.createdAt > REASONING_TTL_MS) {
      reasoningStore.delete(key);
    }
  }
};

const enforceStoreCapacity = (): void => {
  if (reasoningStore.size <= REASONING_STORE_MAX_ENTRIES) return;
  const excess = reasoningStore.size - REASONING_STORE_MAX_ENTRIES;
  let removed = 0;
  // Map preserves insertion order, so this is FIFO.
  for (const key of reasoningStore.keys()) {
    if (removed >= excess) break;
    reasoningStore.delete(key);
    removed += 1;
  }
};

export const evictDeepSeekReasoningByPrefix = (prefix: string): void => {
  for (const key of reasoningStore.keys()) {
    if (key.startsWith(prefix)) {
      reasoningStore.delete(key);
    }
  }
};

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export const runWithDeepSeekReasoningContext = async <T>(
  context: IDeepSeekReasoningContext,
  task: () => Promise<T>,
): Promise<T> => deepseekReasoningContext.run(context, task);

export const clearDeepSeekReasoningStoreForTest = (): void => {
  reasoningStore.clear();
};

export const setDeepSeekReasoningForTest = (
  context: IDeepSeekReasoningContext,
  toolCallIds: readonly string[],
  reasoning: string,
): void => {
  const normalized = normalizeToolCallIds(toolCallIds);
  reasoningStore.set(createDeepSeekReasoningKey(context, normalized), {
    createdAt: Date.now(),
    reasoning,
    toolCallIds: normalized,
  });
};

// -----------------------------------------------------------------------------
// Reasoning capture / lookup
// -----------------------------------------------------------------------------

const getToolCallIds = (toolCalls: unknown): string[] => {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.flatMap((toolCall) => {
    const id = toNonEmptyString(isRecord(toolCall) ? toolCall.id : null);
    return id ? [id] : [];
  });
};

const getReasoningText = (value: TJsonRecord | null): string => {
  if (
    typeof value?.reasoning_content === 'string'
    && value.reasoning_content.length > 0
  ) {
    return value.reasoning_content;
  }
  return '';
};

const hasReasoningContent = (message: TJsonRecord): boolean =>
  typeof message.reasoning_content === 'string'
  && message.reasoning_content.length > 0;

const storeReasoning = (
  context: IDeepSeekReasoningContext | undefined,
  toolCallIds: readonly string[],
  reasoning: string,
): void => {
  const normalized = normalizeToolCallIds(toolCallIds);
  if (normalized.length === 0) return;
  // NOTE: we store even when reasoning === '' so that replay can satisfy the
  // V4 contract of "reasoning_content must be passed back" (with an empty
  // string) instead of failing with 400.
  const now = Date.now();
  reasoningStore.set(createDeepSeekReasoningKey(context, normalized), {
    createdAt: now,
    reasoning,
    toolCallIds: normalized,
  });
  evictStaleEntries(now);
  enforceStoreCapacity();
  logReasoningDebug('capture', {
    sessionId: context?.sessionId ?? null,
    runId: context?.runId ?? null,
    toolCallCount: normalized.length,
    reasoningCharCount: countTextChars(reasoning),
  });
};

const findStoredReasoning = (
  context: IDeepSeekReasoningContext | undefined,
  toolCallIds: readonly string[],
): IReasoningStoreEntry | null => {
  const normalized = normalizeToolCallIds(toolCallIds);
  const now = Date.now();

  const isFresh = (entry: IReasoningStoreEntry): boolean =>
    now - entry.createdAt <= REASONING_TTL_MS;

  const exact = reasoningStore.get(createDeepSeekReasoningKey(context, normalized));
  if (exact && isFresh(exact)) return exact;

  // Fallback: any entry under the same (sessionId, runId) whose tool_call ids
  // overlap with the requested set, *only* if all such entries agree.
  const requestedIds = new Set(normalized);
  const prefix = createDeepSeekReasoningContextPrefix(context);
  const candidates: IReasoningStoreEntry[] = [];
  for (const [key, entry] of reasoningStore) {
    if (!key.startsWith(prefix) || !isFresh(entry)) continue;
    if (entry.toolCallIds.some((id) => requestedIds.has(id))) {
      candidates.push(entry);
    }
  }
  const uniqueReasonings = new Set(candidates.map((entry) => entry.reasoning));
  if (uniqueReasonings.size !== 1) return null;
  return candidates[0] ?? null;
};

// -----------------------------------------------------------------------------
// Request mutation (thinking-aware)
// -----------------------------------------------------------------------------

type TThinkingMode = 'enabled' | 'disabled' | 'default';

const readThinkingMode = (body: TJsonRecord): TThinkingMode => {
  const thinking = isRecord(body.thinking) ? body.thinking : null;
  const type = typeof thinking?.type === 'string' ? thinking.type : null;
  if (type === 'enabled') return 'enabled';
  if (type === 'disabled') return 'disabled';
  return 'default'; // V4 default is thinking-enabled; we don't assume here.
};

const normalizeMessageContentFields = (body: TJsonRecord): boolean => {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  let changed = false;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (
      !('content' in message)
      || message.content === undefined
      || message.content === null
    ) {
      message.content = '';
      changed = true;
    }
  }
  return changed;
};

/**
 * Inject captured reasoning_content onto historical assistant messages that
 * have tool_calls. Returns true if any message was modified.
 *
 * When the store has no match, we fall back to injecting an empty
 * `reasoning_content: ""`. This satisfies the V4 "must be passed back"
 * contract; without this fallback, replay of a turn whose reasoning was lost
 * (e.g. process restart) would return 400.
 */
const injectReasoningIntoMessages = (
  body: TJsonRecord,
  context: IDeepSeekReasoningContext | undefined,
): boolean => {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  let changed = false;
  for (const message of messages) {
    if (!isRecord(message) || message.role !== 'assistant') continue;
    const toolCallIds = getToolCallIds(message.tool_calls);
    if (toolCallIds.length === 0) continue;
    if (hasReasoningContent(message)) continue;

    const stored = findStoredReasoning(context, toolCallIds);
    if (stored) {
      message.reasoning_content = stored.reasoning;
      changed = true;
      logReasoningDebug('inject', {
        sessionId: context?.sessionId ?? null,
        runId: context?.runId ?? null,
        toolCallCount: toolCallIds.length,
        ageMs: Date.now() - stored.createdAt,
        reasoningCharCount: countTextChars(stored.reasoning),
      });
    } else {
      // V4 contract fallback: better an empty string than a 400.
      message.reasoning_content = '';
      changed = true;
      logReasoningWarning('miss-fallback-empty', {
        sessionId: context?.sessionId ?? null,
        runId: context?.runId ?? null,
        toolCallCount: toolCallIds.length,
      });
    }
  }
  return changed;
};

/**
 * When thinking is explicitly disabled, strip any historical reasoning_content
 * from outgoing messages. Returns true if anything was stripped.
 */
const stripReasoningFromMessages = (body: TJsonRecord): boolean => {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  let changed = false;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if ('reasoning_content' in message) {
      delete message.reasoning_content;
      changed = true;
    }
  }
  return changed;
};

// -----------------------------------------------------------------------------
// Telemetry
// -----------------------------------------------------------------------------

const readMessageContentCharCount = (message: TJsonRecord): number =>
  countJsonChars(message.content);

const readToolCount = (tools: unknown): number =>
  Array.isArray(tools) ? tools.length : 0;

const createRequestPayloadStats = (
  body: TJsonRecord,
  thinkingMode: TThinkingMode,
  reasoningInjected: boolean,
  reasoningStripped: boolean,
): IDeepSeekRequestPayloadStats => {
  const bodyText = stringifyForStats(body);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let systemMessageCharCount = 0;
  let userMessageCharCount = 0;
  let assistantMessageCharCount = 0;
  let toolMessageCharCount = 0;
  let reasoningReplayCharCount = 0;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const contentCharCount = readMessageContentCharCount(message);
    if (message.role === 'system') {
      systemMessageCharCount += contentCharCount;
    } else if (message.role === 'user') {
      userMessageCharCount += contentCharCount;
    } else if (message.role === 'assistant') {
      assistantMessageCharCount += contentCharCount;
      reasoningReplayCharCount += countTextChars(getReasoningText(message));
    } else if (message.role === 'tool') {
      toolMessageCharCount += contentCharCount;
    }
  }
  return {
    provider: 'deepseek',
    ...(typeof body.model === 'string' && body.model.trim().length > 0
      ? { model: body.model.trim() }
      : {}),
    ...(typeof body.stream === 'boolean' ? { stream: body.stream } : {}),
    thinkingMode,
    requestBodyCharCount: countTextChars(bodyText),
    projectedInputTokens: estimateInputTokensByChars(bodyText),
    messageCharCount: countJsonChars(body.messages),
    systemMessageCharCount,
    userMessageCharCount,
    assistantMessageCharCount,
    toolMessageCharCount,
    reasoningReplayCharCount,
    toolSchemaCharCount: countJsonChars(body.tools),
    toolCount: readToolCount(body.tools),
    responseFormatCharCount: countJsonChars(body.response_format),
    reasoningInjected,
    reasoningStripped,
  };
};

const emitRequestPayloadStats = (
  context: IDeepSeekReasoningContext | undefined,
  body: TJsonRecord,
  thinkingMode: TThinkingMode,
  reasoningInjected: boolean,
  reasoningStripped: boolean,
): void => {
  try {
    context?.onRequestPayload?.(
      createRequestPayloadStats(
        body,
        thinkingMode,
        reasoningInjected,
        reasoningStripped,
      ),
    );
  } catch (error) {
    logReasoningWarning(
      'request-payload-metric-failed',
      {
        sessionId: context?.sessionId ?? null,
        runId: context?.runId ?? null,
        toolCallCount: 0,
      },
      error,
    );
  }
};

// -----------------------------------------------------------------------------
// Streaming capture
// -----------------------------------------------------------------------------

const captureReasoningFromJson = (
  body: unknown,
  context: IDeepSeekReasoningContext | undefined,
): void => {
  const record = isRecord(body) ? body : null;
  const choices = Array.isArray(record?.choices) ? record.choices : [];
  const firstChoice = isRecord(choices[0]) ? choices[0] : null;
  const message = isRecord(firstChoice?.message) ? firstChoice.message : null;
  const reasoning = getReasoningText(message);
  const toolCallIds = getToolCallIds(message?.tool_calls);
  storeReasoning(context, toolCallIds, reasoning);
};

const extractStreamingDelta = (chunk: unknown): TJsonRecord | null => {
  const record = isRecord(chunk) ? chunk : null;
  const choices = Array.isArray(record?.choices) ? record.choices : [];
  const firstChoice = isRecord(choices[0]) ? choices[0] : null;
  return isRecord(firstChoice?.delta) ? firstChoice.delta : null;
};

interface IStreamingCaptureState {
  reasoning: string;
  toolCallIds: Set<string>;
  parser: EventSourceParser;
  finalized: boolean;
}

const captureStreamingEvent = (
  event: EventSourceMessage,
  state: Pick<IStreamingCaptureState, 'reasoning' | 'toolCallIds'>,
): void => {
  const data = event.data.trim();
  if (!data || data === '[DONE]') return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    // A single malformed SSE line shouldn't drop the rest of the stream.
    return;
  }

  const delta = extractStreamingDelta(parsed);
  if (!delta) return;
  if (typeof delta.reasoning_content === 'string') {
    state.reasoning += delta.reasoning_content;
  }
  for (const id of getToolCallIds(delta.tool_calls)) {
    state.toolCallIds.add(id);
  }
};

const createStreamingCaptureState = (): IStreamingCaptureState => {
  let state: IStreamingCaptureState | undefined;
  const parser = createParser({
    onEvent: (event) => {
      if (state) {
        captureStreamingEvent(event, state);
      }
    },
  });
  state = {
    reasoning: '',
    toolCallIds: new Set<string>(),
    parser,
    finalized: false,
  };
  return state;
};

const finalizeStreamingCapture = (
  context: IDeepSeekReasoningContext | undefined,
  decoder: TextDecoder,
  state: IStreamingCaptureState,
): void => {
  if (state.finalized) return;
  state.finalized = true;
  const flushed = decoder.decode();
  if (flushed) {
    state.parser.feed(flushed);
  }
  state.parser.reset();
  storeReasoning(context, [...state.toolCallIds], state.reasoning);
};

// -----------------------------------------------------------------------------
// Outbound request preparation
// -----------------------------------------------------------------------------

const shouldHandleRequest = (body: unknown): body is TJsonRecord =>
  isRecord(body) && Array.isArray(body.messages);

const readRequestJsonBody = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<TJsonRecord | null> => {
  const rawBody = init?.body;
  if (typeof rawBody === 'string') {
    const parsed = JSON.parse(rawBody) as unknown;
    return shouldHandleRequest(parsed) ? parsed : null;
  }
  if (rawBody instanceof Uint8Array) {
    const parsed = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
    return shouldHandleRequest(parsed) ? parsed : null;
  }
  if (rawBody instanceof ArrayBuffer) {
    const parsed = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
    return shouldHandleRequest(parsed) ? parsed : null;
  }
  if (input instanceof Request && rawBody === undefined) {
    const parsed = JSON.parse(await input.clone().text()) as unknown;
    return shouldHandleRequest(parsed) ? parsed : null;
  }
  return null;
};

const createRequestWithJsonBody = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  body: TJsonRecord,
): [RequestInfo | URL, RequestInit | undefined] => {
  const nextBody = JSON.stringify(body);
  if (input instanceof Request && init?.body === undefined) {
    return [new Request(input, { body: nextBody }), undefined];
  }
  return [input, { ...init, body: nextBody }];
};

const prepareOutboundRequest = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<[RequestInfo | URL, RequestInit | undefined]> => {
  const context = deepseekReasoningContext.getStore();
  try {
    const body = await readRequestJsonBody(input, init);
    if (!body) return [input, init];

    const thinkingMode = readThinkingMode(body);
    const contentNormalized = normalizeMessageContentFields(body);

    let reasoningInjected = false;
    let reasoningStripped = false;
    if (thinkingMode === 'disabled') {
      reasoningStripped = stripReasoningFromMessages(body);
    } else {
      reasoningInjected = injectReasoningIntoMessages(body, context);
    }

    const changed = contentNormalized || reasoningInjected || reasoningStripped;
    emitRequestPayloadStats(
      context,
      body,
      thinkingMode,
      reasoningInjected,
      reasoningStripped,
    );
    return changed
      ? createRequestWithJsonBody(input, init, body)
      : [input, init];
  } catch (error) {
    logReasoningWarning(
      'outbound-failed',
      {
        sessionId: context?.sessionId ?? null,
        runId: context?.runId ?? null,
        toolCallCount: 0,
      },
      error,
    );
    return [input, init];
  }
};

// -----------------------------------------------------------------------------
// Response handling
// -----------------------------------------------------------------------------

const responseInitFrom = (response: Response): ResponseInit => ({
  status: response.status,
  statusText: response.statusText,
  headers: new Headers(response.headers),
});

const captureNonStreamingResponse = async (
  response: Response,
  context: IDeepSeekReasoningContext | undefined,
): Promise<Response> => {
  const text = await response.text();
  try {
    if (text.trim().length > 0) {
      captureReasoningFromJson(JSON.parse(text) as unknown, context);
    }
  } catch (error) {
    logReasoningWarning(
      'non-stream-capture-failed',
      {
        sessionId: context?.sessionId ?? null,
        runId: context?.runId ?? null,
        toolCallCount: 0,
      },
      error,
    );
  }
  return new Response(text, responseInitFrom(response));
};

const captureStreamingResponse = (
  response: Response,
  context: IDeepSeekReasoningContext | undefined,
): Response => {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state = createStreamingCaptureState();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await reader.read();
      if (result.done) {
        try {
          finalizeStreamingCapture(context, decoder, state);
        } catch (error) {
          logReasoningWarning(
            'stream-capture-failed',
            {
              sessionId: context?.sessionId ?? null,
              runId: context?.runId ?? null,
              toolCallCount: state.toolCallIds.size,
            },
            error,
          );
        }
        controller.close();
        return;
      }
      try {
        const text = decoder.decode(result.value, { stream: true });
        state.parser.feed(text);
      } catch (error) {
        logReasoningWarning(
          'stream-chunk-capture-failed',
          {
            sessionId: context?.sessionId ?? null,
            runId: context?.runId ?? null,
            toolCallCount: state.toolCallIds.size,
          },
          error,
        );
      }
      controller.enqueue(result.value);
    },
    async cancel(reason) {
      try {
        finalizeStreamingCapture(context, decoder, state);
      } catch (error) {
        logReasoningWarning(
          'stream-cancel-capture-failed',
          {
            sessionId: context?.sessionId ?? null,
            runId: context?.runId ?? null,
            toolCallCount: state.toolCallIds.size,
          },
          error,
        );
      }
      await reader.cancel(reason);
    },
  });
  return new Response(body, responseInitFrom(response));
};

const isStreamingResponse = (response: Response): boolean => {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  return contentType.includes('text/event-stream');
};

// -----------------------------------------------------------------------------
// Public fetch + test helper
// -----------------------------------------------------------------------------

export const deepseekReasoningFetch: typeof fetch = async (input, init) => {
  const [nextInput, nextInit] = await prepareOutboundRequest(input, init);
  const response = await fetch(nextInput, nextInit);
  const context = deepseekReasoningContext.getStore();
  if (isStreamingResponse(response)) {
    return captureStreamingResponse(response, context);
  }
  return captureNonStreamingResponse(response, context);
};

export const encodeSseLineForTest = (line: string): Uint8Array =>
  textEncoder.encode(line);
