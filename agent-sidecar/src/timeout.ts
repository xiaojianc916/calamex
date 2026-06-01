/**
 * 超时包装工具：把“带超时的 Promise.race”模式收敛到一处。
 *
 * mcp.ts（listTools / disconnect）与 mcp-gateway.ts（tool 调用）此前各自手写了
 * 结构相同的 setTimeout + Promise.race + unref 代码。按两种语义抽成两个函数：
 *   - withTimeout：超时则 reject（用于“必须在时限内拿到结果”的调用）。
 *   - withTimeoutFallback：超时则 resolve 一个兜底值（用于“尽力而为、超时即放弃”
 *     的清理，例如断开连接）。
 *
 * 两者都会 unref 定时器（不阻止进程退出），并在 finally 中 clearTimeout（避免目标
 * Promise 先 settle 后定时器仍挂着）。
 */

/**
 * 在 `ms` 内等待 `promise`；超时则以 `onTimeout()` 返回的错误 reject。
 *
 * `onTimeout` 用惰性工厂而非直接传入 Error，避免每次调用都构造一个最终用不到的
 * Error（连同它的堆栈）。
 */
export const withTimeout = async <T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

/**
 * 在 `ms` 内等待 `promise`；超时则以 `fallback` resolve（不抛错）。
 * 适用于“等不到就放弃”的最佳努力场景。
 */
export const withTimeoutFallback = async <T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};
