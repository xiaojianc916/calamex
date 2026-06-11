import initShfmt, { format } from '@wasm-fmt/shfmt/vite';

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

let shfmtReadyPromise: Promise<unknown> | null = null;

const ensureShfmtReady = (): Promise<unknown> => {
  if (!shfmtReadyPromise) {
    // 初始化失败不缓存被拒 Promise，否则后续所有格式化都会拿到同一个失败结果；置空以便重试。
    shfmtReadyPromise = initShfmt().catch((error: unknown) => {
      shfmtReadyPromise = null;
      throw error;
    });
  }
  return shfmtReadyPromise;
};

const workerSelf = self as unknown as {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<TShfmtWorkerRequest>) => void,
  ): void;
  postMessage(message: TShfmtWorkerResponse): void;
};

workerSelf.addEventListener('message', (event) => {
  const { id, source, path } = event.data;
  void ensureShfmtReady()
    .then(() => {
      const result = format(source, path, {
        indent: 2,
        simplify: true,
      });
      workerSelf.postMessage({ id, result });
    })
    .catch((error: unknown) => {
      workerSelf.postMessage({
        id,
        result: null,
        error: error instanceof Error ? error.message : String(error),
      });
    });
});
