/**
 * shfmt 格式化入口。
 *
 * shfmt 是编译为 WASM 的 Go 程序，`format()` 为同步调用、会阻塞所在线程。过去它在主线程
 * 执行：每次「保存时格式化」都会卡住渲染线程，期间 WebView 会把原生窗口底色（纯白）整窗
 * 合成出来，表现为整窗「白屏闪一下」。这里改为在独立 Worker 线程执行，主线程不再被阻塞。
 * Worker 不可用（测试环境 / 不支持 module worker）或超时/崩溃时回退主线程，保证功能可用。
 */

const SHFMT_INDENT = 2;

// Worker 启动 + 首次 WASM 初始化可能较慢；超时后回退主线程，避免保存被卡死。
const SHFMT_WORKER_TIMEOUT_MS = 10_000;

type TShfmtWorkerRequest = {
  id: number;
  source: string;
  path: string;
};

type TShfmtWorkerResponse = {
  id: number;
  result: string | null;
  error?: string;
};

type TShfmtWorkerOutcome =
  | { status: 'formatted'; result: string }
  | { status: 'error'; message: string }
  | { status: 'unavailable' };

let shfmtWorker: Worker | null = null;
let shfmtWorkerBroken = false;
let nextWorkerRequestId = 1;

const getShfmtWorker = (): Worker | null => {
  if (shfmtWorkerBroken || typeof Worker === 'undefined') {
    return null;
  }
  if (!shfmtWorker) {
    try {
      shfmtWorker = new Worker(new URL('./shfmt.worker.ts', import.meta.url), {
        type: 'module',
      });
      shfmtWorker.addEventListener('error', () => {
        shfmtWorkerBroken = true;
        shfmtWorker?.terminate();
        shfmtWorker = null;
      });
    } catch {
      shfmtWorkerBroken = true;
      return null;
    }
  }
  return shfmtWorker;
};

const formatWithWorkerOnly = (source: string, path: string): Promise<TShfmtWorkerOutcome> => {
  const worker = getShfmtWorker();
  if (!worker) {
    return Promise.resolve({ status: 'unavailable' });
  }

  const request: TShfmtWorkerRequest = {
    id: nextWorkerRequestId++,
    source,
    path,
  };

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    const cleanup = (): void => {
      clearTimeout(timeoutId);
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
    };
    const finish = (outcome: TShfmtWorkerOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(outcome);
    };
    const handleMessage = (event: MessageEvent<TShfmtWorkerResponse>): void => {
      if (event.data.id !== request.id) {
        return;
      }
      if (typeof event.data.result === 'string') {
        finish({ status: 'formatted', result: event.data.result });
        return;
      }
      // shfmt 真实报错（通常是脚本语法错误）：透传错误信息，交由调用方处理。
      finish({ status: 'error', message: event.data.error ?? 'shfmt 格式化失败' });
    };
    const handleError = (): void => {
      shfmtWorkerBroken = true;
      shfmtWorker?.terminate();
      shfmtWorker = null;
      finish({ status: 'unavailable' });
    };
    timeoutId = setTimeout(() => {
      finish({ status: 'unavailable' });
    }, SHFMT_WORKER_TIMEOUT_MS);

    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);
    worker.postMessage(request);
  });
};

// 主线程回退路径：仅当 Worker 不可用时使用，行为与旧实现一致。
type TShfmtModule = typeof import('@wasm-fmt/shfmt/vite');
let mainThreadModulePromise: Promise<TShfmtModule> | null = null;

const ensureMainThreadShfmt = (): Promise<TShfmtModule> => {
  if (!mainThreadModulePromise) {
    mainThreadModulePromise = import('@wasm-fmt/shfmt/vite')
      .then(async (mod) => {
        await mod.default();
        return mod;
      })
      .catch((error: unknown) => {
        mainThreadModulePromise = null;
        throw error;
      });
  }
  return mainThreadModulePromise;
};

const formatOnMainThread = async (source: string, path: string): Promise<string> => {
  const mod = await ensureMainThreadShfmt();
  return mod.format(source, path, {
    indent: SHFMT_INDENT,
    simplify: true,
  });
};

export const formatShellScript = async (source: string, path?: string | null): Promise<string> => {
  const resolvedPath = path ?? 'untitled.sh';

  const outcome = await formatWithWorkerOnly(source, resolvedPath);
  if (outcome.status === 'formatted') {
    return outcome.result;
  }
  if (outcome.status === 'error') {
    throw new Error(outcome.message);
  }

  // Worker 不可用 / 超时 / 崩溃：回退主线程，保证功能可用。
  return formatOnMainThread(source, resolvedPath);
};
