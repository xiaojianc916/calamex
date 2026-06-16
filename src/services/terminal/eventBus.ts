import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { z } from 'zod';

import type {
  ITerminalDataEvent,
  ITerminalExitEvent,
  ITerminalRunChunkPayload,
  ITerminalRunCompletedPayload,
  ITerminalRunStartedPayload,
  ITerminalSessionStateChangedPayload,
  ITerminalStateChangedPayload,
} from '@/types/terminal';

// ---------------------------------------------------------------------------
// Event names
// ---------------------------------------------------------------------------

const TERMINAL_DATA_EVENT = 'terminal:data';
const TERMINAL_RUN_CHUNK_EVENT = 'terminal:run-chunk';
const TERMINAL_RUN_STARTED_EVENT = 'terminal:run-started';
const TERMINAL_RUN_COMPLETED_EVENT = 'terminal:run-completed';
const TERMINAL_INTERACTIVE_READY_EVENT = 'terminal:interactive-ready';
const TERMINAL_INTERACTIVE_EXITED_EVENT = 'terminal:interactive-exited';
const TERMINAL_STATE_CHANGED_EVENT = 'terminal:state-changed';
const TERMINAL_SESSION_STATE_CHANGED_EVENT = 'terminal:session-state-changed';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const terminalDataEventSchema = z.object({
  sessionId: z.string(),
  data: z.string(),
  source: z.enum(['interactive', 'run', 'injected_reset', 'injected_separator']).optional(),
  seq: z.number().int().nonnegative().optional(),
  runId: z.string().optional(),
  runSeq: z.number().int().positive().optional(),
});

const terminalRunChunkEventSchema = z.object({
  sessionId: z.string(),
  runId: z.string(),
  data: z.string(),
  seq: z.number().int().nonnegative().optional(),
});

const terminalRunCompletedEventSchema = z.object({
  sessionId: z.string(),
  runId: z.string(),
  exitCode: z.number().int().nullable(),
  finishedAt: z.string(),
});

const terminalRunStartedEventSchema = z.object({
  sessionId: z.string(),
  runId: z.string(),
  startedAtMs: z.number().int().nonnegative(),
  pid: z.number().int().nonnegative(),
});

const terminalRuntimeStateSchema = z.enum([
  'booting',
  'idle_interactive',
  'switching_to_run',
  'running',
  'switching_to_idle',
]);

const terminalStateChangedEventSchema = z.object({
  from: terminalRuntimeStateSchema,
  to: terminalRuntimeStateSchema,
  atMs: z.number().int().nonnegative(),
});

const terminalSessionStateChangedEventSchema = z.object({
  sessionId: z.string(),
  from: terminalRuntimeStateSchema,
  to: terminalRuntimeStateSchema,
  atMs: z.number().int().nonnegative(),
});

