import { ref } from 'vue';

interface ITauriInternals {
  invoke?: unknown;
}

// Tauri v2 通过 initialization script 在业务脚本之前注入 __TAURI_INTERNALS__，
// 因此桌面端在模块加载时同步检查即可命中；这里只保留极短的兜底等待，
// 浏览器预览模式下会在几帧内快速失败，而不是空转满 2s。
const DEFAULT_RUNTIME_WAIT_MS = 64;

export const desktopRuntimeReady = ref(false);

const resolveTauriInternals = (): ITauriInternals | null =>
  (window as Window & { __TAURI_INTERNALS__?: ITauriInternals }).__TAURI_INTERNALS__ ?? null;

const syncDesktopRuntime = (): boolean => {
  const available = typeof resolveTauriInternals()?.invoke === 'function';
  desktopRuntimeReady.value = available;
  return available;
};

const waitNextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 16);
    }
  });

export const waitForDesktopRuntime = async (
  timeoutMs = DEFAULT_RUNTIME_WAIT_MS,
): Promise<boolean> => {
  if (syncDesktopRuntime()) {
    return true;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await waitNextFrame();
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
