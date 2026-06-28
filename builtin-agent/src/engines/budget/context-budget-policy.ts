import type { IAgentModelCapabilities } from '../../models/capabilities.js';
import type { TMastraChatMessage, TMastraTextPart } from '../shared/types.js';

export const AGENT_CONTEXT_COMPACTION_REMAINING_TOKEN_BUDGET_ENV = 'AGENT_COMPACTION_REMAINING_TOKEN_BUDGET';
export const DEFAULT_CONTEXT_COMPACTION_REMAINING_TOKEN_BUDGET = 40_000;
export const MIN_COMPACTION_CONTEXT_WINDOW_TOKENS = 80_000;
export const COMPACTION_RETAINED_USER_MESSAGES_BYTE_BUDGET = 80_000;

export type TContextBudgetDecisionKind =
  | 'within_budget'
  | 'compact_recommended'
  | 'warn_context_limit';

export interface IContextBudgetDecision {
  kind: TContextBudgetDecisionKind;
  projectedInputTokens: number;
  contextWindowTokens: number;
  maxOutputTokens: number;
  availableInputTokens: number;
  remainingInputTokens: number;
  compactionRemainingTokenBudget: number;
  compactionSupported: boolean;
  retainedUserMessageByteBudget: number;
}

export interface IResolveContextBudgetDecisionInput {
  projectedInputTokens: number;
  capabilities: Pick<IAgentModelCapabilities, 'contextWindowTokens' | 'maxOutputTokens'>;
  env?: NodeJS.ProcessEnv | undefined;
}

const parsePositiveInteger = (value: string | undefined): number | null => {
  if (!value?.trim()) {
    return null;
  }

  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

export const resolveContextCompactionRemainingTokenBudget = (
  env: NodeJS.ProcessEnv = process.env,
): number => parsePositiveInteger(env[AGENT_CONTEXT_COMPACTION_REMAINING_TOKEN_BUDGET_ENV])
  ?? DEFAULT_CONTEXT_COMPACTION_REMAINING_TOKEN_BUDGET;

const normalizeNonNegativeInteger = (value: number): number =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

export const resolveContextBudgetDecision = (
  input: IResolveContextBudgetDecisionInput,
): IContextBudgetDecision => {
  const projectedInputTokens = normalizeNonNegativeInteger(input.projectedInputTokens);
  const contextWindowTokens = normalizeNonNegativeInteger(input.capabilities.contextWindowTokens);
  const maxOutputTokens = normalizeNonNegativeInteger(input.capabilities.maxOutputTokens);
  const availableInputTokens = Math.max(0, contextWindowTokens - maxOutputTokens);
  const remainingInputTokens = availableInputTokens - projectedInputTokens;
  const compactionRemainingTokenBudget = resolveContextCompactionRemainingTokenBudget(input.env);
  const compactionSupported = contextWindowTokens >= MIN_COMPACTION_CONTEXT_WINDOW_TOKENS;
  const needsIntervention = remainingInputTokens <= compactionRemainingTokenBudget;

  return {
    kind: needsIntervention
      ? (compactionSupported ? 'compact_recommended' : 'warn_context_limit')
      : 'within_budget',
    projectedInputTokens,
    contextWindowTokens,
    maxOutputTokens,
    availableInputTokens,
    remainingInputTokens,
    compactionRemainingTokenBudget,
    compactionSupported,
    retainedUserMessageByteBudget: COMPACTION_RETAINED_USER_MESSAGES_BYTE_BUDGET,
  };
};

const isTextPart = (part: unknown): part is TMastraTextPart => {
  if (!part || typeof part !== 'object') {
    return false;
  }

  const record = part as { type?: unknown; text?: unknown };
  return record.type === 'text' && typeof record.text === 'string';
};

const extractUserMessageText = (message: TMastraChatMessage): string => {
  if (message.role !== 'user') {
    return '';
  }

  if (typeof message.content === 'string') {
    return message.content;
  }

  return message.content
    .filter(isTextPart)
    .map((part) => part.text)
    .join('\n');
};

export const retainRecentUserMessageTexts = (
  messages: readonly TMastraChatMessage[],
  byteBudget = COMPACTION_RETAINED_USER_MESSAGES_BYTE_BUDGET,
): string[] => {
  const budget = normalizeNonNegativeInteger(byteBudget);
  if (budget === 0) {
    return [];
  }

  const retained: string[] = [];
  let remainingBytes = budget;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }

    const text = extractUserMessageText(message).trim();
    if (!text) {
      continue;
    }

    const byteLength = Buffer.byteLength(text, 'utf8');
    if (byteLength > remainingBytes) {
      break;
    }

    retained.push(text);
    remainingBytes -= byteLength;
  }

  return retained.reverse();
};