const terminalExitEventSchema = z.object({
  sessionId: z.string(),
  exitCode: z.number().int().nullable(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TEventHandler<TPayload> = (payload: TPayload) => void;

export type TTerminalListen = typeof listen;

export interface ITerminalEventBus {
  start(): Promise<void>;
  stop(): void;
  onTerminalData(handler: TEventHandler<ITerminalDataEvent>): UnlistenFn;
  onRunChunk(handler: TEventHandler<ITerminalRunChunkPayload>): UnlistenFn;
  onRunStarted(handler: TEventHandler<ITerminalRunStartedPayload>): UnlistenFn;
  onRunCompleted(handler: TEventHandler<ITerminalRunCompletedPayload>): UnlistenFn;
  onInteractiveReady(handler: TEventHandler<void>): UnlistenFn;
  onInteractiveExited(handler: TEventHandler<ITerminalExitEvent>): UnlistenFn;
  onStateChanged(handler: TEventHandler<ITerminalStateChangedPayload>): UnlistenFn;
  onSessionStateChanged(
    handler: TEventHandler<ITerminalSessionStateChangedPayload>,
  ): UnlistenFn;
}

// ---------------------------------------------------------------------------
// Bus factory
// ---------------------------------------------------------------------------

const removeHandler = <TPayload>(
  handlers: Set<TEventHandler<TPayload>>,
  handler: TEventHandler<TPayload>,
): void => {
  handlers.delete(handler);
};

/**
 * 把 payload 分发到所有订阅者。**单个 handler 抛错不会中断对其他 handler
 * 的分发**——事件总线的契约是订阅者互相隔离。
 */
const emitToHandlers = <TPayload>(
  handlers: Set<TEventHandler<TPayload>>,
  payload: TPayload,
): void => {
  for (const handler of handlers) {
    try {
      handler(payload);
    } catch (error) {
      console.error('[terminal-event] handler 抛错,已隔离', error);
    }
  }
};

export const createTerminalEventBus = (listenFn: TTerminalListen = listen): ITerminalEventBus => {
  const terminalDataHandlers = new Set<TEventHandler<ITerminalDataEvent>>();
  const runChunkHandlers = new Set<TEventHandler<ITerminalRunChunkPayload>>();
  const runStartedHandlers = new Set<TEventHandler<ITerminalRunStartedPayload>>();
  const runCompletedHandlers = new Set<TEventHandler<ITerminalRunCompletedPayload>>();
  const interactiveReadyHandlers = new Set<TEventHandler<void>>();
  const interactiveExitedHandlers = new Set<TEventHandler<ITerminalExitEvent>>();
  const stateChangedHandlers = new Set<TEventHandler<ITerminalStateChangedPayload>>();
  const sessionStateChangedHandlers = new Set<
    TEventHandler<ITerminalSessionStateChangedPayload>
  >();

  let unlisteners: UnlistenFn[] = [];
  let startPromise: Promise<void> | null = null;
  /**
   * Start epoch token——每次 start/stop 都递增。Promise.allSettled 完成时
   * 校验自己的 epoch 是否仍是当前 epoch;若不是 (期间被 stop 或重启),立即
   * 把已注册的 listener 撤掉,避免泄漏到后端。
   */
  let startEpoch = 0;

  const parseAndEmit = <TPayload>(
    eventName: string,
    schema: z.ZodType<TPayload>,
    handlers: Set<TEventHandler<TPayload>>,
    payload: unknown,
  ): void => {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      console.warn(`[terminal-event] ${eventName} payload 校验失败`, z.treeifyError(parsed.error));
      return;
    }
    emitToHandlers(handlers, parsed.data);
  };

  /** 包一层 listenFn,把"解包 payload + parseAndEmit"集中到一处。 */
  const wireListener = <TPayload>(
    eventName: string,
    schema: z.ZodType<TPayload>,
    handlers: Set<TEventHandler<TPayload>>,
  ): Promise<UnlistenFn> =>
    listenFn<unknown>(eventName, ({ payload }) => {
      parseAndEmit(eventName, schema, handlers, payload);
    });

  /** 无 payload 的事件 (当前仅 interactive-ready)。 */
  const wireValuelessListener = (
    eventName: string,
    handlers: Set<TEventHandler<void>>,
  ): Promise<UnlistenFn> =>
    listenFn<unknown>(eventName, () => {
      emitToHandlers(handlers, undefined);
    });

  const start = (): Promise<void> => {
    if (unlisteners.length > 0) {
      return Promise.resolve();
    }
    if (startPromise) {
      return startPromise;
    }

    const epoch = ++startEpoch;

    startPromise = (async () => {
      const settled = await Promise.allSettled([
        wireListener(TERMINAL_DATA_EVENT, terminalDataEventSchema, terminalDataHandlers),
        wireListener(TERMINAL_RUN_CHUNK_EVENT, terminalRunChunkEventSchema, runChunkHandlers),
        wireListener(TERMINAL_RUN_STARTED_EVENT, terminalRunStartedEventSchema, runStartedHandlers),
        wireListener(
          TERMINAL_RUN_COMPLETED_EVENT,
          terminalRunCompletedEventSchema,
          runCompletedHandlers,
        ),
        wireValuelessListener(TERMINAL_INTERACTIVE_READY_EVENT, interactiveReadyHandlers),
        wireListener(
          TERMINAL_INTERACTIVE_EXITED_EVENT,
          terminalExitEventSchema,
          interactiveExitedHandlers,
        ),
        wireListener(
          TERMINAL_STATE_CHANGED_EVENT,
          terminalStateChangedEventSchema,
          stateChangedHandlers,
        ),
        wireListener(
          TERMINAL_SESSION_STATE_CHANGED_EVENT,
          terminalSessionStateChangedEventSchema,
          sessionStateChangedHandlers,
        ),
      ]);

      const succeeded: UnlistenFn[] = [];
      const failures: unknown[] = [];
      for (const result of settled) {
        if (result.status === 'fulfilled') {
          succeeded.push(result.value);
        } else {
          failures.push(result.reason);
        }
      }

      // 在 IPC 飞行期间发生了 stop() 或重启 (R1):撤掉已注册的监听,丢掉这一批。
      if (epoch !== startEpoch) {
        for (const fn of succeeded) {
          try {
            fn();
          } catch (error) {
            console.warn('[terminal-event] stale unlisten 调用失败', error);
          }
        }
        return;
      }

      // 部分失败 (R2):已成功的也要撤掉,不能让它们泄漏到后端。
      if (failures.length > 0) {
        for (const fn of succeeded) {
          try {
            fn();
          } catch (error) {
            console.warn('[terminal-event] partial-failure unlisten 调用失败', error);
          }
        }
        throw new AggregateError(
          failures,
          `terminal listener setup partially failed (${failures.length}/${settled.length})`,
        );
      }

      unlisteners = succeeded;
    })().finally(() => {
      startPromise = null;
    });

    return startPromise;
  };

  const stop = (): void => {
    // 递增 epoch,使任何 in-flight start() 在 settle 后认到自己已 stale。
    startEpoch++;
    for (const unlisten of unlisteners) {
      try {
        unlisten();
      } catch (error) {
        console.warn('[terminal-event] unlisten 调用失败', error);
      }
    }
    unlisteners = [];
    // 注意:不主动把 startPromise 置 null——它有自己的 finally 钩子负责清理,
    // 提前置 null 会破坏 in-flight start() 调用方的等待语义。
  };

  return {
    start,
    stop,
    onTerminalData(handler) {
      terminalDataHandlers.add(handler);
      return () => removeHandler(terminalDataHandlers, handler);
    },
    onRunChunk(handler) {
      runChunkHandlers.add(handler);
      return () => removeHandler(runChunkHandlers, handler);
    },
    onRunStarted(handler) {
      runStartedHandlers.add(handler);
      return () => removeHandler(runStartedHandlers, handler);
    },
    onRunCompleted(handler) {
      runCompletedHandlers.add(handler);
      return () => removeHandler(runCompletedHandlers, handler);
    },
    onInteractiveReady(handler) {
      interactiveReadyHandlers.add(handler);
      return () => removeHandler(interactiveReadyHandlers, handler);
    },
    onInteractiveExited(handler) {
      interactiveExitedHandlers.add(handler);
      return () => removeHandler(interactiveExitedHandlers, handler);
    },
    onStateChanged(handler) {
      stateChangedHandlers.add(handler);
      return () => removeHandler(stateChangedHandlers, handler);
    },
    onSessionStateChanged(handler) {
      sessionStateChangedHandlers.add(handler);
      return () => removeHandler(sessionStateChangedHandlers, handler);
    },
  };
};

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let terminalEventBusSingleton: ITerminalEventBus | null = null;

export const getTerminalEventBus = (): ITerminalEventBus => {
  if (!terminalEventBusSingleton) {
    terminalEventBusSingleton = createTerminalEventBus();
  }
  return terminalEventBusSingleton;
};

/**
 * 仅用于测试 / 重新初始化场景。会 stop 当前单例并丢弃。**生产代码不要调用。**
 */
export const __resetTerminalEventBusForTesting = (): void => {
  if (terminalEventBusSingleton) {
    terminalEventBusSingleton.stop();
    terminalEventBusSingleton = null;
  }
};
