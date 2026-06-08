import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import { logger } from '@/utils/logger';
import {
  type IShikiThemedToken,
  resolveShikiLanguageId,
  SHIKI_LANG_LOADERS,
  SHIKI_THEME_NAME,
} from './shiki-shared';

export {
  type IShikiThemedToken,
  resolveShikiLanguageId,
  SHIKI_BACKGROUND,
  SHIKI_FOREGROUND,
  SHIKI_THEME_NAME,
} from './shiki-shared';

/**
 * 专业版 Shiki 高亮服务。
 *
 * 设计要点：
 * - 使用 fine-grained 的 `shiki/core`，主题/语法全部按需动态 import，配合打包器做
 *   代码分割，初始 bundle 不含任何语法。
 * - 正则引擎采用官方 Oniguruma WASM（`shiki/engine/oniguruma` + `shiki/wasm`）。
 *   JS 正则引擎虽然更小，但与 Oniguruma 并非 100% 兼容，Vue/HTML 等重度内嵌
 *   语法会出现大片不高亮；WASM 通过 `import('shiki/wasm')` 动态加载、被 Vite 单独
 *   切 chunk，只在首次高亮时拉一次，不影响初始包体积与按需加载。
 * - 只接入 github-light 一个主题，保持与编辑器整体浅色风格一致。
 * - 语言语法用显式静态 import 字面量声明（而非模板字符串），保证 Vite 能静态分析、
 *   为每个语法生成独立 chunk，真正做到按需加载。
 */

// CodeMirror 调用方已经把单次切片限制在 200 KiB 内；这里再加 LRU 条目上限，避免
// 滚动/布局重复触发同一窗口 tokenize 时反复跑 Oniguruma，同时避免缓存无界增长。
const MAX_TOKENIZE_CACHE_ENTRIES = 32;
const MAX_TOKENIZE_CACHE_CODE_LENGTH = 200_000;
const SHIKI_WORKER_TIMEOUT_MS = 4000;

type TShikiWorkerRequest = {
  id: number;
  code: string;
  language: string;
};

type TShikiWorkerResponse = {
  id: number;
  tokens: IShikiThemedToken[][] | null;
  error?: string;
};

type TShikiWorkerTokenizeResult =
  | { status: 'tokens'; tokens: IShikiThemedToken[][] }
  | { status: 'unavailable' | 'failed' | 'timeout' };

let highlighterPromise: Promise<HighlighterCore> | null = null;
let highlighterInstance: HighlighterCore | null = null;
let shikiWorker: Worker | null = null;
let shikiWorkerBroken = false;
let nextWorkerRequestId = 1;

const loadedLanguages = new Set<string>();
const pendingLanguages = new Map<string, Promise<boolean>>();
const tokenizeCache = new Map<string, IShikiThemedToken[][]>();

/** 创建（或复用）highlighter 单例，仅加载 github-light 主题，语法后续按需注入。 */
export const ensureHighlighter = (): Promise<HighlighterCore> => {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [import('@shikijs/themes/github-light')],
      langs: [],
      engine: createOnigurumaEngine(import('shiki/wasm')),
    })
      .then((highlighter) => {
        highlighterInstance = highlighter;
        return highlighter;
      })
      .catch((error) => {
        // 初始化失败不能缓存被拒绝的 Promise，否则后续所有高亮调用都会拿到
        // 同一个失败结果、整会话高亮永久失效；置空以便下次调用重新尝试创建。
        highlighterPromise = null;
        logger.error({ event: 'shiki.highlighter.init_failed', err: error });
        throw error;
      });
  }
  return highlighterPromise;
};

/** 指定语言对应的语法是否已加载（用于同步高亮判定）。 */
export const isShikiLanguageLoaded = (language: string): boolean => {
  const shikiId = resolveShikiLanguageId(language);
  return shikiId !== null && loadedLanguages.has(shikiId);
};

/** 按需加载语言语法；返回最终可用的 Shiki 语言 id（失败或不支持时返回 null）。 */
export const ensureShikiLanguage = async (language: string): Promise<string | null> => {
  const shikiId = resolveShikiLanguageId(language);
  if (!shikiId) {
    return null;
  }
  if (loadedLanguages.has(shikiId)) {
    return shikiId;
  }

  let pending = pendingLanguages.get(shikiId);
  if (!pending) {
    const loader = SHIKI_LANG_LOADERS[shikiId];
    if (!loader) {
      return null;
    }
    pending = (async () => {
      try {
        const highlighter = await ensureHighlighter();
        const mod = (await loader()) as { default?: unknown };
        await highlighter.loadLanguage((mod.default ?? mod) as never);
        loadedLanguages.add(shikiId);
        return true;
      } catch (error) {
        logger.error({ event: 'shiki.language.load_failed', err: error, language });
        return false;
      } finally {
        pendingLanguages.delete(shikiId);
      }
    })();
    pendingLanguages.set(shikiId, pending);
  }

  const loaded = await pending;
  return loaded ? shikiId : null;
};

const tokenCacheKey = (code: string, shikiId: string): string => `${shikiId}\u0000${code}`;

const getCachedTokens = (cacheKey: string): IShikiThemedToken[][] | null => {
  const cached = tokenizeCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  // Map 删除后重插入即可维护 LRU 最近访问顺序。
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

const tokenize = (
  highlighter: HighlighterCore,
  code: string,
  shikiId: string,
): IShikiThemedToken[][] | null => {
  const cached = cachedTokensFor(code, shikiId);
  if (cached) {
    return cached;
  }

  try {
    const tokens = highlighter.codeToTokensBase(code, {
      lang: shikiId,
      theme: SHIKI_THEME_NAME,
    }) as unknown as IShikiThemedToken[][];
    cacheTokensIfEligible(code, shikiId, tokens);
    return tokens;
  } catch (error) {
    logger.error({ event: 'shiki.tokenize_failed', err: error, shikiId });
    return null;
  }
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

  const request: TShikiWorkerRequest = {
    id: nextWorkerRequestId++,
    code,
    language,
  };

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

/** 同步高亮：仅当语法已加载时返回 token 行，否则返回 null。 */
export const tokenizeWithShikiSync = (
  code: string,
  language: string,
): IShikiThemedToken[][] | null => {
  const shikiId = resolveShikiLanguageId(language);
  if (!shikiId) {
    return null;
  }

  const cached = cachedTokensFor(code, shikiId);
  if (cached) {
    return cached;
  }

  if (!highlighterInstance || !loadedLanguages.has(shikiId)) {
    return null;
  }
  return tokenize(highlighterInstance, code, shikiId);
};

/**
 * Worker 优先高亮：将 Shiki/Oniguruma tokenize 放到独立线程执行。
 * Worker 不可用或运行失败时回退到主线程异步路径，保证功能可用；单次 Worker 超时则
 * 直接放弃本轮高亮，避免把疑似重任务重新搬回 UI 线程造成卡顿。
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
  if (workerResult.status === 'timeout') {
    return null;
  }

  // Worker 不可用或运行失败时才退回主线程。这里仍走异步入口，避免调用方关心 fallback 细节。
  return tokenizeWithShiki(code, language);
};

/** 异步高亮：按需加载语法后再 tokenize。 */
export const tokenizeWithShiki = async (
  code: string,
  language: string,
): Promise<IShikiThemedToken[][] | null> => {
  const shikiId = await ensureShikiLanguage(language);
  if (!shikiId) {
    return null;
  }
  const highlighter = await ensureHighlighter();
  return tokenize(highlighter, code, shikiId);
};
