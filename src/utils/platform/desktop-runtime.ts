import { ref } from 'vue';

interface ITauriInternals {
  invoke?: unknown;
}

const RUNTIME_POLL_INTERVAL_MS = 40;
const DEFAULT_RUNTIME_WAIT_MS = 2000;

export const desktopRuntimeReady = ref(false);

const resolveTauriInternals = (): ITauriInternals | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  return (window as Window & { __TAURI_INTERNALS__?: ITauriInternals }).__TAURI_INTERNALS__ ?? null;
};

const syncDesktopRuntime = (): boolean => {
  const available = typeof resolveTauriInternals()?.invoke === 'function';
  desktopRuntimeReady.value = available;
  return available;
};

const sleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });

export const waitForDesktopRuntime = async (
  timeoutMs = DEFAULT_RUNTIME_WAIT_MS,
): Promise<boolean> => {
  if (typeof window === 'undefined') {
    desktopRuntimeReady.value = false;
    return false;
  }

  if (syncDesktopRuntime()) {
    return true;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(RUNTIME_POLL_INTERVAL_MS);
    if (syncDesktopRuntime()) {
      return true;
    }
  }

  return syncDesktopRuntime();
};

export const assertDesktopRuntime = async (scene: string): Promise<void> => {
  const ready = await waitForDesktopRuntime();
  if (!ready) {
    throw new Error(
      `当前为浏览器预览模式，${scene}仅支持 Tauri 桌面端。请执行 npm run tauri:dev 后重试。`,
    );
  }
};

syncDesktopRuntime();
