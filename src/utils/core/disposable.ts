export type Disposable = () => void | Promise<void>;

export type DisposableBag = AsyncDisposable & {
  readonly disposed: boolean;
  add(disposable: Disposable): () => void;
  dispose(): Promise<void>;
};

export type MutableDisposable = AsyncDisposable & {
  readonly disposed: boolean;
  readonly value: Disposable | null;
  set(disposable: Disposable | null): void;
  clear(): void;
  clearAndLeak(): Disposable | null;
  dispose(): Promise<void>;
};

const reportLateDisposeError = (error: unknown): void => {
  globalThis.setTimeout(() => {
    throw error;
  }, 0);
};

const disposeInBackground = (disposable: Disposable): void => {
  void Promise.resolve().then(disposable).catch(reportLateDisposeError);
};

export const createDisposableBag = (): DisposableBag => {
  const disposables: Disposable[] = [];
  let disposed = false;

  const remove = (disposable: Disposable): void => {
    const index = disposables.lastIndexOf(disposable);
    if (index >= 0) {
      disposables.splice(index, 1);
    }
  };

  return {
    get disposed() {
      return disposed;
    },

    add(disposable: Disposable) {
      if (disposed) {
        disposeInBackground(disposable);
        return () => undefined;
      }

      disposables.push(disposable);
      let active = true;

      return () => {
        if (!active) {
          return;
        }
        active = false;
        remove(disposable);
      };
    },

    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;

      const errors: unknown[] = [];
      const pending = disposables.splice(0).reverse();

      for (const disposable of pending) {
        try {
          await disposable();
        } catch (error) {
          errors.push(error);
        }
      }

      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, 'Failed to dispose runtime resources');
      }
    },

    [Symbol.asyncDispose]() {
      return this.dispose();
    },
  };
};

export const createMutableDisposable = (): MutableDisposable => {
  let value: Disposable | null = null;
  let disposed = false;

  const set = (nextValue: Disposable | null): void => {
    if (disposed) {
      if (nextValue) {
        disposeInBackground(nextValue);
      }
      return;
    }

    if (nextValue === value) {
      return;
    }

    const previousValue = value;
    value = nextValue;

    if (previousValue) {
      disposeInBackground(previousValue);
    }
  };

  return {
    get disposed() {
      return disposed;
    },

    get value() {
      return disposed ? null : value;
    },

    set,

    clear() {
      set(null);
    },

    clearAndLeak() {
      const leaked = value;
      value = null;
      return leaked;
    },

    async dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      const disposable = value;
      value = null;
      if (disposable) {
        await disposable();
      }
    },

    [Symbol.asyncDispose]() {
      return this.dispose();
    },
  };
};
