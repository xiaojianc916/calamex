import type { TAgentRuntimeEventDraft } from '../../streaming/stream-types.js';
import type { IAgentRuntimeRunOptions, TAgentRuntimeOutputEvent } from '../contracts/runtime-contracts.js';
import { createRuntimeEventFactory, createSessionId, pushUiEvent } from '../utils.js';
import { DEFAULT_EXECUTION_AGENT_ID } from '../types.js';

export interface ICreateAgentExecutionSessionOptions {
  sessionId?: string | undefined;
  runId?: string | undefined;
  agentId?: string | undefined;
  now?: (() => string) | undefined;
}

export class AgentExecutionSession {
  readonly sessionId: string;

  readonly requestedRunId: string;

  readonly agentId: string;

  readonly events: TAgentRuntimeOutputEvent[] = [];

  private readonly now: (() => string) | undefined;

  private readonly runtimeEventFactories = new Map<string, (draft: TAgentRuntimeEventDraft) => TAgentRuntimeOutputEvent>();

  constructor(options: ICreateAgentExecutionSessionOptions = {}) {
    this.sessionId = options.sessionId ?? createSessionId('mastra-execute');
    this.requestedRunId = options.runId ?? createSessionId('mastra-run');
    this.agentId = options.agentId ?? DEFAULT_EXECUTION_AGENT_ID;
    this.now = options.now;
  }

  createRuntimeEventFactory(runId = this.requestedRunId): (draft: TAgentRuntimeEventDraft) => TAgentRuntimeOutputEvent {
    const existing = this.runtimeEventFactories.get(runId);

    if (existing) {
      return existing;
    }

    const factory = createRuntimeEventFactory({
      runId,
      sessionId: this.sessionId,
      agentId: this.agentId,
      ...(this.now ? { now: this.now } : {}),
    });
    this.runtimeEventFactories.set(runId, factory);
    return factory;
  }

  push(event: TAgentRuntimeOutputEvent, options: IAgentRuntimeRunOptions = {}): void {
    pushUiEvent(this.events, event, options);
  }

  pushRuntimeEvent(
    draft: TAgentRuntimeEventDraft,
    options: IAgentRuntimeRunOptions = {},
    runId = this.requestedRunId,
  ): TAgentRuntimeOutputEvent {
    const event = this.createRuntimeEventFactory(runId)(draft);
    this.push(event, options);
    return event;
  }
}

export const createAgentExecutionSession = (
  options: ICreateAgentExecutionSessionOptions = {},
): AgentExecutionSession => new AgentExecutionSession(options);
