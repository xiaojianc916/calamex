import type { TContextCompactionReason } from '../../streaming/stream-types.js';
import type { IAgentRuntimeRunOptions } from '../contracts/runtime-contracts.js';
import type { TMastraChatMessage } from '../types.js';
import type { AgentExecutionSession, IAgentSessionContextCompaction } from './agent-session.js';
import {
  buildContextCompactionContinuationMessages,
  buildContextCompactionGenerationRequest,
  type IContextCompactionGenerationRequest,
} from './compaction-generation.js';

export type TContextCompactionSummaryOutput =
  | string
  | Iterable<string>
  | AsyncIterable<string>;

export interface IContextCompactionSummaryGenerationContext {
  readonly compactionId: string;
  readonly signal?: AbortSignal | undefined;
}

export type TContextCompactionSummaryGenerator = (
  request: IContextCompactionGenerationRequest,
  context: IContextCompactionSummaryGenerationContext,
) => Promise<TContextCompactionSummaryOutput> | TContextCompactionSummaryOutput;

export interface IRunContextCompactionInput {
  readonly session: AgentExecutionSession;
  readonly messages: readonly TMastraChatMessage[];
  readonly generateSummary: TContextCompactionSummaryGenerator;
  readonly options?: IAgentRuntimeRunOptions | undefined;
  readonly runId?: string | undefined;
  readonly reason?: TContextCompactionReason | undefined;
  readonly retainedUserMessageByteBudget?: number | undefined;
  readonly handoffPrompt?: string | undefined;
  readonly projectedInputTokens?: number | undefined;
  readonly remainingInputTokens?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface IRunContextCompactionResult {
  readonly compaction: IAgentSessionContextCompaction;
  readonly generationRequest: IContextCompactionGenerationRequest;
  readonly summary: string;
  readonly continuationMessages: TMastraChatMessage[];
}

const isAsyncIterable = (value: unknown): value is AsyncIterable<string> =>
  typeof (value as { [Symbol.asyncIterator]?: unknown })?.[Symbol.asyncIterator] === 'function';

const isIterable = (value: unknown): value is Iterable<string> =>
  typeof (value as { [Symbol.iterator]?: unknown })?.[Symbol.iterator] === 'function';

async function* toSummaryDeltaStream(output: TContextCompactionSummaryOutput): AsyncIterable<string> {
  if (typeof output === 'string') {
    yield output;
    return;
  }

  if (isAsyncIterable(output)) {
    for await (const delta of output) {
      yield delta;
    }
    return;
  }

  if (isIterable(output)) {
    for (const delta of output) {
      yield delta;
    }
  }
}

const assertNotAborted = (signal: AbortSignal | undefined): void => {
  if (!signal?.aborted) {
    return;
  }

  throw new Error('Context compaction aborted.');
};

export const runContextCompaction = async (
  input: IRunContextCompactionInput,
): Promise<IRunContextCompactionResult> => {
  assertNotAborted(input.signal);

  const reason = input.reason ?? 'budget';
  const started = input.session.startContextCompaction({ reason });
  const sourceMessageCount = input.messages.length;

  input.session.pushRuntimeEvent({
    type: 'acontext.context_compaction.started',
    visibility: 'debug',
    level: 'info',
    compactionId: started.id,
    reason,
    sourceMessageCount,
    ...(input.projectedInputTokens !== undefined ? { projectedInputTokens: input.projectedInputTokens } : {}),
    ...(input.remainingInputTokens !== undefined ? { remainingInputTokens: input.remainingInputTokens } : {}),
  }, input.options, input.runId);

  const generationRequest = buildContextCompactionGenerationRequest({
    messages: input.messages,
    retainedUserMessageByteBudget: input.retainedUserMessageByteBudget,
    handoffPrompt: input.handoffPrompt,
  });
  const output = await input.generateSummary(generationRequest, {
    compactionId: started.id,
    signal: input.signal,
  });
  let summary = '';

  for await (const delta of toSummaryDeltaStream(output)) {
    assertNotAborted(input.signal);

    if (delta.length === 0) {
      continue;
    }

    summary += delta;
    const updated = input.session.appendContextCompactionDelta(started.id, { summaryDelta: delta });

    input.session.pushRuntimeEvent({
      type: 'acontext.context_compaction.updated',
      visibility: 'debug',
      level: 'info',
      compactionId: started.id,
      summaryDeltaCharCount: delta.length,
      summaryCharCount: updated?.summary.length ?? summary.length,
    }, input.options, input.runId);
  }

  const trimmedSummary = summary.trim();
  if (trimmedSummary.length === 0) {
    throw new Error('Context compaction produced an empty summary.');
  }

  const completed = input.session.completeContextCompaction(started.id, {
    summary: trimmedSummary,
  }) ?? started;

  input.session.pushRuntimeEvent({
    type: 'acontext.context_compaction.completed',
    visibility: 'debug',
    level: 'info',
    compactionId: started.id,
    reason,
    summaryCharCount: completed.summary.length,
    retainedUserMessageByteBudget: generationRequest.retainedUserMessageByteCount,
    sourceMessageCount,
  }, input.options, input.runId);

  return {
    compaction: completed,
    generationRequest,
    summary: completed.summary,
    continuationMessages: buildContextCompactionContinuationMessages({
      messages: input.messages,
      summary: completed.summary,
    }),
  };
};
