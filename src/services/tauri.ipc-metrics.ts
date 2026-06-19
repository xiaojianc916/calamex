import type { z } from 'zod';
import type { IPayloadMetrics } from './tauri.ipc-types';

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

const serializeForLog = (value: unknown): string => {
  if (value === undefined) {
    return '';
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const buildPayloadMetricsFromSerialized = (serialized: string): IPayloadMetrics => {
  if (!serialized) {
    return { bytes: 0 };
  }

  return {
    bytes: textEncoder ? textEncoder.encode(serialized).length : serialized.length,
  };
};

export const buildPayloadMetrics = (value: unknown): IPayloadMetrics =>
  buildPayloadMetricsFromSerialized(serializeForLog(value));

export const formatZodIssueSummary = (issues: z.ZodIssue[]): string => {
  const issue = issues[0];

  if (!issue) {
    return '未返回具体字段错误。';
  }

  const path = issue.path.length ? issue.path.join('.') : '响应根节点';

  return `${path}: ${issue.message}`;
};

export const buildPayloadMetricsOmittingTextFields = <T extends Record<string, unknown>>(
  value: T,
  omittedFields: readonly string[],
): IPayloadMetrics => {
  const omittedFieldSet = new Set(omittedFields);
  let omittedBytes = 0;
  const valueWithoutOmittedText: Record<string, unknown> = {};

  for (const [field, fieldValue] of Object.entries(value)) {
    if (omittedFieldSet.has(field) && typeof fieldValue === 'string') {
      omittedBytes += textEncoder ? textEncoder.encode(fieldValue).length : fieldValue.length;
      continue;
    }

    valueWithoutOmittedText[field] = fieldValue;
  }

  const baseMetrics = buildPayloadMetrics(valueWithoutOmittedText);
  return {
    bytes: baseMetrics.bytes + omittedBytes,
  };
};

export const measureScriptContentInput = (value: Record<string, unknown>): IPayloadMetrics =>
  buildPayloadMetricsOmittingTextFields(value, ['content']);

export const measureAiChatInput = <T extends Record<string, unknown>>(value: T): IPayloadMetrics =>
  buildPayloadMetricsOmittingTextFields(value, ['messages', 'references']);

export const measureAiInlineCompletionInput = <T extends Record<string, unknown>>(
  value: T,
): IPayloadMetrics =>
  buildPayloadMetricsOmittingTextFields(value, ['prefix', 'suffix', 'recentEdits']);
