import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { z } from 'zod';

import { commands } from '@/bindings/tauri';
import type {
  ITerminalDataEvent,
  ITerminalExitEvent,
  ITerminalRunCompletedPayload,
  ITerminalRunStartedPayload,
  ITerminalSessionStateChangedPayload,
} from '@/types/terminal';

// ---------------------------------------------------------------------------
// Event names
// ---------------------------------------------------------------------------

const TERMINAL_DATA_EVENT = 'terminal:data';
const TERMINAL_RUN_STARTED_EVENT = 'terminal:run-started';
const TERMINAL_RUN_COMPLETED_EVENT = 'terminal:run-completed';
const TERMINAL_INTERACTIVE_READY_EVENT = 'terminal:interactive-ready';
const TERMINAL_INTERACTIVE_EXITED_EVENT = 'terminal:interactive-exited';
const TERMINAL_SESSION_STATE_CHANGED_EVENT = 'terminal:session-state-changed';

// ---------------------------------------------------------------------------
// Flow control (ack 背压)
// ---------------------------------------------------------------------------

/**
 * 前端每消费这么多字符(UTF-16 码元)回一次 ack。必须与后端 `flow_control.rs` 的
 * `CHAR_COUNT_ACK_SIZE` 同值,两侧用同一把尺子加减。对照 VSCode
 * `FlowControlConstants.CharCountAckSize`(`src/vs/platform/terminal/common/terminalProcess.ts`)。
 */
export const CHAR_COUNT_ACK_SIZE = 5000;

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

/**
 * 向后端回报「已消费 charCount 个字符」的 ack 函数。抽成可注入依赖,便于测试断言,
 * 生产环境默认走生成的 `acknowledge_terminal_data` 命令。
 */
export type TTerminalAcknowledge = (sessionId: string, charCount: number) => void;

export interface ITerminalEventBus {
  start(): Promise<void>;
  stop(): void;
  onTerminalData(handler: TEventHandler<ITerminalDataEvent>): UnlistenFn;
  onRunStarted(handler: TEventHandler<ITerminalRunStartedPayload>): UnlistenFn;
  onRunCompleted(handler: TEventHandler<ITerminalRunCompletedPayload>): UnlistenFn;
  onInteractiveReady(handler: TEventHandler<void>): UnlistenFn;
  onInteractiveExited(handler: TEventHandler<ITerminalExitEvent>): UnlistenFn;
  onSessionStateChanged(handler: TEventHandler<ITerminalSessionStateChangedPayload>): UnlistenFn;
}

/**
 * 默认 ack 实现:即发即弃地调用后端命令。ack 失败不应中断事件分发——最坏只是少一次
 * 背压解除,由后端防御性暂停上限兜底;会话已关闭时后端为安全 no-op。
 */
const defaultAcknowledge: TTerminalAcknowledge = (sessionId, charCount) => {
  void commands.acknowledgeTerminalData(sessionId, charCount).catch((error: unknown) => {
    console.warn('[terminal-event] ack 回报失败,已忽略', error);
  });
};

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

export const createTerminalEventBus = (
  listenFn: TTerminalListen = listen,
  acknowledge: TTerminalAcknowledge = defaultAcknowledge,
): ITerminalEventBus => {
  const terminalDataHandlers = new Set<TEventHandler<ITerminalDataEvent>>();
  const runStartedHandlers = new Set<TEventHandler<ITerminalRunStartedPayload>>();
  const runCompletedHandlers = new Set<TEventHandler<ITerminalRunCompletedPayload>>();
  const interactiveReadyHandlers = new Set<TEventHandler<void>>();
  const interactiveExitedHandlers = new Set<TEventHandler<ITerminalExitEvent>>();
  const sessionStateChangedHandlers = new Set<TEventHandler<ITerminalSessionStateChangedPayload>>();

  /**
   * 每会话「已收到但尚未回报」的字符数(UTF-16 码元)。仅在本单例总线的唯一 IPC 监听里
   * 累计,保证每条 terminal:data 只计一次——即便多个 facade / 多窗口共享同一总线,也不会
   * 重复 ack(重复 ack 会让后端 unacked 提前归零、背压形同虚设)。
   */
  const unackedCharsBySession = new Map<string, number>();

  /**
   * 累计并在跨过阈值时回报 ack。无论是否有 data handler 订阅都会执行:数据已离开后端
   * (读线程已 record_produced),只有回报「已收到」才能让被背压暂停的读线程恢复;若因
   * 无订阅者而不 ack,后端 unacked 会单调累积直至永久暂停。
   */
  const accumulateAndAck = (event: ITerminalDataEvent): void => {
    const pending = (unackedCharsBySession.get(event.sessionId) ?? 0) + event.data.length;
    if (pending >= CHAR_COUNT_ACK_SIZE) {
      unackedCharsBySession.set(event.sessionId, 0);
      acknowledge(event.sessionId, pending);
    } else {
      unackedCharsBySession.set(event.sessionId, pending);
    }
  };

  // 内部清理:会话交互退出后丢弃其 ack 累计,避免 map 长期增长。注册在工厂创建时,随单例
  // 存活、不对外暴露;未达阈值的残余无需补 ack(会话关闭后端会一并移除其流控器)。
  interactiveExitedHandlers.add((payload) => {
    unackedCharsBySession.delete(payload.sessionId);
  });

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

  /**
   * terminal:data 专用监听:解包校验 + 分发后,额外做 ack 累计。ack 不依赖订阅者存在,
   * 见 accumulateAndAck 说明。
   */
  const wireTerminalDataListener = (): Promise<UnlistenFn> =>
    listenFn<unknown>(TERMINAL_DATA_EVENT, ({ payload }) => {
      const parsed = terminalDataEventSchema.safeParse(payload);
      if (!parsed.success) {
        console.warn(
          `[terminal-event] ${TERMINAL_DATA_EVENT} payload 校验失败`,
          z.treeifyError(parsed.error),
        );
        return;
      }
      emitToHandlers(terminalDataHandlers, parsed.data);
      accumulateAndAck(parsed.data);
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
        wireTerminalDataListener(),
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
