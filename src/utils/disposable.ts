export type Disposable = () => void | Promise<void>;

export type DisposableBag = {
  readonly disposed: boolean;
  add(disposable: Disposable): () => void;
  dispose(): Promise<void>;
};

const reportLateDisposeError = (error: unknown): void => {
  globalThis.setTimeout(() => {
    throw error;
  }, 0);
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
        void Promise.resolve().then(disposable).catch(reportLateDisposeError);
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
  };
};
