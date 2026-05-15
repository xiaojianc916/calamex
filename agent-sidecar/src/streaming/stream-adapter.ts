import type { TAgentRuntimeOutputEvent } from '../engines/runtime-contracts.js';
import type { TJsonValue } from '../schemas/events.js';
import type { AgentStreamEventBus } from './stream-event-bus.js';
import { extractRuntimeModelTextDelta, normalizeAgentRuntimeStreamEvent } from './stream-normalizer.js';
import type { TAgentRuntimeEvent } from './stream-types.js';

// -----------------------------------------------------------------------
// Mastra 事件类型常量（@mastra/core 流事件 wire 名）
//
// LAST VERIFIED AGAINST: @mastra/core ~ check package.json
// 任何 Mastra minor 升级都应当 grep 这些字符串，确认 wire 名没变。
// -----------------------------------------------------------------------

const MASTRA_EVENT = {
    modelStreamUpdate: 'modelStreamUpdateEvent',
    modelContentBlockStop: 'modelContentBlockStopEvent',
    beforeToolCall: 'beforeToolCallEvent',
    afterToolCall: 'afterToolCallEvent',
} as const;

const MASTRA_DELTA_TYPE = {
    reasoningContentDelta: 'reasoningContentDelta',
    reasoningText: 'reasoningText',
} as const;

const UNKNOWN_TOOL_NAME = 'unknown_tool';

// -----------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------

interface IAgentStreamAdapterParams {
    eventBus: AgentStreamEventBus;
    emitOutputEvent: (event: TAgentRuntimeOutputEvent) => void;
    toJsonValue: (value: unknown) => TJsonValue;
    /**
     * 可选 warning 钩子。默认走 `console.warn`。
     * 用于工具名解析失败、未知 Mastra 事件等非致命异常。
     */
    onWarning?: (message: string, payload: unknown) => void;
}

interface IAgentStreamCapture {
    /** 累加的完整可见文本（模型实际产生的）。 */
    visibleText: string;
    /** 已经通过 message_delta 发出去的累加长度（前缀长度）。 */
    emittedTextLength: number;
    activeModelBlock: 'reasoning' | 'text' | 'tool' | null;
    hasReasoningStarted: boolean;
    hasReasoningEnded: boolean;
    hasToolStarted: boolean;
    aborted: boolean;
}

export interface IAgentStreamAdapter {
    /**
     * 消费一个 Mastra 流事件。
     *
     * 返回值：本事件归一化后产生的 `TAgentRuntimeEvent` 列表。
     *
     * **重要**：返回的事件**已经**通过 `params.eventBus.emitDraft` 发布。
     * 返回值仅供 caller 做同步反馈（比如计数、debug log），
     * 不要再次 emit，否则下游会收到重复事件。
     */
    consume(event: unknown): TAgentRuntimeEvent[];
    /**
     * 流正常结束时调用。flush 尚未发出的 `visibleText` 增量。
     * 返回最终可见文本。
     *
     * 若之前调用过 `abort()`，本方法返回累积文本但**不再 emit** 任何事件。
     */
    complete(): string;
    /**
     * 协作式中止。后续 `complete()` 不会 emit。
     * 已经 emit 的事件无法撤销。
     */
    abort(): void;
    getVisibleText(): string;
}

// -----------------------------------------------------------------------
// 底层 unknown 解析助手
// -----------------------------------------------------------------------

const toRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;

const getStringValue = (
    value: unknown,
    key: string,
): string | undefined => {
    const candidate = toRecord(value)?.[key];
    return typeof candidate === 'string' ? candidate : undefined;
};

const getEventType = (event: unknown): string =>
    getStringValue(event, 'type') ?? 'unknown';

const getModelEvent = (event: unknown): Record<string, unknown> | null =>
    getEventType(event) === MASTRA_EVENT.modelStreamUpdate
        ? toRecord(toRecord(event)?.event)
        : null;

const getModelEventType = (event: unknown): string | undefined =>
    getStringValue(getModelEvent(event), 'type');

const getModelDeltaType = (event: unknown): string | undefined =>
    getStringValue(toRecord(getModelEvent(event)?.delta), 'type');

const getToolUse = (event: unknown): Record<string, unknown> | null =>
    toRecord(toRecord(event)?.toolUse);

const getToolUseInput = (event: unknown): unknown =>
    getToolUse(event)?.input;

interface IJsonSerializable {
    toJSON: () => unknown;
}

const hasToJson = (value: unknown): value is IJsonSerializable => {
    const record = toRecord(value);
    return typeof record?.toJSON === 'function';
};

const getToolResultOutput = (event: unknown): unknown => {
    const result = toRecord(event)?.result;
    return hasToJson(result) ? result.toJSON() : result;
};

// -----------------------------------------------------------------------
// State 转换
// -----------------------------------------------------------------------

const shouldStreamFinalAnswerText = (capture: IAgentStreamCapture): boolean =>
    !capture.hasReasoningStarted || capture.hasReasoningEnded;

/**
 * Emit 新增的文本增量（相对于已发送的前缀长度）。
 *
 * 如果 `capture.visibleText` 不是 `capture` 已发送前缀的**严格扩展**
 * （即被覆写 / 回退），会先 emit `message_clear` 再发完整文本，
 * 但正常路径下这不应该发生 —— reset 应该走 `emitMessageClear`。
 */
