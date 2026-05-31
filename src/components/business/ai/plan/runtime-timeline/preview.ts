import { MAX_TOOL_TAGS, PREVIEW_PATH_KEYS, PREVIEW_QUERY_KEYS } from './constants';
import { clipTag, isNonEmptyString } from './text';
import type { TToolLifecycleEvent } from './types';

export const collectPreviewTextCandidates = (
  value: unknown,
  output: string[],
  depth = 0,
): void => {
  if (output.length >= MAX_TOOL_TAGS || depth > 3) {
    return;
  }

  if (isNonEmptyString(value)) {
    output.push(clipTag(value));
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPreviewTextCandidates(item, output, depth + 1);
      if (output.length >= MAX_TOOL_TAGS) {
        return;
      }
    }
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  const record = value as Record<string, unknown>;
  const priorityKeys = [
    'query',
    'path',
    'filePath',
    'pattern',
    'url',
    'command',
    'title',
    'summary',
    'text',
    'content',
    'result',
    'toolResult',
  ];

  for (const key of priorityKeys) {
    collectPreviewTextCandidates(record[key], output, depth + 1);
    if (output.length >= MAX_TOOL_TAGS) {
      return;
    }
  }
};

export const parsePreviewValue = (value: string | undefined): string[] => {
  if (!isNonEmptyString(value)) {
    return [];
  }

  const normalized = value.trim();

  try {
    const parsed: unknown = JSON.parse(normalized);

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const tags: string[] = [];
      collectPreviewTextCandidates(parsed, tags);

      if (tags.length > 0) {
        return tags;
      }
    }
  } catch {
    // 非 JSON 内容按原始文本预览处理。
  }

  const clipped = clipTag(normalized);
  return clipped ? [clipped] : [];
};

