import type { TAgentRuntimeOutputEvent } from '../engines/runtime-contracts.js';
import type { TJsonValue } from '../schemas/events.js';
import { createAgentStreamAdapter } from './stream-adapter.js';
import type { AgentStreamEventBus } from './stream-event-bus.js';
import { redactForStream } from './stream-redaction.js';
import type {
  IAgentEventStreamSource,
  IAgentStreamResult,
  TAgentStreamOptions,
} from './stream-runtime-contract.js';

export interface ICompletedAgentStream<TResult extends IAgentStreamResult = IAgentStreamResult> {
  agentResult: TResult;
  visibleText: string;
}

export interface IRunAgentStreamParams<TResult extends IAgentStreamResult = IAgentStreamResult> {
  agent: IAgentEventStreamSource<TResult>;
  prompt: string;
  streamOptions: TAgentStreamOptions;
  eventBus: AgentStreamEventBus;
  emitOutputEvent: (event: TAgentRuntimeOutputEvent) => void;
  toJsonValue: (value: unknown) => TJsonValue;
}

const RUN_INPUT_PREVIEW_CHARS = 300;
const RUN_OUTPUT_PREVIEW_CHARS = 1200;

const clipPreview = (value: string, limit: number): string => {
  const characters = Array.from(value.replace(/\s+/gu, ' ').trim());

  if (characters.length <= limit) {
    return characters.join('');
  }

  return `${characters.slice(0, limit).join('')}...`;
};

export const runAgentStream = async <TResult extends IAgentStreamResult>(
  params: IRunAgentStreamParams<TResult>,
): Promise<ICompletedAgentStream<TResult>> => {
  const adapter = createAgentStreamAdapter({
    eventBus: params.eventBus,
    emitOutputEvent: params.emitOutputEvent,
    toJsonValue: params.toJsonValue,
  });

  params.eventBus.emitDraft({
    type: 'agent.run.started',
    visibility: 'user',
    level: 'info',
    inputPreview: redactForStream(clipPreview(params.prompt, RUN_INPUT_PREVIEW_CHARS)),
  });

  try {
    const stream = params.agent.stream(params.prompt, params.streamOptions);

    while (true) {
      const next = await stream.next();
      if (next.done) {
        const visibleText = adapter.complete();
        const outputPreview = visibleText.trim()
          ? redactForStream(clipPreview(visibleText, RUN_OUTPUT_PREVIEW_CHARS))
          : undefined;

        params.eventBus.emitDraft({
          type: 'agent.run.completed',
          visibility: 'user',
          level: 'info',
          ...(next.value.stopReason ? { stopReason: next.value.stopReason } : {}),
          ...(outputPreview ? { outputPreview } : {}),
        });

        return {
          agentResult: next.value,
          visibleText,
        };
      }

      adapter.consume(next.value);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    params.eventBus.emitDraft({
      type: 'agent.run.error',
      visibility: 'user',
      level: 'error',
      errorMessage: message,
    });

    throw error;
  }
};
