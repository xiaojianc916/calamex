/**
 * SidecarAgent — CopilotKit AbstractAgent implementation that bridges
 * AG-UI protocol to our existing Mastra sidecar via Tauri IPC.
 *
 * This allows CopilotKit's frontend hooks (useAgent, useFrontendTool, etc.)
 * to drive the Mastra agent engine without a separate CopilotKit runtime.
 *
 * Key invariants:
 * - Each call to `run()` gets its own isolated state (event adapter, session
 *   buffer, cleanup handle). The agent instance is safe to reuse across runs.
 * - Stream events received before the session id is known are buffered and
 *   replayed once `sidecarChat` resolves, then filtered by session id.
 * - The Observable always terminates exactly once with either `complete()`
 *   or `error()`, including on abort.
 */
import type { AgentConfig, BaseEvent, RunAgentInput } from '@ag-ui/client';
import { AbstractAgent } from '@ag-ui/client';
import type { AgentCapabilities } from '@ag-ui/core';
import { Observable, type Subscriber } from 'rxjs';

import {
  createRunErrorEvent,
  createRunStartedEvent,
  createSidecarEventAdapter,
  createTextMessageEndEvent,
  createTextMessageStartEvent,
  defaultIdGenerator,
  type ISidecarEventAdapter,
  toSidecarChatRequest,
} from '@/copilotkit/event-adapter';
import { aiService } from '@/services/ipc/ai.service';
import type { IAgentSidecarStreamEventPayload } from '@/types/ai/sidecar';
import { logger } from '@/utils/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_AGENT_ID = 'mastra-sidecar';
const DEFAULT_DESCRIPTION = 'Mastra-powered coding agent with plan/execute workflow';

// ---------------------------------------------------------------------------
// Internal per-run context
// ---------------------------------------------------------------------------
interface IRunContext {
  /** True until the Observable has been terminated (complete or error). */
  isActive: boolean;
  /** True once terminal events have been emitted; guards against double-finish. */
  finished: boolean;
  /** Per-run event adapter (isolated tool-call id map, seq, etc.). */
  adapter: ISidecarEventAdapter;
  /** AG-UI run / thread identifiers. */
  base: { runId: string; threadId: string };
  /** ID for the assistant text message we frame the run with. */
  messageId: string;
  /**
   * Sidecar session id, available only after `sidecarChat` resolves. Until
   * then, stream events are buffered (see `pendingStreamEvents`).
   */
  activeSessionId: string | null;
  /** Stream events received before `activeSessionId` is known. */
  pendingStreamEvents: IAgentSidecarStreamEventPayload[];
  /** Unlisten handle for the stream subscription, if registered. */
  streamUnlisten: (() => void) | null;
  /** Resolves once stream subscription has been attempted (success or failure). */
  streamReady: Promise<void>;
  /** True once cleanup has released resources (idempotency guard). */
  released: boolean;
}

// ---------------------------------------------------------------------------
// SidecarAgent
// ---------------------------------------------------------------------------
export class SidecarAgent extends AbstractAgent {
  /**
   * Set of cleanup callbacks for currently-active runs. Each run registers
   * its own cleanup; `abortRun` iterates and clears.
   */
  private readonly activeCleanups = new Set<() => void>();

  constructor(config?: AgentConfig) {
    super({
      agentId: config?.agentId ?? DEFAULT_AGENT_ID,
      description: config?.description ?? DEFAULT_DESCRIPTION,
      threadId: config?.threadId ?? defaultIdGenerator('thread'),
      initialMessages: config?.initialMessages,
      initialState: config?.initialState,
      debug: config?.debug,
    });
  }

  // -------------------------------------------------------------------------
  // AbstractAgent required implementation
  // -------------------------------------------------------------------------
  override run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const ctx: IRunContext = {
        isActive: true,
        finished: false,
        adapter: createSidecarEventAdapter(),
        base: {
          runId: input.runId ?? defaultIdGenerator('run'),
          threadId: input.threadId ?? this.threadId,
        },
        messageId: defaultIdGenerator('msg'),
        activeSessionId: null,
        pendingStreamEvents: [],
        streamUnlisten: null,
        streamReady: Promise.resolve(),
        released: false,
      };

