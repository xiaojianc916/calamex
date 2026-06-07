export type LatestTaskResult<T> =
  | { status: 'completed'; value: T }
  | { status: 'canceled' };

export type LatestTaskRunner = {
  readonly signal: AbortSignal | null;
  run<T>(task: (signal: AbortSignal) => Promise<T>): Promise<LatestTaskResult<T>>;
  cancel(reason?: unknown): void;
};

const isAbortError = (error: unknown): boolean => {
  if (error instanceof DOMException) {
    return error.name === 'AbortError';
  }

  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as { name?: unknown };
  return candidate.name === 'AbortError';
};

export const createLatestTaskRunner = (): LatestTaskRunner => {
  let sequence = 0;
  let controller: AbortController | null = null;

  const isCurrent = (taskSequence: number, signal: AbortSignal): boolean =>
    taskSequence === sequence && !signal.aborted;

  return {
    get signal() {
      return controller?.signal ?? null;
    },

    async run<T>(task: (signal: AbortSignal) => Promise<T>): Promise<LatestTaskResult<T>> {
      sequence += 1;
      const taskSequence = sequence;

      controller?.abort();
      const taskController = new AbortController();
      controller = taskController;
      const { signal } = taskController;

      try {
        const value = await task(signal);
        if (!isCurrent(taskSequence, signal)) {
          return { status: 'canceled' };
        }
        return { status: 'completed', value };
      } catch (error) {
        if (!isCurrent(taskSequence, signal) || isAbortError(error)) {
          return { status: 'canceled' };
        }
        throw error;
      } finally {
        if (taskSequence === sequence) {
          controller = null;
        }
      }
    },

    cancel(reason?: unknown) {
      sequence += 1;
      controller?.abort(reason);
      controller = null;
    },
  };
};
