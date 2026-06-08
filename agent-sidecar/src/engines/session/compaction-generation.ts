import type { TMastraChatMessage } from '../types.js';
import { retainRecentUserMessageTexts } from '../budget/context-budget-policy.js';
import {
  buildCompactionResumeUserPrompt,
  COMPACTION_HANDOFF_PROMPT,
  getSessionMessageText,
} from './session-messages.js';

export interface IBuildContextCompactionGenerationRequestInput {
  messages: readonly TMastraChatMessage[];
  retainedUserMessageByteBudget?: number | undefined;
  handoffPrompt?: string | undefined;
}

export interface IContextCompactionGenerationRequest {
  readonly messages: TMastraChatMessage[];
  readonly handoffPrompt: string;
  readonly retainedUserMessageCount: number;
  readonly retainedUserMessageByteCount: number;
}

export interface IBuildContextCompactionContinuationMessagesInput {
  messages: readonly TMastraChatMessage[];
  summary: string;
}

const countUtf8Bytes = (texts: readonly string[]): number =>
  texts.reduce((total, text) => total + Buffer.byteLength(text, 'utf8'), 0);

const normalizeHandoffPrompt = (prompt: string | undefined): string => {
  const trimmed = prompt?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : COMPACTION_HANDOFF_PROMPT;
};

const cloneMastraMessage = (message: TMastraChatMessage): TMastraChatMessage => {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content,
    };
  }

  return {
    role: 'user',
    content: Array.isArray(message.content)
      ? message.content.map((part) => ({ ...part }))
      : message.content,
  };
};

const findLastNonEmptyUserMessageIndex = (messages: readonly TMastraChatMessage[]): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message?.role === 'user' && getSessionMessageText(message.content).trim().length > 0) {
      return index;
    }
  }

  return -1;
};

export const buildContextCompactionGenerationRequest = (
  input: IBuildContextCompactionGenerationRequestInput,
): IContextCompactionGenerationRequest => {
  const handoffPrompt = normalizeHandoffPrompt(input.handoffPrompt);
  const retainedUserMessages = retainRecentUserMessageTexts(
    input.messages,
    input.retainedUserMessageByteBudget,
  );
  const messages: TMastraChatMessage[] = [
    ...retainedUserMessages.map<TMastraChatMessage>((content) => ({
      role: 'user',
      content,
    })),
    {
      role: 'user',
      content: handoffPrompt,
    },
  ];

  return {
    messages,
    handoffPrompt,
    retainedUserMessageCount: retainedUserMessages.length,
    retainedUserMessageByteCount: countUtf8Bytes(retainedUserMessages),
  };
};

export const buildContextCompactionContinuationMessages = (
  input: IBuildContextCompactionContinuationMessagesInput,
): TMastraChatMessage[] => {
  const summary = input.summary.trim();

  if (summary.length === 0) {
    return input.messages.map(cloneMastraMessage);
  }

  const compactionMessage: TMastraChatMessage = {
    role: 'user',
    content: buildCompactionResumeUserPrompt(summary),
  };
  const lastUserMessageIndex = findLastNonEmptyUserMessageIndex(input.messages);

  if (lastUserMessageIndex < 0) {
    return [compactionMessage];
  }

  return [
    compactionMessage,
    ...input.messages.slice(lastUserMessageIndex).map(cloneMastraMessage),
  ];
};