const emitTextDelta = (
    params: Pick<IAgentStreamAdapterParams, 'emitOutputEvent'>,
    capture: IAgentStreamCapture,
    phase: 'stage' | 'final',
): void => {
    if (capture.aborted) {
        return;
    }
    const full = capture.visibleText;
    const emittedLen = capture.emittedTextLength;
    if (emittedLen === full.length) {
        return;
    }
    const isExtension = full.length >= emittedLen
        && full.slice(0, emittedLen) === capture.visibleText.slice(0, emittedLen);
    if (!isExtension) {
        // 防御：理论上不会触发；走兜底重发。
        params.emitOutputEvent({ type: 'message_clear' });
        capture.emittedTextLength = 0;
    }
    const delta = full.slice(capture.emittedTextLength);
    if (delta.length === 0) {
        return;
    }
    capture.emittedTextLength = full.length;
    params.emitOutputEvent({
        type: 'message_delta',
        text: delta,
        phase,
    });
};

const emitMessageClear = (
    params: Pick<IAgentStreamAdapterParams, 'emitOutputEvent'>,
    capture: IAgentStreamCapture,
): void => {
    if (capture.aborted) {
        return;
    }
    if (capture.emittedTextLength === 0) {
        return;
    }
    capture.emittedTextLength = 0;
    params.emitOutputEvent({ type: 'message_clear' });
};

const createStreamCapture = (): IAgentStreamCapture => ({
    visibleText: '',
    emittedTextLength: 0,
    activeModelBlock: null,
    hasReasoningStarted: false,
    hasReasoningEnded: false,
    hasToolStarted: false,
    aborted: false,
});

const warnUnknownTool = (
    params: IAgentStreamAdapterParams,
    event: unknown,
): void => {
    const message = '[stream-adapter] failed to resolve tool name from event';
    if (params.onWarning) {
        params.onWarning(message, event);
        return;
    }
    // eslint-disable-next-line no-console
    console.warn(message, event);
};

const resolveToolName = (
    params: IAgentStreamAdapterParams,
    event: unknown,
): string => {
    const name = getStringValue(getToolUse(event), 'name');
    if (name) {
        return name;
    }
    warnUnknownTool(params, event);
    return UNKNOWN_TOOL_NAME;
};

const appendLegacySidecarEvent = (
    event: unknown,
    params: IAgentStreamAdapterParams,
    capture: IAgentStreamCapture,
): void => {
    if (capture.aborted) {
        return;
    }
    if (getModelEventType(event) === MASTRA_EVENT.modelContentBlockStop) {
        if (capture.activeModelBlock === 'reasoning') {
            capture.hasReasoningEnded = true;
        }
        capture.activeModelBlock = null;
        return;
    }

    const deltaType = getModelDeltaType(event);
    if (
        deltaType === MASTRA_DELTA_TYPE.reasoningContentDelta
        || deltaType === MASTRA_DELTA_TYPE.reasoningText
    ) {
        capture.activeModelBlock = 'reasoning';
        capture.hasReasoningStarted = true;
        capture.hasReasoningEnded = false;
        return;
    }

    const textDelta = extractRuntimeModelTextDelta(event);
    if (textDelta) {
        capture.activeModelBlock = 'text';
        capture.visibleText += textDelta;
        // CHANGED (1.2)：移除了 `hasToolStarted || hasReasoningStarted` 这部分前置条件。
        // 纯 ASK 模式（无 reasoning、无 tool）也会流式 emit 打字机效果。
        if (shouldStreamFinalAnswerText(capture)) {
            emitTextDelta(params, capture, 'final');
        }
        return;
    }

    const eventType = getEventType(event);
    if (eventType === MASTRA_EVENT.beforeToolCall) {
        capture.activeModelBlock = 'tool';
        capture.hasToolStarted = true;
        // NOTE (1.3)：当前仍然清空 visibleText —— 工具间过渡文本不进入 final result。
        // 如果要保留，删掉下一行。
        if (capture.visibleText.length > 0) {
            capture.visibleText = '';
        }
        // CHANGED (1.1)：用 message_clear 事件而不是 message_delta 携带空字符串。
        emitMessageClear(params, capture);
        params.emitOutputEvent({
            type: 'tool_start',
            toolName: resolveToolName(params, event),
            input: params.toJsonValue(getToolUseInput(event)),
        });
        return;
    }

    if (eventType === MASTRA_EVENT.afterToolCall) {
        capture.activeModelBlock = null;
        params.emitOutputEvent({
            type: 'tool_result',
            toolName: resolveToolName(params, event),
            output: params.toJsonValue(getToolResultOutput(event)),
        });
    }
};

// -----------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------

export const createAgentStreamAdapter = (
    params: IAgentStreamAdapterParams,
): IAgentStreamAdapter => {
    const capture = createStreamCapture();
    return {
        consume(event) {
            const runtimeEvents = normalizeAgentRuntimeStreamEvent(event).map((draft) =>
                params.eventBus.emitDraft(draft),
            );
            appendLegacySidecarEvent(event, params, capture);
            return runtimeEvents;
        },
        complete() {
            if (capture.aborted) {
                return capture.visibleText;
            }
            // flush 剩余未发送的增量。
            if (capture.emittedTextLength !== capture.visibleText.length) {
                emitTextDelta(params, capture, 'final');
            }
            return capture.visibleText;
        },
        abort() {
            capture.aborted = true;
        },
        getVisibleText() {
            return capture.visibleText;
        },
    };
};