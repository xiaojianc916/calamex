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
 * Shiki 高亮服务（worker-only，方案B 会话化）。
 *
 * Worker 持有每个会话(sessionKey)的整篇文档与按块语法状态缓存；主线程按“会话 + 行范围”
 * 请求 token。整篇代码仅在会话首次建立或语言/文档版本变化时随 reset 发送一次，滚动时只发
 * 行范围。GrammarState 不跨线程传递，始终留在 Worker 内。
 */

const SHIKI_WORKER_TIMEOUT_MS = 4000;

type TResetRequest = {
  type: 'reset';
  sessionKey: number;
  sessionId: number;
  docVersion: number;
  language: string;
  code: string;
};
type TTokenizeRangeRequest = {
  type: 'tokenizeRange';
  id: number;
  sessionKey: number;
  sessionId: number;
  docVersion: number;
  startLine: number;
  endLine: number;
};
type TShikiWorkerResponse = {
  id: number;
  sessionKey: number;
  sessionId: number;
  docVersion: number;
  startLine: number;
  endLine: number;
  tokens: IShikiThemedToken[][] | null;
  error?: string;
};

type TWorkerSessionState = {
  worker: Worker;
  sessionId: number;
  language: string;
  docVersion: number;
};

let shikiWorker: Worker | null = null;
let shikiWorkerBroken = false;
let nextWorkerRequestId = 1;
let nextSessionId = 1;
const sessionStateByKey = new Map<number, TWorkerSessionState>();

// 一次性整段高亮固定占用此 sessionKey（负数，与编辑器实例的正数 sessionKey 不冲突）。
const ONE_SHOT_SESSION_KEY = -1;
let oneShotDocVersionSeq = 1;

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
        sessionStateByKey.clear();
      });
    } catch (error) {
      shikiWorkerBroken = true;
      logger.error({ event: 'shiki.worker.create_failed', err: error });
      return null;
    }
  }
  return shikiWorker;
};

// 确保 Worker 持有该会话的最新文档；仅在 worker 实例/语言/文档版本变化时重置（重置才携带整篇代码）。
const ensureWorkerSession = (
  worker: Worker,
  sessionKey: number,
  getFullCode: () => string,
  language: string,
  docVersion: number,
): number => {
  const prev = sessionStateByKey.get(sessionKey);
  if (
    prev &&
    prev.worker === worker &&
    prev.language === language &&
    prev.docVersion === docVersion
  ) {
    return prev.sessionId;
  }
  const sessionId = nextSessionId;
  nextSessionId += 1;
  sessionStateByKey.set(sessionKey, { worker, sessionId, language, docVersion });
  const reset: TResetRequest = {
    type: 'reset',
    sessionKey,
    sessionId,
    docVersion,
    language,
    code: getFullCode(),
  };
  worker.postMessage(reset);
  return sessionId;
};

/**
 * 会话化区间高亮：请求 [startLine, endLine]（1-based，含端点）的 token。
 * Worker 从该范围所在块的边界以真实语法状态续算，跨行结构在任意文件体积下都着色正确。
 * Worker 不可用/失败/超时返回 null，调用方据此保留现有装饰、跳过本轮高亮。
 */
export const tokenizeRangeWithShikiWorker = async (
  sessionKey: number,
  getFullCode: () => string,
  language: string,
  docVersion: number,
  startLine: number,
  endLine: number,
): Promise<IShikiThemedToken[][] | null> => {
  if (!resolveShikiLanguageId(language)) {
    return null;
  }
  const worker = getShikiWorker();
  if (!worker) {
    return null;
  }

  const sessionId = ensureWorkerSession(worker, sessionKey, getFullCode, language, docVersion);
  const id = nextWorkerRequestId;
  nextWorkerRequestId += 1;
  const request: TTokenizeRangeRequest = {
    type: 'tokenizeRange',
    id,
    sessionKey,
    sessionId,
    docVersion,
    startLine,
    endLine,
  };

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    const cleanup = (): void => {
      clearTimeout(timeoutId);
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
    };
    const finish = (tokens: IShikiThemedToken[][] | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(tokens);
    };
    const handleMessage = (event: MessageEvent<TShikiWorkerResponse>): void => {
      if (event.data.id !== id) {
        return;
      }
      if (event.data.error || !event.data.tokens) {
        if (event.data.error) {
          logger.error({
            event: 'shiki.worker.tokenize_failed',
            err: event.data.error,
            language,
          });
        }
        finish(null);
        return;
      }
      finish(event.data.tokens);
    };
    const handleError = (event: ErrorEvent): void => {
      shikiWorkerBroken = true;
      logger.error({ event: 'shiki.worker.runtime_failed', err: event.message });
      shikiWorker?.terminate();
      shikiWorker = null;
      sessionStateByKey.clear();
      finish(null);
    };
    timeoutId = setTimeout(() => {
      logger.error({ event: 'shiki.worker.timeout', language });
      finish(null);
    }, SHIKI_WORKER_TIMEOUT_MS);

    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);
    worker.postMessage(request);
  });
};

/**
 * 一次性整段高亮（兼容旧接口，供静态高亮 highlightCodeAsync 使用）。
 * 用固定的负数 sessionKey + 递增 docVersion，每次都触发重置并整段 tokenize，不占用编辑器会话。
 */
export const tokenizeWithShikiWorker = async (
  code: string,
  language: string,
): Promise<IShikiThemedToken[][] | null> => {
  const lineCount = code.length === 0 ? 1 : code.split('\n').length;
  const docVersion = oneShotDocVersionSeq;
  oneShotDocVersionSeq += 1;
  return tokenizeRangeWithShikiWorker(
    ONE_SHOT_SESSION_KEY,
    () => code,
    language,
    docVersion,
    1,
    lineCount,
  );
};
