import type { TAgentRuntimeEventDraft, TContextCompactionReason } from '../../streaming/stream-types.js';
import type { IAgentRuntimeRunOptions, TAgentRuntimeOutputEvent } from '../contracts/runtime-contracts.js';
import type { TAgentMode } from '../contracts/runtime-input.js';
import { createRuntimeEventFactory, createSessionId, pushUiEvent } from '../utils.js';
import { DEFAULT_EXECUTION_AGENT_ID } from '../types.js';
import { createAgentSessionCompactionMessage, type TAgentSessionMessage } from './session-messages.js';

export interface ICreateAgentExecutionSessionOptions {
  sessionId?: string | undefined;
  runId?: string | undefined;
  agentId?: string | undefined;
  now?: (() => string) | undefined;
}

export type TAgentExecutionTurnStatus = 'running' | 'completed' | 'suspended' | 'failed' | 'cancelled';

export interface IStartAgentExecutionTurnOptions {
  turnId?: string | undefined;
  runId?: string | undefined;
  mode: TAgentMode;
  goal: string;
  modelId?: string | undefined;
  startedAt?: string | undefined;
}

export interface IAgentExecutionTurn {
  readonly id: string;
  readonly runId: string;
  readonly mode: TAgentMode;
  readonly goal: string;
  readonly modelId?: string | undefined;
  readonly startedAt: string;
  readonly status: TAgentExecutionTurnStatus;
  readonly completedAt?: string | undefined;
  readonly result?: string | null | undefined;
  readonly errorMessage?: string | undefined;
}

export interface ICompleteAgentExecutionTurnOptions {
  result?: string | null | undefined;
  completedAt?: string | undefined;
}

export interface IFailAgentExecutionTurnOptions {
  errorMessage: string;
  completedAt?: string | undefined;
}

export interface ISuspendAgentExecutionTurnOptions {
  reason?: string | undefined;
  completedAt?: string | undefined;
}

export type TAgentSessionContextCompactionStatus = 'running' | 'completed';

export interface IAgentSessionContextCompaction {
  readonly id: string;
  readonly status: TAgentSessionContextCompactionStatus;
  readonly reason: TContextCompactionReason;
  readonly summary: string;
  readonly createdAt: string;
  readonly completedAt?: string | undefined;
}

export interface IStartContextCompactionOptions {
  id?: string | undefined;
  reason?: TContextCompactionReason | undefined;
  createdAt?: string | undefined;
}

export interface IAppendContextCompactionDeltaOptions {
  summaryDelta: string;
}

export interface ICompleteContextCompactionOptions {
  summary?: string | undefined;
  completedAt?: string | undefined;
}

export interface IAppendContextCompactionOptions {
  id?: string | undefined;
  reason?: TContextCompactionReason | undefined;
  createdAt?: string | undefined;
  completedAt?: string | undefined;
}

export interface IAgentSessionResourceHandle {
  readonly name: string;
  dispose(): Promise<void> | void;
}

export interface IAgentSessionResourceDisposition {
  readonly name: string;
  readonly ok: boolean;
  readonly errorMessage?: string | undefined;
}

const normalizeResourceDisposeError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

export class AgentSessionResourceScope {
  readonly name: string;

  private readonly handles: IAgentSessionResourceHandle[] = [];

  private disposed = false;

  constructor(name: string) {
    this.name = name;
  }

  add(handle: IAgentSessionResourceHandle): IAgentSessionResourceHandle {
    if (this.disposed) {
      throw new Error(`Resource scope ${this.name} has already been disposed.`);
    }

    this.handles.push(handle);
    return handle;
  }

  get size(): number {
    return this.handles.length;
  }

  async disposeAll(): Promise<IAgentSessionResourceDisposition[]> {
    if (this.disposed) {
      return [];
    }

    this.disposed = true;
    const dispositions: IAgentSessionResourceDisposition[] = [];

    for (const handle of [...this.handles].reverse()) {
      try {
        await handle.dispose();
        dispositions.push({ name: handle.name, ok: true });
      } catch (error) {
        dispositions.push({
          name: handle.name,
          ok: false,
          errorMessage: normalizeResourceDisposeError(error),
        });
      }
    }

    this.handles.length = 0;
    return dispositions;
  }
}

export class AgentExecutionSession {
  readonly sessionId: string;

  readonly requestedRunId: string;

  readonly agentId: string;

  readonly events: TAgentRuntimeOutputEvent[] = [];

  readonly turns: IAgentExecutionTurn[] = [];

  readonly messages: TAgentSessionMessage[] = [];

  readonly contextCompactions: IAgentSessionContextCompaction[] = [];

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

