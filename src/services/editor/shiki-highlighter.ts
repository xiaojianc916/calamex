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
 * Shiki 高亮服务（worker-only，方案B 会话化 + 增量编辑）。
 *
 * Worker 持有每个会话(sessionKey)的整篇文档与按块语法状态缓存；主线程按“会话 + 行范围”
 * 请求 token，并在文档变更时只发送行级 delta（edit）。整篇代码仅在会话首次建立或语言变化时
 * 随 reset 发送一次；此后由 edit 增量同步，滚动只发行范围。GrammarState 不跨线程传递。
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
type TEditRequest = {
  type: 'edit';
  sessionKey: number;
  sessionId: number;
  docVersion: number;
  fromLine: number;
  deletedLineCount: number;
  insertedLines: string[];
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
type TDisposeRequest = {
  type: 'dispose';
  sessionKey: number;
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

// 片段（静态代码块）一次性高亮使用递减的负 sessionKey，与编辑器实例的正 sessionKey 互不冲突。
let snippetSessionKeySeq = -1;

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

// 确保 Worker 持有该会话；仅在 worker 实例或语言变化（或尚无会话）时重置。
// 文档版本由 applyShikiEdit 的增量 delta 持续同步，不在此触发重置。
const ensureWorkerSession = (
  worker: Worker,
  sessionKey: number,
  getFullCode: () => string,
  language: string,
  docVersion: number,
): number => {
  const prev = sessionStateByKey.get(sessionKey);
  if (prev && prev.worker === worker && prev.language === language) {
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
 * 增量编辑：文档变更后向 Worker 发送行级 delta（起始行 / 删除行数 / 新增行文本），
 * 使 Worker 原地更新整篇文本并仅作废受影响块的状态缓存。仅当该会话已建立时才发送；
 * 否则忽略——下一次 tokenizeRange 会以当前整篇代码重置，自然包含本次编辑。
 */
export const applyShikiEdit = (
  sessionKey: number,
  docVersion: number,
  fromLine: number,
  deletedLineCount: number,
  insertedLines: string[],
): void => {
  if (shikiWorkerBroken) {
    return;
  }
  const worker = shikiWorker;
  if (!worker) {
    return;
  }
  const prev = sessionStateByKey.get(sessionKey);
  if (!prev || prev.worker !== worker) {
    return;
  }
  prev.docVersion = docVersion;
  const edit: TEditRequest = {
    type: 'edit',
    sessionKey,
    sessionId: prev.sessionId,
    docVersion,
    fromLine,
    deletedLineCount,
    insertedLines,
  };
  worker.postMessage(edit);
};

/** 释放会话：清理主线程会话表并通知 Worker 删除该会话的文档与状态缓存。 */
export const disposeShikiSession = (sessionKey: number): void => {
  sessionStateByKey.delete(sessionKey);
  if (shikiWorkerBroken) {
    return;
  }
  const worker = shikiWorker;
  if (!worker) {
    return;
  }
  const dispose: TDisposeRequest = { type: 'dispose', sessionKey };
  worker.postMessage(dispose);
};

/**
 * 会话化区间高亮：请求 [startLine, endLine]（1-based，含端点）的 token。
 * Worker 不可用/失败/超时返回 null，调用方据此保留现有装饰。
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
 * 片段一次性高亮（供静态代码块 highlightCodeAsync 使用）。
 * 用一个递减的负 sessionKey 建立临时会话、tokenize 整段、随即 dispose，不占用编辑器会话，
 * 也不参与后台预热。
 */
export const tokenizeSnippetWithShikiWorker = async (
  code: string,
  language: string,
): Promise<IShikiThemedToken[][] | null> => {
  if (!resolveShikiLanguageId(language)) {
    return null;
  }
  const sessionKey = snippetSessionKeySeq;
  snippetSessionKeySeq -= 1;
  const lineCount = code.length === 0 ? 1 : code.split('\n').length;
  try {
    return await tokenizeRangeWithShikiWorker(sessionKey, () => code, language, 1, 1, lineCount);
  } finally {
    disposeShikiSession(sessionKey);
  }
};
