export type AsyncTask<T> = () => Promise<T>;

export type Sequencer = {
  readonly pending: Promise<void>;
  queue<T>(task: AsyncTask<T>): Promise<T>;
};

export type RunOnceScheduler = {
  readonly disposed: boolean;
  readonly delayMs: number;
  schedule(delayMs?: number): void;
  cancel(): void;
  flush(): void;
  isScheduled(): boolean;
  dispose(): void;
};

/**
 * Minimal async sequencer adapted from VS Code's Sequencer.
 *
 * It guarantees that queued async tasks run one after another. A rejected task does not
 * poison the chain, so later lifecycle operations can still run.
 */
export const createSequencer = (): Sequencer => {
  let current: Promise<void> = Promise.resolve();

  return {
    get pending() {
      return current;
    },

    queue<T>(task: AsyncTask<T>) {
      const next = current.then(task, task);
      current = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
};

/**
 * Minimal RunOnceScheduler adapted from VS Code's RunOnceScheduler.
 *
 * Repeated schedule() calls cancel the previous pending run and schedule exactly one
 * future run. The scheduler can also be cancelled, flushed, or disposed.
 */
export const createRunOnceScheduler = (runner: () => void, defaultDelayMs: number): RunOnceScheduler => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let activeRunner: (() => void) | null = runner;

  const cancel = (): void => {
    if (timeoutId === null) {
      return;
    }

    clearTimeout(timeoutId);
    timeoutId = null;
  };

  const run = (): void => {
    activeRunner?.();
  };

  const onTimeout = (): void => {
    timeoutId = null;
    run();
  };

  return {
    get disposed() {
      return disposed;
    },

    get delayMs() {
      return defaultDelayMs;
    },

    schedule(delayMs = defaultDelayMs) {
      if (disposed) {
        return;
      }

      cancel();
      timeoutId = setTimeout(onTimeout, delayMs);
    },

    cancel,

    flush() {
      if (timeoutId === null || disposed) {
        return;
      }

      cancel();
      run();
    },

    isScheduled() {
      return timeoutId !== null;
    },

    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      cancel();
      activeRunner = null;
    },
  };
};
