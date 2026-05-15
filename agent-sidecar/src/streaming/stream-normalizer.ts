import { redactForStream } from './stream-redaction.js';
import type { TAgentRuntimeEventDraft } from './stream-types.js';

// -----------------------------------------------------------------------
// Mastra wire-name 常量
//
// LAST VERIFIED AGAINST: @mastra/core ~ check package.json
// 任何 Mastra minor 升级都应该重新 grep 这些字符串确认。
// 与 stream-adapter.ts 应保持一致 —— TODO: 抽到 stream-event-helpers.ts。
// -----------------------------------------------------------------------

const MASTRA_EVENT = {
  beforeInvocation: 'beforeInvocationEvent',
  beforeModelCall: 'beforeModelCallEvent',
  afterModelCall: 'afterModelCallEvent',
  modelStreamUpdate: 'modelStreamUpdateEvent',
  modelContentBlockDelta: 'modelContentBlockDeltaEvent',
  beforeToolCall: 'beforeToolCallEvent',
  toolStreamUpdate: 'toolStreamUpdateEvent',
  afterToolCall: 'afterToolCallEvent',
  messageAdded: 'messageAddedEvent',
  agentResult: 'agentResultEvent',
} as const;

const MASTRA_DELTA_TYPE = {
  textDelta: 'textDelta',
  reasoningContentDelta: 'reasoningContentDelta',
  reasoningText: 'reasoningText',
} as const;

const TOOL_OK_STATUSES: ReadonlySet<string> = new Set(['success', 'ok', 'completed']);
const UNKNOWN_TOOL_NAME = 'unknown_tool';

const PREVIEW_CHAR_LIMIT = 1_000;
const TOOL_RESULT_PREVIEW_LIMIT = 1_200;
const UNHANDLED_EVENT_PREVIEW_LIMIT = 500;

// -----------------------------------------------------------------------
// 底层 unknown 解析（与 stream-adapter.ts 同步，TODO 抽公共）
// -----------------------------------------------------------------------

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

const getEventType = (event: unknown): string =>
  getStringValue(event, 'type') ?? 'unknown';

// -----------------------------------------------------------------------
// 预览生成
// -----------------------------------------------------------------------

interface IClipPreviewOptions {
  limit?: number;
  /** 默认 false：折叠所有空白为单空格。true：保留 `\n`，仅折叠 `\r\t ` 连续空格。 */
  preserveNewlines?: boolean;
}

const clipPreview = (value: string, options: IClipPreviewOptions = {}): string => {
  const { limit = PREVIEW_CHAR_LIMIT, preserveNewlines = false } = options;
  const normalized = preserveNewlines
    ? value.replace(/[ \t\r\f\v]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim()
    : value.replace(/\s+/gu, ' ').trim();
  const characters = Array.from(normalized);
  if (characters.length <= limit) {
    return normalized;
  }
  return `${characters.slice(0, limit).join('')}...`;
};

/**
 * 把任意值序列化为字符串。
 * 处理 BigInt / 循环引用 / Symbol / 抛错的 toJSON。
 */
const safeStringify = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'bigint') {
    return `${value.toString()}n`;
  }
  if (typeof value === 'symbol') {
    return value.toString();
  }
  if (typeof value === 'function') {
    return `[Function${value.name ? ` ${value.name}` : ''}]`;
  }
  try {
    const seen = new WeakSet<object>();
    const serialized = JSON.stringify(value, (_, v) => {
      if (typeof v === 'bigint') {
        return `${v.toString()}n`;
      }
      if (typeof v === 'function') {
        return `[Function${v.name ? ` ${v.name}` : ''}]`;
      }
      if (v && typeof v === 'object') {
        if (seen.has(v as object)) {
          return '[Circular]';
        }
        seen.add(v as object);
      }
      return v;
    });
    return serialized ?? String(value);
  } catch (error) {
    const errName = error instanceof Error ? error.name : 'UnknownError';
    return `[Unserializable: ${errName}]`;
  }
};

/**
 * 关键顺序：safeStringify → **redact → clip**。
 * 先 redact 保证原始上下文（换行、引号、缩进）让 redactor 的正则能匹配；
 * 再 clip 截断长度。颠倒顺序可能导致 PII 泄露。
 */
const previewUnknown = (
  value: unknown,
  options: IClipPreviewOptions = {},
): string => clipPreview(redactForStream(safeStringify(value)), options);

// -----------------------------------------------------------------------
// reasoning / text delta 提取
// -----------------------------------------------------------------------

const isModelContentBlockDelta = (event: unknown): boolean =>
  getEventType(event) === MASTRA_EVENT.modelStreamUpdate
  && getStringValue(getRecordValue(event, 'event'), 'type') === MASTRA_EVENT.modelContentBlockDelta;

