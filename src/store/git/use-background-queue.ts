/**
 * 通用后台任务队列（从 git store 的 commit-stats 队列抽取）。
 *
 * 职责：在空闲时段（requestIdleCallback，不可用时退化为 setTimeout）批量消费入队 id，
 * 并提供：同一 id 去重、进行中去重、可选跳过条件、单项失败隔离（记日志不中断队列）。
 *
 * 不承担任何业务语义：“是否已有结果”、“如何处理单项”由调用方通过 shouldSkip / process 注入，
 * 便于在不同域（如 PR 预热、commit-stats）复用同一调度机制。
 */

type TBackgroundQueueTimer =
  | { kind: 'idle'; id: ReturnType<typeof requestIdleCallback> }
  | { kind: 'timeout'; id: ReturnType<typeof setTimeout> };

export interface IBackgroundQueueOptions {
  /** 处理单个 id 的异步任务；抛错会被捕获并记日志，不中断后续项。 */
  process: (id: string) => Promise<void>;
  /** 可选跳过条件（如已有结果）：入队与出队时均会检查。 */
  shouldSkip?: (id: string) => boolean;
  /** 调度延迟（ms）；idle 路径下作为 requestIdleCallback 的 timeout 上限基准。 */
  delayMs: number;
  /** 单项处理失败时的日志事件名。 */
  failureLogEvent: string;
  /** 失败日志通道（仅需 warn）。 */
  logger: { warn: (payload: Record<string, unknown>) => void };
}

export interface IBackgroundQueue {
  /** 入队一个 id（空字符串 / shouldSkip 命中 / 进行中会被忽略）。 */
  enqueue: (id: string) => void;
  /** 清空队列与进行中集合，并取消待执行的调度。 */
  clear: () => void;
}

export const useBackgroundQueue = (options: IBackgroundQueueOptions): IBackgroundQueue => {
  const queued = new Set<string>();
  const pending = new Set<string>();
  let timer: TBackgroundQueueTimer | null = null;
  let isRunning = false;

  const clearTimer = (): void => {
    if (timer === null) return;
    if (
      timer.kind === 'idle' &&
      typeof window !== 'undefined' &&
      typeof window.cancelIdleCallback === 'function'
    ) {
      window.cancelIdleCallback(timer.id);
    } else if (timer.kind === 'timeout') {
      clearTimeout(timer.id);
    }
    timer = null;
  };

  const drain = async (): Promise<void> => {
    if (isRunning) return;

    isRunning = true;
    try {
      while (queued.size > 0) {
        const id = queued.values().next().value;
        if (!id) break;

        queued.delete(id);

        if (options.shouldSkip?.(id) || pending.has(id)) {
          continue;
        }

        pending.add(id);
        try {
          await options.process(id);
        } catch (error) {
          options.logger.warn({ event: options.failureLogEvent, err: error });
        } finally {
          pending.delete(id);
        }
      }
    } finally {
      isRunning = false;
    }
  };

  const schedule = (): void => {
    if (timer !== null || isRunning) return;

    const run = (): void => {
      timer = null;
      void drain();
    };

    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      // requestIdleCallback 的 timeout 参数保证回调最终一定执行，无需额外 setTimeout fallback；
      // 不支持 cancelIdleCallback 的环境（旧 WebView2）退化为 no-op。
      timer = {
        kind: 'idle',
        id: window.requestIdleCallback(run, { timeout: options.delayMs * 4 }),
      };
      return;
    }

    timer = { kind: 'timeout', id: setTimeout(run, options.delayMs) };
  };

  const enqueue = (id: string): void => {
    if (!id || options.shouldSkip?.(id) || pending.has(id)) return;
    queued.add(id);
    schedule();
  };

  const clear = (): void => {
    clearTimer();
    queued.clear();
    pending.clear();
    isRunning = false;
  };

  return { enqueue, clear };
};