      // ── Emit RUN_STARTED + TEXT_MESSAGE_START synchronously ──────────────
      subscriber.next(createRunStartedEvent(ctx.base));
      subscriber.next(createTextMessageStartEvent(ctx.base, ctx.messageId));

      // ── Subscribe to sidecar stream FIRST (best-effort ordering) ─────────
      ctx.streamReady = aiService
        .onSidecarStream((payload) => this.handleStreamPayload(payload, ctx, subscriber))
        .then((unlisten) => {
          if (!ctx.isActive) {
            // Run was aborted before subscription completed — drop it immediately.
            unlisten();
            return;
          }
          ctx.streamUnlisten = unlisten;
        })
        .catch((err) => {
          logger.warn({ event: 'copilotkit.sidecar_stream_subscribe_failed', err });
        });

      // ── Send chat request once subscription has been attempted ───────────
      // Awaiting `streamReady` here closes the "early events lost" race that
      // existed in the previous implementation.
      ctx.streamReady
        .then(() => {
          if (!ctx.isActive) return undefined;
          return aiService.sidecarChat({
            ...toSidecarChatRequest(input),
            threadId: ctx.base.threadId,
          });
        })
        .then((response) => {
          if (!response || !ctx.isActive) return;

          ctx.activeSessionId = response.sessionId;

          // Replay any events that arrived before we knew the session id.
          const buffered = ctx.pendingStreamEvents;
          ctx.pendingStreamEvents = [];
          for (const payload of buffered) {
            if (!ctx.isActive) break;
            if (payload.sessionId === ctx.activeSessionId) {
              this.handleStreamPayload(payload, ctx, subscriber);
            }
          }

          // Process any non-streaming events embedded in the response body.
          for (const uiEvent of response.events) {
            if (!ctx.isActive) break;
            const aguiEvents = ctx.adapter.convert(
              uiEvent as unknown as { type: string; [k: string]: unknown },
              ctx.base,
              ctx.messageId,
            );
            for (const evt of aguiEvents) {
              if (!ctx.isActive) break;
              subscriber.next(evt);
            }
          }

          // Some responses arrive complete in one shot — finish if so.
          if (ctx.isActive && response.result !== undefined) {
            this.finishRun(ctx, subscriber, response.result);
          }
        })
        .catch((err: unknown) => {
          if (!ctx.isActive) return;
          const message = err instanceof Error ? err.message : 'Sidecar request failed';
          logger.warn({ event: 'copilotkit.sidecar_chat_failed', err });
          this.failRun(ctx, subscriber, message);
        });

      // ── Cleanup ──────────────────────────────────────────────────────────
      const cleanup = (): void => {
        if (ctx.released) return;
        ctx.released = true;
        ctx.isActive = false;

        // Torn down before reaching a terminal state (e.g. abortRun): honour the
        // "always terminates exactly once" invariant. These emissions are no-ops
        // if the subscriber is already closed (consumer-initiated unsubscribe).
        if (!ctx.finished) {
          ctx.finished = true;
          subscriber.next(createTextMessageEndEvent(ctx.base, ctx.messageId));
          subscriber.next(createRunErrorEvent(ctx.base, 'Run aborted'));
          subscriber.complete();
        }

        // Unlisten now if we already have the handle.
        if (ctx.streamUnlisten) {
          try {
            ctx.streamUnlisten();
          } catch (err) {
            logger.warn({ event: 'copilotkit.sidecar_unlisten_failed', err });
          }
          ctx.streamUnlisten = null;
        }

        // Otherwise, wait for subscription to land and then unlisten.
        // We snapshot the field rather than closing over `ctx.streamUnlisten`
        // because the field may be cleared by the time the promise resolves.
        ctx.streamReady
          .then(() => {
            if (ctx.streamUnlisten) {
              try {
                ctx.streamUnlisten();
              } catch {
                // best-effort
              }
              ctx.streamUnlisten = null;
            }
          })
          .catch(() => {
            // already logged above
          });
      };