  startTurn(options: IStartAgentExecutionTurnOptions): IAgentExecutionTurn {
    const turn: IAgentExecutionTurn = {
      id: options.turnId ?? createSessionId('mastra-turn'),
      runId: options.runId ?? this.requestedRunId,
      mode: options.mode,
      goal: options.goal,
      ...(options.modelId ? { modelId: options.modelId } : {}),
      startedAt: options.startedAt ?? this.getTimestamp(),
      status: 'running',
    };

    this.turns.push(turn);
    return turn;
  }

  appendMessage(message: TAgentSessionMessage): void {
    this.messages.push(message);
  }

  appendMessages(messages: readonly TAgentSessionMessage[]): void {
    this.messages.push(...messages);
  }

  startContextCompaction(options: IStartContextCompactionOptions = {}): IAgentSessionContextCompaction {
    const compaction: IAgentSessionContextCompaction = {
      id: options.id ?? createSessionId('context-compaction'),
      status: 'running',
      reason: options.reason ?? 'budget',
      summary: '',
      createdAt: options.createdAt ?? this.getTimestamp(),
    };

    this.contextCompactions.push(compaction);
    return compaction;
  }

  appendContextCompactionDelta(
    compactionId: string,
    options: IAppendContextCompactionDeltaOptions,
  ): IAgentSessionContextCompaction | null {
    const current = this.findContextCompaction(compactionId);

    if (!current) {
      return null;
    }

    return this.replaceContextCompaction(compactionId, {
      ...current,
      summary: `${current.summary}${options.summaryDelta}`,
    });
  }

  completeContextCompaction(
    compactionId: string,
    options: ICompleteContextCompactionOptions = {},
  ): IAgentSessionContextCompaction | null {
    const current = this.findContextCompaction(compactionId);

    if (!current) {
      return null;
    }

    const summary = options.summary !== undefined ? options.summary.trim() : current.summary.trim();
    const completed = this.replaceContextCompaction(compactionId, {
      ...current,
      status: 'completed',
      summary,
      completedAt: options.completedAt ?? this.getTimestamp(),
    });

    if (completed && summary.length > 0) {
      this.appendMessage(createAgentSessionCompactionMessage({
        id: completed.id,
        summary,
      }));
    }

    return completed;
  }

  appendContextCompaction(
    summary: string,
    options: IAppendContextCompactionOptions = {},
  ): IAgentSessionContextCompaction {
    const started = this.startContextCompaction({
      id: options.id,
      reason: options.reason,
      createdAt: options.createdAt,
    });
    const completed = this.completeContextCompaction(started.id, {
      summary,
      completedAt: options.completedAt,
    });

    return completed ?? started;
  }

  completeTurn(turnId: string, options: ICompleteAgentExecutionTurnOptions = {}): IAgentExecutionTurn | null {
    return this.updateTurn(turnId, {
      status: 'completed',
      completedAt: options.completedAt ?? this.getTimestamp(),
      result: options.result ?? null,
    });
  }

  suspendTurn(turnId: string, options: ISuspendAgentExecutionTurnOptions = {}): IAgentExecutionTurn | null {
    return this.updateTurn(turnId, {
      status: 'suspended',
      completedAt: options.completedAt ?? this.getTimestamp(),
      ...(options.reason ? { result: options.reason } : {}),
    });
  }

  failTurn(turnId: string, options: IFailAgentExecutionTurnOptions): IAgentExecutionTurn | null {
    return this.updateTurn(turnId, {
      status: 'failed',
      completedAt: options.completedAt ?? this.getTimestamp(),
      errorMessage: options.errorMessage,
    });
  }

  createResourceScope(name: string): AgentSessionResourceScope {
    return new AgentSessionResourceScope(name);
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

  private getTimestamp(): string {
    return this.now ? this.now() : new Date().toISOString();
  }

  private findContextCompaction(compactionId: string): IAgentSessionContextCompaction | null {
    return this.contextCompactions.find((compaction) => compaction.id === compactionId) ?? null;
  }

  private replaceContextCompaction(
    compactionId: string,
    replacement: IAgentSessionContextCompaction,
  ): IAgentSessionContextCompaction | null {
    const compactionIndex = this.contextCompactions.findIndex((compaction) => compaction.id === compactionId);

    if (compactionIndex < 0) {
      return null;
    }

    this.contextCompactions[compactionIndex] = replacement;
    return replacement;
  }

  private updateTurn(
    turnId: string,
    patch: Partial<Pick<IAgentExecutionTurn, 'status' | 'completedAt' | 'result' | 'errorMessage'>>,
  ): IAgentExecutionTurn | null {
    const turnIndex = this.turns.findIndex((turn) => turn.id === turnId);

    if (turnIndex < 0) {
      return null;
    }

    const current = this.turns[turnIndex];

    if (!current) {
      return null;
    }

    const updated: IAgentExecutionTurn = {
      ...current,
      ...patch,
    };
    this.turns[turnIndex] = updated;
    return updated;
  }
}

export const createAgentExecutionSession = (
  options: ICreateAgentExecutionSessionOptions = {},
): AgentExecutionSession => new AgentExecutionSession(options);
