import type { TAgentRuntimeOutputEvent } from '../engines/runtime-contracts.js';
import type { TJsonValue } from '../schemas/events.js';
import type { AgentStreamEventBus } from './stream-event-bus.js';
import { extractRuntimeModelTextDelta, normalizeAgentRuntimeStreamEvent } from './stream-normalizer.js';
import type { TAgentRuntimeEvent } from './stream-types.js';

interface IAgentStreamAdapterParams {
    eventBus: AgentStreamEventBus;
    emitOutputEvent: (event: TAgentRuntimeOutputEvent) => void;
    toJsonValue: (value: unknown) => TJsonValue;
}

interface IAgentStreamCapture {
    visibleText: string;
    emittedVisibleText: string;
    activeModelBlock: 'reasoning' | 'text' | 'tool' | null;
    hasReasoningStarted: boolean;
    hasReasoningEnded: boolean;
    hasToolStarted: boolean;
}

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
    getEventType(event) === 'modelStreamUpdateEvent'
        ? toRecord(toRecord(event)?.event)
        : null;

const getModelEventType = (event: unknown): string | undefined =>
    getStringValue(getModelEvent(event), 'type');

const getModelDeltaType = (event: unknown): string | undefined =>
    getStringValue(toRecord(getModelEvent(event)?.delta), 'type');

const getToolUse = (event: unknown): Record<string, unknown> | null =>
    toRecord(toRecord(event)?.toolUse);

const getToolUseName = (event: unknown): string =>
    getStringValue(getToolUse(event), 'name') ?? 'unknown_tool';

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

const shouldStreamFinalAnswerText = (capture: IAgentStreamCapture): boolean =>
    !capture.hasReasoningStarted || capture.hasReasoningEnded;

const emitVisibleTextDelta = (
    text: string,
    params: Pick<IAgentStreamAdapterParams, 'emitOutputEvent'>,
    capture: IAgentStreamCapture,
    phase: 'stage' | 'final',
): void => {
    if (capture.emittedVisibleText === text) {
        return;
    }

    capture.emittedVisibleText = text;
    params.emitOutputEvent({
        type: 'message_delta',
        text,
        phase,
    });
};

const createStreamCapture = (): IAgentStreamCapture => ({
    visibleText: '',
    emittedVisibleText: '',
    activeModelBlock: null,
    hasReasoningStarted: false,
    hasReasoningEnded: false,
    hasToolStarted: false,
});

const appendLegacySidecarEvent = (
    event: unknown,
    params: Pick<IAgentStreamAdapterParams, 'emitOutputEvent' | 'toJsonValue'>,
    capture: IAgentStreamCapture,
): void => {
    if (getModelEventType(event) === 'modelContentBlockStopEvent') {
        if (capture.activeModelBlock === 'reasoning') {
            capture.hasReasoningEnded = true;
        }

        capture.activeModelBlock = null;
        return;
    }

    if (getModelDeltaType(event) === 'reasoningContentDelta' || getModelDeltaType(event) === 'reasoningText') {
        capture.activeModelBlock = 'reasoning';
        capture.hasReasoningStarted = true;
        capture.hasReasoningEnded = false;
        return;
    }

    const textDelta = extractRuntimeModelTextDelta(event);

    if (textDelta) {
        capture.activeModelBlock = 'text';
        capture.visibleText += textDelta;
        if ((capture.hasToolStarted || capture.hasReasoningStarted) && shouldStreamFinalAnswerText(capture)) {
            emitVisibleTextDelta(capture.visibleText, params, capture, 'final');
        }
        return;
    }

    const eventType = getEventType(event);

    if (eventType === 'beforeToolCallEvent') {
        capture.activeModelBlock = 'tool';
        capture.hasToolStarted = true;

        if (capture.visibleText.length > 0) {
            capture.visibleText = '';
        }

        if (capture.emittedVisibleText.length > 0) {
            emitVisibleTextDelta('', params, capture, 'stage');
        }

        params.emitOutputEvent({
            type: 'tool_start',
            toolName: getToolUseName(event),
            input: params.toJsonValue(getToolUseInput(event)),
        });
        return;
    }

    if (eventType === 'afterToolCallEvent') {
        capture.activeModelBlock = null;
        params.emitOutputEvent({
            type: 'tool_result',
            toolName: getToolUseName(event),
            output: params.toJsonValue(getToolResultOutput(event)),
        });
    }
};

export interface IAgentStreamAdapter {
    consume(event: unknown): TAgentRuntimeEvent[];
    complete(): string;
    getVisibleText(): string;
}

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
            if (capture.visibleText.length > 0 && capture.emittedVisibleText !== capture.visibleText) {
                emitVisibleTextDelta(capture.visibleText, params, capture, 'final');
            }

            return capture.visibleText;
        },
        getVisibleText() {
            return capture.visibleText;
        },
    };
};