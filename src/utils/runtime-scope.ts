import { createLatestTaskRunner, type LatestTaskRunner } from '@/utils/cancelable-task';
import { createDisposableBag, type Disposable } from '@/utils/disposable';

export type RuntimeScopeState = 'active' | 'disposing' | 'disposed';

export type RuntimeScope = {
  readonly name: string;
  readonly state: RuntimeScopeState;
  readonly disposed: boolean;
  readonly signal: AbortSignal;
  add(disposable: Disposable): () => void;
  cancel(reason?: unknown): void;
  child(name: string): RuntimeScope;
  latestTask(name?: string): LatestTaskRunner;
  setTimeout(callback: () => void, delayMs: number): () => void;
  dispose(): Promise<void>;
};

const createAbortReason = (scopeName: string): DOMException =>
  new DOMException(`Runtime scope "${scopeName}" was disposed`, 'AbortError');

export const createRuntimeScope = (name: string): RuntimeScope => {
  const disposables = createDisposableBag();
  const abortController = new AbortController();
  let state: RuntimeScopeState = 'active';
  let disposePromise: Promise<void> | null = null;

  const cancel = (reason: unknown = createAbortReason(name)): void => {
    if (!abortController.signal.aborted) {
      abortController.abort(reason);
    }
  };

  const scope: RuntimeScope = {
    name,

    get state() {
      return state;
    },

    get disposed() {
      return state === 'disposed';
    },

    get signal() {
      return abortController.signal;
    },

    add(disposable) {
      return disposables.add(disposable);
    },

    cancel,

    child(childName) {
      const childScope = createRuntimeScope(`${name}.${childName}`);
      const abortChild = (): void => {
        childScope.cancel(abortController.signal.reason);
      };

      abortController.signal.addEventListener('abort', abortChild, { once: true });
      childScope.add(() => {
        abortController.signal.removeEventListener('abort', abortChild);
      });
      disposables.add(() => childScope.dispose());

      if (abortController.signal.aborted) {
        abortChild();
      }

      return childScope;
    },

    latestTask() {
      const runner = createLatestTaskRunner();
      disposables.add(() => {
        runner.cancel(createAbortReason(name));
      });
      return runner;
    },

    setTimeout(callback, delayMs) {
      if (state !== 'active') {
        return () => undefined;
      }

      const timerId: ReturnType<typeof globalThis.setTimeout> = globalThis.setTimeout(() => {
        if (!abortController.signal.aborted) {
          callback();
        }
      }, delayMs);

      return disposables.add(() => {
        globalThis.clearTimeout(timerId);
      });
    },

    dispose() {
      if (disposePromise) {
        return disposePromise;
      }

      state = 'disposing';
      cancel();
      disposePromise = disposables.dispose().finally(() => {
        state = 'disposed';
      });
      return disposePromise;
    },
  };

  return scope;
};
