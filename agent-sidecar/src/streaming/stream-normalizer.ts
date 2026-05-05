import { redactForStream } from './stream-redaction.js';
import type { TAgentRuntimeEventDraft } from './stream-types.js';

const PREVIEW_CHAR_LIMIT = 1000;

const toRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const getRecordValue = (
  value: unknown,
  key: string,
): unknown => toRecord(value)?.[key];

const getStringValue = (
  value: unknown,
  key: string,
): string | undefined => {
  const candidate = getRecordValue(value, key);
  return typeof candidate === 'string' ? candidate : undefined;
};

const clipPreview = (value: string, limit = PREVIEW_CHAR_LIMIT): string => {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  const characters = Array.from(normalized);

  if (characters.length <= limit) {
    return normalized;
  }

  return `${characters.slice(0, limit).join('')}...`;
};

const safeStringify = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  try {
    const serialized = JSON.stringify(value);
    return serialized ?? String(value);
  } catch {
    return String(value);
  }
};

const previewUnknown = (value: unknown, limit = PREVIEW_CHAR_LIMIT): string =>
  redactForStream(clipPreview(safeStringify(value), limit));

const getEventType = (event: unknown): string =>
  getStringValue(event, 'type') ?? 'unknown';

const extractModelReasoningDelta = (event: unknown): string | null => {
  if (getEventType(event) !== 'modelStreamUpdateEvent') {
    return null;
  }

  const modelEvent = getRecordValue(event, 'event');
  if (getStringValue(modelEvent, 'type') !== 'modelContentBlockDeltaEvent') {
    return null;
  }

  const delta = getRecordValue(modelEvent, 'delta');
  const deltaType = getStringValue(delta, 'type');
  if (deltaType !== 'reasoningContentDelta' && deltaType !== 'reasoningText') {
    return null;
  }

  const text = getStringValue(delta, 'text') ?? '';
  return text.length > 0 ? text : null;
};

export const extractRuntimeModelTextDelta = (event: unknown): string | null => {
  if (getEventType(event) !== 'modelStreamUpdateEvent') {
    return null;
  }

  const modelEvent = getRecordValue(event, 'event');
  if (getStringValue(modelEvent, 'type') !== 'modelContentBlockDeltaEvent') {
    return null;
  }

  const delta = getRecordValue(modelEvent, 'delta');
  if (getStringValue(delta, 'type') !== 'textDelta') {
    return null;
  }

  const text = getStringValue(delta, 'text') ?? '';
  return text.length > 0 ? text : null;
};

const getToolUse = (event: unknown): Record<string, unknown> | null =>
  toRecord(getRecordValue(event, 'toolUse'));

const getToolUseName = (event: unknown): string =>
  getStringValue(getToolUse(event), 'name') ?? 'unknown_tool';

const getToolUseId = (event: unknown): string | undefined =>
  getStringValue(getToolUse(event), 'toolUseId');

const getToolUseInput = (event: unknown): unknown =>
  getRecordValue(getToolUse(event), 'input');

const getErrorMessage = (event: unknown): string | undefined => {
  const error = getRecordValue(event, 'error');
  return error instanceof Error
    ? error.message
    : getStringValue(error, 'message');
};

const getToolResultStatus = (event: unknown): string | undefined =>
  getStringValue(getRecordValue(event, 'result'), 'status');

export const normalizeAgentRuntimeStreamEvent = (
  event: unknown,
): TAgentRuntimeEventDraft[] => {
  const type = getEventType(event);

  switch (type) {
    case 'beforeInvocationEvent':
      return [{
        type: 'agent.debug',
        visibility: 'debug',
        level: 'debug',
        name: 'beforeInvocation',
      }];

    case 'beforeModelCallEvent': {
      const tokens = getRecordValue(event, 'projectedInputTokens');
      const hasTokens = typeof tokens === 'number';

      return [{
        type: 'agent.model.started',
        visibility: 'debug',
        level: 'info',
        projectedInputTokensAvailable: hasTokens,
        ...(hasTokens ? { projectedInputTokens: tokens } : {}),
      }];
    }

    case 'afterModelCallEvent': {
      const stopData = getRecordValue(event, 'stopData');
      const errorMessage = getErrorMessage(event);
      const stopReason = getStringValue(stopData, 'stopReason');

      return [{
        type: 'agent.model.completed',
        visibility: 'debug',
        level: errorMessage ? 'error' : 'info',
        ok: !errorMessage,
        ...(stopReason ? { stopReason } : {}),
        ...(errorMessage ? { errorMessage } : {}),
      }];
    }

    case 'modelStreamUpdateEvent': {
      const reasoningText = extractModelReasoningDelta(event);
      if (reasoningText) {
        return [{
          type: 'agent.reasoning.delta',
          visibility: 'user',
          level: 'info',
          text: redactForStream(reasoningText),
        }];
      }

      const text = extractRuntimeModelTextDelta(event);

      return text
        ? [{
          type: 'agent.text.delta',
          visibility: 'debug',
          level: 'debug',
          text: redactForStream(text),
        }]
        : [];
    }

    case 'beforeToolCallEvent': {
      const toolName = getToolUseName(event);
      const toolUseId = getToolUseId(event);
      const inputPreview = previewUnknown(getToolUseInput(event));

      return [{
        type: 'agent.tool.started',
        visibility: 'user',
        level: 'info',
        toolName,
        ...(toolUseId ? { toolUseId } : {}),
        ...(inputPreview ? { inputPreview } : {}),
      }];
    }

    case 'toolStreamUpdateEvent': {
      const data = getRecordValue(getRecordValue(event, 'event'), 'data');
      const dataPreview = previewUnknown(data);

      return dataPreview
        ? [{
          type: 'agent.tool.progress',
          visibility: 'debug',
          level: 'info',
          dataPreview,
        }]
        : [];
    }

    case 'afterToolCallEvent': {
      const toolName = getToolUseName(event);
      const toolUseId = getToolUseId(event);
      const errorMessage = getErrorMessage(event);
      const status = getToolResultStatus(event);
      const ok = !errorMessage && status !== 'error';
      const resultPreview = ok ? previewUnknown(getRecordValue(event, 'result'), 1200) : '';

      return [{
        type: 'agent.tool.completed',
        visibility: 'user',
        level: ok ? 'info' : 'error',
        toolName,
        ok,
        ...(toolUseId ? { toolUseId } : {}),
        ...(resultPreview ? { resultPreview } : {}),
        ...(errorMessage ? { errorMessage } : {}),
      }];
    }

    case 'messageAddedEvent': {
      const message = getRecordValue(event, 'message');
      const role = getStringValue(message, 'role');

      return [{
        type: 'agent.message.added',
        visibility: 'debug',
        level: 'debug',
        ...(role ? { role } : {}),
      }];
    }

    case 'agentResultEvent': {
      const result = getRecordValue(event, 'result');
      const stopReason = getStringValue(result, 'stopReason');

      return [{
        type: 'agent.run.completed',
        visibility: 'debug',
        level: 'info',
        ...(stopReason ? { stopReason } : {}),
      }];
    }

    default:
      return [{
        type: 'agent.debug',
        visibility: 'debug',
        level: 'debug',
        name: 'unhandled_runtime_event',
        data: {
          eventType: type,
        },
      }];
  }
};