export const parsePreviewRecord = (
  value: string | undefined,
): Record<string, unknown> | null => {
  if (!isNonEmptyString(value)) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(value.trim());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

export const parsePreviewJson = (value: string | undefined): unknown | null => {
  if (!isNonEmptyString(value)) {
    return null;
  }

  try {
    return JSON.parse(value.trim()) as unknown;
  } catch {
    return null;
  }
};

const collectPreviewPathCandidate = (value: unknown, depth = 0): string | null => {
  if (depth > 4 || value == null) {
    return null;
  }

  if (isNonEmptyString(value)) {
    return value.trim();
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = collectPreviewPathCandidate(item, depth + 1);

      if (candidate) {
        return candidate;
      }
    }

    return null;
  }

  if (typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;

  for (const key of PREVIEW_PATH_KEYS) {
    const candidate = collectPreviewPathCandidate(record[key], depth + 1);

    if (candidate) {
      return candidate;
    }
  }

  for (const nestedValue of Object.values(record)) {
    const candidate = collectPreviewPathCandidate(nestedValue, depth + 1);

    if (candidate) {
      return candidate;
    }
  }

  return null;
};

export const extractPathFromTextPreview = (value: string): string | null => {
  const normalized = value.trim();
  const windowsMatch = normalized.match(/[A-Za-z]:[\\/][^"'\n\r\t]+/u);

  if (windowsMatch?.[0]) {
    return windowsMatch[0].trim();
  }

  const unixMatch = normalized.match(
    /(?:^|[\s"'])((?:\.{1,2}[\\/]|[\\/])[^"]+?\.[A-Za-z0-9_-]{1,12})/u,
  );

  if (unixMatch?.[1]) {
    return unixMatch[1].trim();
  }

  return null;
};

export const resolvePreviewPath = (value: string | undefined): string | null => {
  const parsed = parsePreviewJson(value);
  const structuredCandidate = collectPreviewPathCandidate(parsed);

  if (structuredCandidate) {
    return structuredCandidate;
  }

  if (!isNonEmptyString(value)) {
    return null;
  }

  return extractPathFromTextPreview(value);
};

const collectPreviewQueryCandidate = (value: unknown, depth = 0): string | null => {
  if (depth > 4 || value == null) {
    return null;
  }

  if (isNonEmptyString(value)) {
    return value.trim();
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = collectPreviewQueryCandidate(item, depth + 1);

      if (candidate) {
        return candidate;
      }
    }

    return null;
  }

  if (typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;

  for (const key of PREVIEW_QUERY_KEYS) {
    const candidate = collectPreviewQueryCandidate(record[key], depth + 1);

    if (candidate) {
      return candidate;
    }
  }

  return null;
};

const collectPreviewCommandCandidate = (value: unknown, depth = 0): string | null => {
  if (depth > 4 || value == null) {
    return null;
  }

  if (isNonEmptyString(value)) {
    return value.trim();
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = collectPreviewCommandCandidate(item, depth + 1);

      if (candidate) {
        return candidate;
      }
    }

    return null;
  }

  if (typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;

  for (const key of ['command', 'cmd', 'script'] as const) {
    const candidate = collectPreviewCommandCandidate(record[key], depth + 1);

    if (candidate) {
      return candidate;
    }
  }

  return null;
};

export const resolvePreviewQuery = (value: string | undefined): string | null => {
  const parsed = parsePreviewJson(value);
  const structuredCandidate = collectPreviewQueryCandidate(parsed);

  if (structuredCandidate) {
    return structuredCandidate;
  }

  return isNonEmptyString(value) ? value.trim() : null;
};

export const resolvePreviewCommand = (value: string | undefined): string | null => {
  const parsed = parsePreviewJson(value);
  const structuredCandidate = collectPreviewCommandCandidate(parsed);

  if (structuredCandidate) {
    return structuredCandidate;
  }

  return isNonEmptyString(value) ? value.trim() : null;
};

export const formatTerminalResultSummary = (
  value: Record<string, unknown>,
): string | null => {
  const segments: string[] = [];

  for (const [key, label] of [
    ['exitCode', 'exit'],
    ['statusCode', 'status'],
    ['code', 'code'],
  ] as const) {
    const candidate = value[key];

    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      segments.push(`${label} ${candidate}`);
      break;
    }
  }

  const durationMs = value.durationMs;
  if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
    segments.push(`${durationMs}ms`);
  }

  return segments.length ? segments.join(' · ') : null;
};

export const getPreviewStringField = (
  value: Record<string, unknown> | null,
  key: string,
): string | null => {
  const candidate = value?.[key];

  return isNonEmptyString(candidate) ? candidate.trimEnd() : null;
};

export const getPreviewRecordField = (
  value: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null => {
  const candidate = value?.[key];

  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : null;
};

const removePowerShellCliXml = (value: string): string => {
  const markerIndex = value.indexOf('#< CLIXML');

  if (markerIndex < 0) {
    return value;
  }

  return value.slice(0, markerIndex).trimEnd();
};

export const normalizeTerminalOutput = (value: string): string =>
  removePowerShellCliXml(value).replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');

export const parseCommandProgressPreview = (
  value: string | undefined,
): { output: string; terminalStreaming?: boolean } | null => {
  const parsed = parsePreviewRecord(value);
  const stream = getPreviewStringField(parsed, 'stream');

  if (!stream) {
    return null;
  }

  if (stream === 'command') {
    const command = getPreviewStringField(parsed, 'command');
    return command ? { output: `> ${command}\n`, terminalStreaming: true } : null;
  }

  if (stream === 'stdout' || stream === 'stderr') {
    const output = getPreviewStringField(parsed, 'output');
    const normalizedOutput = output ? normalizeTerminalOutput(output) : '';
    return normalizedOutput ? { output: normalizedOutput, terminalStreaming: true } : null;
  }

  if (stream === 'exit') {
    const summary = formatTerminalResultSummary(parsed ?? {});
    return {
      output: summary ? `\n${summary}\n` : '\n',
      terminalStreaming: false,
    };
  }

  return null;
};

export const resolveCommandTerminalOutput = (
  event: TToolLifecycleEvent,
  command: string,
): string | undefined => {
  const parsedInput =
    event.type === 'agent.tool.started' ? parsePreviewRecord(event.inputPreview) : null;
  const parsedResult =
    event.type === 'agent.tool.completed' ? parsePreviewRecord(event.resultPreview) : null;
  const resultOutput =
    getPreviewRecordField(parsedResult, 'output') ??
    getPreviewRecordField(parsedResult, 'result') ??
    getPreviewRecordField(parsedResult, 'toolResult');
  const resolvedCommand =
    getPreviewStringField(parsedResult, 'command') ??
    getPreviewStringField(parsedInput, 'command') ??
    command;
  const lines: string[] = [`> ${resolvedCommand}`];

  if (event.type === 'agent.tool.started') {
    return `${lines.join('\n')}\n`;
  }

  const stdout =
    getPreviewStringField(parsedResult, 'stdout') ??
    getPreviewStringField(resultOutput, 'stdout') ??
    getPreviewStringField(parsedResult, 'output') ??
    getPreviewStringField(parsedResult, 'text');
  const stderr =
    getPreviewStringField(parsedResult, 'stderr') ?? getPreviewStringField(resultOutput, 'stderr');

  const alreadyStreamed = Boolean(event.type === 'agent.tool.completed' && event.toolUseId);

  if (!alreadyStreamed) {
    if (stdout) {
      lines.push(normalizeTerminalOutput(stdout));
    }

    if (stderr) {
      const normalizedStderr = normalizeTerminalOutput(stderr);

      if (normalizedStderr) {
        lines.push(normalizedStderr);
      }
    }
  }

  if (!event.ok && isNonEmptyString(event.errorMessage)) {
    lines.push(event.errorMessage.trim());
  }

  const summary = formatTerminalResultSummary(resultOutput ?? parsedResult ?? {});

  if (summary && !alreadyStreamed) {
    lines.push(summary);
  }

  if (lines.length === 1 && !alreadyStreamed && isNonEmptyString(event.resultPreview)) {
    lines.push(event.resultPreview.trimEnd());
  }

  return lines.length > 1 ? lines.join('\n') : `${lines[0]}\n`;
};

export const extractFileNameFromPath = (value: string | undefined): string | null => {
  const path = resolvePreviewPath(value);

  if (!path) {
    return null;
  }

  const normalized = path.replace(/\\/gu, '/').replace(/\/+$/u, '');
  const fileName = normalized.split('/').filter(Boolean).at(-1)?.trim();

  return fileName || path;
};

const previewValueHasResultItems = (value: unknown, depth = 0): boolean => {
  if (depth > 4 || value == null) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (typeof value !== 'object') {
    return Boolean(value);
  }

  const record = value as Record<string, unknown>;
  const directCounts = [
    record.count,
    record.total,
    record.totalCount,
    record.matchCount,
    record.matchesCount,
  ];

  if (directCounts.some((item) => typeof item === 'number' && item > 0)) {
    return true;
  }

  for (const key of ['results', 'matches', 'items', 'symbols', 'files', 'entries']) {
    const candidate = record[key];

    if (Array.isArray(candidate) && candidate.length > 0) {
      return true;
    }
  }

  for (const key of ['result', 'toolResult', 'data', 'output']) {
    if (previewValueHasResultItems(record[key], depth + 1)) {
      return true;
    }
  }

  return false;
};

export const previewHasResultItems = (value: string | undefined): boolean => {
  const parsed = parsePreviewJson(value);

  if (parsed == null) {
    return isNonEmptyString(value);
  }

  return previewValueHasResultItems(parsed);
};
