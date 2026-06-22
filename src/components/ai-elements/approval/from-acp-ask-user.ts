import type { IAskUserQuestion, IAskUserResult } from '@/types/ai/sidecar';

import type { IAcpPermissionRequest, TAcpPermissionOptionKind } from './from-acp-permission';

/**
 * 把「其实是 AskUserQuestion」的 ACP 反向 request_permission 适配到既有 QuestionPrompt。
 *
 * 背景：Kimi 等外部 ACP Agent 的每次工具调用（含 AskUserQuestion）都经 session/request_permission
 * 抵达，宿主仅透传 options（+ 可选 toolCall 原始负载）。本模块据此判定是否为提问，并构造
 * QuestionPrompt 所需的 IAskUserQuestion[]；候选项一律取自 request.options（其 optionId 即回投
 * ACP 的决策原值，对齐 approval.rs 的逐字匹配），reject 类对应取消。
 */

/** 可作为答案候选的 allow 类。 */
const ALLOW_KINDS: ReadonlySet<TAcpPermissionOptionKind> = new Set(['allow_once', 'allow_always']);
/** 对应 QuestionPrompt 取消/忽略的 reject 类。 */
const REJECT_KINDS: ReadonlySet<TAcpPermissionOptionKind> = new Set([
  'reject_once',
  'reject_always',
]);

const DEFAULT_QUESTION_TEXT = '请选择一个选项';
const MAX_HEADER_LENGTH = 16;

type TUnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): TUnknownRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as TUnknownRecord)
    : null;

const asNonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const readRawInput = (toolCall: unknown): TUnknownRecord | null => {
  const record = asRecord(toolCall);
  return record ? asRecord(record.rawInput) : null;
};

/**
 * ACP `ToolCallUpdate.content`（[{ type:'content', content:{ type:'text', text } }]）中的首段文本。
 * Kimi Code（TS 版）经 acp-adapter/session.ts::handleQuestion 把真实问句放在这里，而非 rawInput；
 * title 则被硬编码为工具名「AskUserQuestion」。
 */
const readToolCallContentText = (toolCall: unknown): string | null => {
  const record = asRecord(toolCall);
  if (!record || !Array.isArray(record.content)) {
    return null;
  }
  for (const entry of record.content) {
    const entryRecord = asRecord(entry);
    if (!entryRecord || entryRecord.type !== 'content') {
      continue;
    }
    const inner = asRecord(entryRecord.content);
    const text = inner && inner.type === 'text' ? asNonEmptyString(inner.text) : null;
    if (text) {
      return text;
    }
  }
  return null;
};

/** Claude/Kimi AskUserQuestion 的 rawInput.questions[0]（若存在）。 */
const readFirstRawQuestion = (toolCall: unknown): TUnknownRecord | null => {
  const rawInput = readRawInput(toolCall);
  if (!rawInput) {
    return null;
  }
  const questions = rawInput.questions;
  return Array.isArray(questions) && questions.length > 0 ? asRecord(questions[0]) : null;
};

/** rawInput 是否呈 AskUserQuestion 形态（强信号）。 */
const hasQuestionShapedRawInput = (toolCall: unknown): boolean => {
  const rawInput = readRawInput(toolCall);
  if (!rawInput) {
    return false;
  }
  if (Array.isArray(rawInput.questions) && rawInput.questions.length > 0) {
    return true;
  }
  return asNonEmptyString(rawInput.question) !== null;
};

const countKind = (request: IAcpPermissionRequest, kind: TAcpPermissionOptionKind): number =>
  request.options.filter((option) => option.kind === kind).length;

/**
 * 问题文本优先级：toolCall.content 文本（Kimi 把真实问句放这）→ rawInput.questions[0].question
 * → rawInput.question → 兜底。不再回退 toolCall.title：Kimi 把它硬编码为工具名，并非问句。
 */
const resolveQuestionText = (request: IAcpPermissionRequest): string => {
  const toolCall = request.toolCall;
  const fromContent = readToolCallContentText(toolCall);
  const firstQuestion = readFirstRawQuestion(toolCall);
  const fromFirstQuestion = firstQuestion ? asNonEmptyString(firstQuestion.question) : null;
  const rawInput = readRawInput(toolCall);
  const fromRawInput = rawInput ? asNonEmptyString(rawInput.question) : null;
  return fromContent ?? fromFirstQuestion ?? fromRawInput ?? DEFAULT_QUESTION_TEXT;
};

const resolveHeader = (request: IAcpPermissionRequest): string => {
  const firstQuestion = readFirstRawQuestion(request.toolCall);
  const header = firstQuestion ? asNonEmptyString(firstQuestion.header) : null;
  // Kimi 仅透传 question、不发 header：返回空串，让 UI 以问题正文作标题（不再显示默认「提问」）。
  if (!header) {
    return '';
  }
  return header.length > MAX_HEADER_LENGTH ? header.slice(0, MAX_HEADER_LENGTH) : header;
};

/**
 * 判定该权限请求是否其实是 AskUserQuestion；是则返回喂给 QuestionPrompt 的 IAskUserQuestion[]，
 * 否则返回 null（仍按普通工具审批渲染 ApprovalPrompt）。
 *
 * ACP 权限决策只取单个 optionId，故强制单选（multiSelect=false）。
 */
export const buildAcpAskUserQuestions = (
  request: IAcpPermissionRequest,
): IAskUserQuestion[] | null => {
  // [diag·临时] 打印真实 ACP request，用于定位 Kimi 的问题文本字段；定位后请删除。
  const allowOptions = request.options.filter((option) => ALLOW_KINDS.has(option.kind));
  const isAskUser =
    hasQuestionShapedRawInput(request.toolCall) || countKind(request, 'allow_once') >= 2;
  if (!isAskUser || allowOptions.length === 0) {
    return null;
  }

  const question: IAskUserQuestion = {
    questionId: request.toolCallId,
    question: resolveQuestionText(request),
    header: resolveHeader(request),
    type: 'choice',
    options: allowOptions.map((option) => ({ optionId: option.optionId, label: option.name })),
    multiSelect: false,
  };
  return [question];
};

const findRejectOptionId = (request: IAcpPermissionRequest): string | null =>
  request.options.find((option) => REJECT_KINDS.has(option.kind))?.optionId ?? null;

/**
 * QuestionPrompt 的作答 → 回投 ACP 的决策（optionId 原值）。
 * - 选中候选项 → 该 optionId（verbatim 命中 approval.rs::decide）；
 * - 仅自由填写 / 未选 / 取消 → reject 类 optionId（Skip）；无 reject 项则返回 null（调用方走带外取消）。
 */
export const resolveAcpDecisionFromAskUserResult = (
  request: IAcpPermissionRequest,
  result: IAskUserResult,
): string | null => {
  if (result.outcome === 'selected') {
    const selectedId = result.answers?.[0]?.optionIds?.[0];
    if (selectedId) {
      return selectedId;
    }
  }
  return findRejectOptionId(request);
};
