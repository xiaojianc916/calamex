import type { IAiChatMessage } from '@/types/ai';
import { buildThreadEntries } from './build-thread-entries';
import type { TAiThreadEntry } from './entry-types';
import { reconcileThreadEntries } from './reconcile-thread-entries';

const SINGLE_MESSAGE_ENTRY_CACHE_LIMIT = 600;
const LONG_TEXT_TAIL_SIGNATURE_LENGTH = 512;

interface ISingleMessageEntryCacheRecord {
  signature: string;
  entries: TAiThreadEntry[];
}

const singleMessageEntryCache = new Map<string, ISingleMessageEntryCacheRecord>();

const boundedTextSignature = (value: string | undefined): string => {
  if (!value) {
    return '';
  }

  if (value.length <= LONG_TEXT_TAIL_SIGNATURE_LENGTH) {
    return value;
  }

  return [value.length, value.slice(0, 96), value.slice(-LONG_TEXT_TAIL_SIGNATURE_LENGTH)].join(
    ':',
  );
};

const safeJsonSignature = (value: unknown): string => {
  if (value === undefined || value === null) {
    return '';
  }

  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
};

const arrayTailSignature = (values: readonly unknown[] | undefined): string => {
  if (!values || values.length === 0) {
    return '0';
  }

  const tail = values.at(-1);

  return [values.length, safeJsonSignature(tail)].join(':');
};

const buildToolCallsSignature = (message: IAiChatMessage): string => {
  const toolCalls = message.toolCalls;

  if (!toolCalls || toolCalls.length === 0) {
    return '0';
  }

  return toolCalls
    .map((toolCall) =>
      [
        toolCall.id,
        toolCall.name,
        toolCall.status,
        boundedTextSignature(toolCall.summary),
        toolCall.targetPreview ?? '',
      ].join(':'),
    )
    .join('|');
};

const buildAcpToolCallsSignature = (message: IAiChatMessage): string => {
  const acpToolCalls = message.acpToolCalls;

  if (!acpToolCalls || acpToolCalls.length === 0) {
    return '0';
  }

  return acpToolCalls
    .map((toolCall) =>
      [
        toolCall.id,
        toolCall.kind,
        toolCall.status,
        boundedTextSignature(toolCall.title),
        toolCall.content.length,
        safeJsonSignature(toolCall.content.at(-1)),
        safeJsonSignature(toolCall.locations),
        boundedTextSignature(toolCall.rawOutput),
      ].join(':'),
    )
    .join('|');
};

const buildMessageSignature = (message: IAiChatMessage): string => {
  const runtimeEvents = message.stream?.runtimeEvents;
  const changedFiles = message.changedFilesSummary?.files;

  return [
    message.role,
    boundedTextSignature(message.content),
    safeJsonSignature(message.references),
    message.stream?.status ?? '',
    arrayTailSignature(runtimeEvents),
    buildToolCallsSignature(message),
    buildAcpToolCallsSignature(message),
    safeJsonSignature(message.actions),
    safeJsonSignature(message.agentConfirmation),
    message.changedFilesSummary?.id ?? '',
    changedFiles?.length ?? 0,
    safeJsonSignature(changedFiles?.at(-1)),
    message.patches?.length ?? 0,
    safeJsonSignature(message.patches?.at(-1)),
  ].join('\u001f');
};

const trimSingleMessageEntryCache = (): void => {
  while (singleMessageEntryCache.size > SINGLE_MESSAGE_ENTRY_CACHE_LIMIT) {
    const firstKey = singleMessageEntryCache.keys().next().value;

    if (typeof firstKey !== 'string') {
      break;
    }

    singleMessageEntryCache.delete(firstKey);
  }
};

export const buildSingleMessageThreadEntries = (message: IAiChatMessage): TAiThreadEntry[] => {
  const signature = buildMessageSignature(message);
  const cached = singleMessageEntryCache.get(message.id);

  if (cached?.signature === signature) {
    return cached.entries;
  }

  const projected = buildThreadEntries([message]);
  // 条目级结构共享:签名变化时(典型为流式 delta)沿用上一轮中内容未变的条目对象引用,
  // 仅让真正变化的条目(通常只有正在生长的文本块)获得新引用,从而把同一条消息内的
  // 全量子组件重渲染收敛为单条目更新。
  const entries =
    cached !== undefined ? reconcileThreadEntries(cached.entries, projected) : projected;

  singleMessageEntryCache.delete(message.id);
  singleMessageEntryCache.set(message.id, {
    signature,
    entries,
  });

  trimSingleMessageEntryCache();

  return entries;
};

export const clearSingleMessageThreadEntryCache = (): void => {
  singleMessageEntryCache.clear();
};