      this.activeCleanups.add(cleanup);

      return () => {
        this.activeCleanups.delete(cleanup);
        cleanup();
      };
    });
  }

  // -------------------------------------------------------------------------
  // Internal: stream payload handling
  // -------------------------------------------------------------------------
  private handleStreamPayload(
    payload: IAgentSidecarStreamEventPayload,
    ctx: IRunContext,
    subscriber: Subscriber<BaseEvent>,
  ): void {
    if (!ctx.isActive) return;

    // Until we know our session id, buffer everything and decide on replay.
    if (ctx.activeSessionId === null) {
      ctx.pendingStreamEvents.push(payload);
      return;
    }

    // Drop events from other sessions.
    if (payload.sessionId !== ctx.activeSessionId) return;

    const aguiEvents = ctx.adapter.convert(
      payload.event as unknown as { type: string; [k: string]: unknown },
      ctx.base,
      ctx.messageId,
    );
    for (const evt of aguiEvents) {
      if (!ctx.isActive) break;
      subscriber.next(evt);
    }

    // Sidecar's own terminal markers — finish exactly once.
    if (payload.event.type === 'done') {
      const doneEvent = payload.event as { type: 'done'; result?: string };
      this.finishRun(ctx, subscriber, doneEvent.result ?? null);
    } else if (payload.event.type === 'error') {
      const errEvent = payload.event as { type: 'error'; message: string };
      this.failRun(ctx, subscriber, errEvent.message);
    }
  }

  // -------------------------------------------------------------------------
  // Internal: terminal emission (single-fire)
  // -------------------------------------------------------------------------
  private finishRun(
    ctx: IRunContext,
    subscriber: Subscriber<BaseEvent>,
    result: string | null,
  ): void {
    if (ctx.finished) return;
    ctx.finished = true;
    ctx.isActive = false;

    for (const evt of ctx.adapter.terminal(ctx.base, ctx.messageId, result)) {
      subscriber.next(evt);
    }
    subscriber.complete();
  }

  private failRun(ctx: IRunContext, subscriber: Subscriber<BaseEvent>, message: string): void {
    if (ctx.finished) return;
    ctx.finished = true;
    ctx.isActive = false;

    // Close the text message frame so downstream parsers don't hang on it.
    subscriber.next(createTextMessageEndEvent(ctx.base, ctx.messageId));
    subscriber.next(createRunErrorEvent(ctx.base, message) as BaseEvent);
    subscriber.complete();
  }

  // -------------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------------
  override getCapabilities(): Promise<AgentCapabilities> {
    // Static for now; wrap in Promise to satisfy the AbstractAgent contract.
    return Promise.resolve({
      streaming: true,
      state: { snapshots: true },
      tools: { supported: true },
      reasoning: { streaming: true },
      humanInTheLoop: { supported: true },
    } as AgentCapabilities);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  override clone(): SidecarAgent {
    // Structured clone for messages and state so the new instance is fully
    // isolated. Falls back to JSON clone if structuredClone is unavailable.
    const cloneDeep = <T>(v: T): T => {
      if (typeof structuredClone === 'function') {
        try {
          return structuredClone(v);
        } catch {
          // fallthrough
        }
      }
      return JSON.parse(JSON.stringify(v)) as T;
    };

    return new SidecarAgent({
      agentId: this.agentId,
      description: this.description,
      threadId: this.threadId,
      initialMessages: cloneDeep([...this.messages]),
      initialState: cloneDeep({ ...this.state }),
    });
  }

  override abortRun(): void {
    // Tear down every in-flight run. Each cleanup handles its own
    // Observable termination (RUN_ERROR + complete) via the subscriber it
    // captured. We snapshot first to avoid mutation during iteration.
    const cleanups = [...this.activeCleanups];
    this.activeCleanups.clear();
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (err) {
        logger.warn({ event: 'copilotkit.sidecar_abort_cleanup_failed', err });
      }
    }
    super.abortRun();
  }
}