const extractModelReasoningDelta = (event: unknown): string | null => {
  if (!isModelContentBlockDelta(event)) {
    return null;
  }
  const delta = getRecordValue(getRecordValue(event, 'event'), 'delta');
  const deltaType = getStringValue(delta, 'type');
  // NOTE: `reasoningText` 是否是 snapshot 待 Mastra 源码 grep 确认。
  // 若是 snapshot，下游累加器会重复计数。
  if (
    deltaType !== MASTRA_DELTA_TYPE.reasoningContentDelta
    && deltaType !== MASTRA_DELTA_TYPE.reasoningText
  ) {
    return null;
  }
  const text = getStringValue(delta, 'text') ?? '';
  return text.length > 0 ? text : null;
};

export const extractRuntimeModelTextDelta = (event: unknown): string | null => {
  if (!isModelContentBlockDelta(event)) {
    return null;
  }
  const delta = getRecordValue(getRecordValue(event, 'event'), 'delta');
  if (getStringValue(delta, 'type') !== MASTRA_DELTA_TYPE.textDelta) {
    return null;
  }
  const text = getStringValue(delta, 'text') ?? '';
  return text.length > 0 ? text : null;
};

// -----------------------------------------------------------------------
// 工具事件解析
// -----------------------------------------------------------------------

const getToolUse = (event: unknown): Record<string, unknown> | null =>
  toRecord(getRecordValue(event, 'toolUse'));

const getToolUseName = (event: unknown): string =>
  getStringValue(getToolUse(event), 'name') ?? UNKNOWN_TOOL_NAME;

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

/** 工具是否成功：无 errorMessage **且** status 不在已知失败集合里。 */
const isToolOk = (errorMessage: string | undefined, status: string | undefined): boolean => {
  if (errorMessage) {
    return false;
  }
  if (status === undefined) {
    return true; // 未声明 status 视为成功（向后兼容）
  }
  return TOOL_OK_STATUSES.has(status);
};

// -----------------------------------------------------------------------
// 主分发
// -----------------------------------------------------------------------

export const normalizeAgentRuntimeStreamEvent = (
  event: unknown,
): TAgentRuntimeEventDraft[] => {
  const type = getEventType(event);
  switch (type) {
    case MASTRA_EVENT.beforeInvocation:
      return [{
        type: 'agent.debug',
        visibility: 'debug',
        level: 'debug',
        name: 'beforeInvocation',
      }];

    case MASTRA_EVENT.beforeModelCall: {
      const tokens = getRecordValue(event, 'projectedInputTokens');
      const hasTokens = typeof tokens === 'number';
      return [{
        type: 'agent.model.started',
        visibility: 'debug',
        level: 'info',
        ...(hasTokens ? { projectedInputTokens: tokens } : {}),
      }];
    }

    case MASTRA_EVENT.afterModelCall: {
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

    case MASTRA_EVENT.modelStreamUpdate: {
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

    case MASTRA_EVENT.beforeToolCall: {
      const toolName = getToolUseName(event);
      const toolUseId = getToolUseId(event);
      // 输入预览保留换行（JSON / 代码可读性）。
      const inputPreview = previewUnknown(
        getToolUseInput(event),
        { preserveNewlines: true },
      );
      return [{
        type: 'agent.tool.started',
        visibility: 'user',
        level: 'info',
        toolName,
        ...(toolUseId ? { toolUseId } : {}),
        ...(inputPreview ? { inputPreview } : {}),
      }];
    }

    case MASTRA_EVENT.toolStreamUpdate: {
      const data = getRecordValue(getRecordValue(event, 'event'), 'data');
      const dataPreview = previewUnknown(data);
      return [{
        type: 'agent.tool.progress',
        visibility: 'debug',
        level: 'info',
        dataPreview,
      }];
    }

    case MASTRA_EVENT.afterToolCall: {
      const toolName = getToolUseName(event);
      const toolUseId = getToolUseId(event);
      const errorMessage = getErrorMessage(event);
      const status = getToolResultStatus(event);
      const ok = isToolOk(errorMessage, status);
      // 失败时也保留 resultPreview —— 排查 root cause 常需要看 partial output。
      const resultPreview = previewUnknown(
        getRecordValue(event, 'result'),
        { limit: TOOL_RESULT_PREVIEW_LIMIT, preserveNewlines: true },
      );
      return [{
        type: 'agent.tool.completed',
        visibility: 'user',
        level: ok ? 'info' : 'error',
        toolName,
        ok,
        ...(toolUseId ? { toolUseId } : {}),
        ...(resultPreview ? { resultPreview } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        ...(status ? { status } : {}),
      }];
    }

    case MASTRA_EVENT.messageAdded: {
      const message = getRecordValue(event, 'message');
      const role = getStringValue(message, 'role');
      return [{
        type: 'agent.message.added',
        visibility: 'debug',
        level: 'debug',
        ...(role ? { role } : {}),
      }];
    }

    case MASTRA_EVENT.agentResult: {
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
        // warn：新版本 Mastra 加事件应该被看见，不要默默吞。
        level: 'warn',
        name: 'unhandled_runtime_event',
        data: {
          eventType: type,
          eventPreview: previewUnknown(event, { limit: UNHANDLED_EVENT_PREVIEW_LIMIT }),
        },
      }];
  }
};