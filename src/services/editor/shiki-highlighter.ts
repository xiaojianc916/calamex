import { logger } from '@/utils/platform/logger';
import { type IShikiThemedToken, resolveShikiLanguageId } from './shiki-shared';

export {
  type IShikiThemedToken,
  resolveShikiLanguageId,
  SHIKI_BACKGROUND,
  SHIKI_FOREGROUND,
  SHIKI_THEME_NAME,
} from './shiki-shared';

/**
 * Shiki 高亮服务（worker-only）。
 *
 * 所有 Shiki/Oniguruma tokenize 一律在独立 Worker 线程执行；主线程不再创建
 * highlighter、不再静态依赖 shiki/core 与 oniguruma 引擎，也不再动态加载任何
 * 语法/wasm/主题——这些只存在于 Worker 模块图里，彻底消除“主线程 + worker 各打
 * 一份 shiki（core/engine/wasm/langs，约数 MB）”的重复打包。
 *
 * 取舍：去掉了主线程同步 tokenize 快路径。已着色（命中按行缓存）的行仍同步重建、
 * 零闪烁；尚未缓存的新行在 Worker 回包前以纯文本渲染约一帧后补色。
 */

const MAX_TOKENIZE_CACHE_ENTRIES = 32;
const MAX_TOKENIZE_CACHE_CODE_LENGTH = 200_000;
const SHIKI_WORKER_TIMEOUT_MS = 4000;

type TShikiWorkerRequest = { id: number; code: string; language: string };
type TShikiWorkerResponse = { id: number; tokens: IShikiThemedToken[][] | null; error?: string };
type TShikiWorkerTokenizeResult =
  | { status: 'tokens'; tokens: IShikiThemedToken[][] }
  | { status: 'unavailable' | 'failed' | 'timeout' };

let shikiWorker: Worker | null = null;
let shikiWorkerBroken = false;
let nextWorkerRequestId = 1;

const tokenizeCache = new Map<string, IShikiThemedToken[][]>();

const tokenCacheKey = (code: string, shikiId: string): string => `${shikiId}\u0000${code}`;

const getCachedTokens = (cacheKey: string): IShikiThemedToken[][] | null => {
  const cached = tokenizeCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  tokenizeCache.delete(cacheKey);
  tokenizeCache.set(cacheKey, cached);
  return cached;
};

const setCachedTokens = (cacheKey: string, tokens: IShikiThemedToken[][]): void => {
  if (tokenizeCache.has(cacheKey)) {
    tokenizeCache.delete(cacheKey);
  }
  while (tokenizeCache.size >= MAX_TOKENIZE_CACHE_ENTRIES) {
    const oldestKey = tokenizeCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    tokenizeCache.delete(oldestKey);
  }
  tokenizeCache.set(cacheKey, tokens);
};

const cacheTokensIfEligible = (
  code: string,
  shikiId: string,
  tokens: IShikiThemedToken[][],
): void => {
  if (code.length <= MAX_TOKENIZE_CACHE_CODE_LENGTH) {
    setCachedTokens(tokenCacheKey(code, shikiId), tokens);
  }
};

const cachedTokensFor = (code: string, shikiId: string): IShikiThemedToken[][] | null => {
  if (code.length > MAX_TOKENIZE_CACHE_CODE_LENGTH) {
    return null;
  }
  return getCachedTokens(tokenCacheKey(code, shikiId));
};

const getShikiWorker = (): Worker | null => {
  if (shikiWorkerBroken || typeof Worker === 'undefined') {
    return null;
  }
  if (!shikiWorker) {
    try {
      shikiWorker = new Worker(new URL('./shiki-tokenizer.worker.ts', import.meta.url), {
        type: 'module',
      });
      shikiWorker.addEventListener('error', (event) => {
        shikiWorkerBroken = true;
        logger.error({ event: 'shiki.worker.error', err: event.message });
        shikiWorker?.terminate();
        shikiWorker = null;
      });
    } catch (error) {
      shikiWorkerBroken = true;
      logger.error({ event: 'shiki.worker.create_failed', err: error });
      return null;
    }
  }
  return shikiWorker;
};

const tokenizeWithWorkerOnly = (
  code: string,
  language: string,
): Promise<TShikiWorkerTokenizeResult> => {
  const worker = getShikiWorker();
  if (!worker) {
    return Promise.resolve({ status: 'unavailable' });
  }

  const request: TShikiWorkerRequest = { id: nextWorkerRequestId++, code, language };

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    const cleanup = (): void => {
      clearTimeout(timeoutId);
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
    };
    const finish = (result: TShikiWorkerTokenizeResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };
    const handleMessage = (event: MessageEvent<TShikiWorkerResponse>): void => {
      if (event.data.id !== request.id) {
        return;
      }
      if (event.data.error || !event.data.tokens) {
        logger.error({
          event: 'shiki.worker.tokenize_failed',
          err: event.data.error ?? 'empty tokens',
          language,
        });
        finish({ status: 'failed' });
        return;
      }
      finish({ status: 'tokens', tokens: event.data.tokens });
    };
    const handleError = (event: ErrorEvent): void => {
      shikiWorkerBroken = true;
      logger.error({ event: 'shiki.worker.runtime_failed', err: event.message });
      shikiWorker?.terminate();
      shikiWorker = null;
      finish({ status: 'failed' });
    };
    timeoutId = setTimeout(() => {
      logger.error({ event: 'shiki.worker.timeout', language });
      finish({ status: 'timeout' });
    }, SHIKI_WORKER_TIMEOUT_MS);

    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);
    worker.postMessage(request);
  });
};

/**
 * Worker 高亮：在独立线程执行 Shiki/Oniguruma tokenize。
 * Worker 不可用 / 失败 / 超时时返回 null，调用方据此保留现有装饰、跳过本轮高亮。
 */
export const tokenizeWithShikiWorker = async (
  code: string,
  language: string,
): Promise<IShikiThemedToken[][] | null> => {
  const shikiId = resolveShikiLanguageId(language);
  if (!shikiId) {
    return null;
  }

  const cached = cachedTokensFor(code, shikiId);
  if (cached) {
    return cached;
  }

  const workerResult = await tokenizeWithWorkerOnly(code, language);
  if (workerResult.status === 'tokens') {
    cacheTokensIfEligible(code, shikiId, workerResult.tokens);
    return workerResult.tokens;
  }
  return null;
};
