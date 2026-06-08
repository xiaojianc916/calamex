import type { TMastraChatMessage } from '../types.js';
import { retainRecentUserMessageTexts } from '../budget/context-budget-policy.js';
import { COMPACTION_HANDOFF_PROMPT } from './session-messages.js';

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

const countUtf8Bytes = (texts: readonly string[]): number =>
  texts.reduce((total, text) => total + Buffer.byteLength(text, 'utf8'), 0);

const normalizeHandoffPrompt = (prompt: string | undefined): string => {
  const trimmed = prompt?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : COMPACTION_HANDOFF_PROMPT;
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
