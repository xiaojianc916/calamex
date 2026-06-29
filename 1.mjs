#!/usr/bin/env node
/**
 * 方案B 增强：会话协议(reset/edit增量/tokenizeRange/dispose) + Worker 后台预热。
 * 对齐 microsoft/vscode 的 MirrorTextModel(增量同步) 与 DefaultBackgroundTokenizer(分片背景分词)。
 * 无新旧并存、无兼容层。需 Shiki ≥ 1.16。在已应用「方案B + lint 修复」的代码上运行。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const E = (p) => resolve(process.cwd(), p);
const WORKER = E('src/services/editor/shiki-tokenizer.worker.ts');
const HILITE = E('src/services/editor/shiki-highlighter.ts');
const PLUGIN = E('src/services/editor/codemirror-shiki-highlight.ts');
const STATIC = E('src/services/editor/codemirror-static-highlight.ts');
for (const f of [WORKER, HILITE, PLUGIN, STATIC]) {
  if (!existsSync(f)) { console.error('✗ 请在 calamex 仓库根目录运行。缺失: ' + f); process.exit(1); }
}
const backupOnce = (file) => { const b = file + '.b2.bak'; if (!existsSync(b)) writeFileSync(b, readFileSync(file)); };
const writeFull = (file, marker, content) => {
  if (readFileSync(file, 'utf8').includes(marker)) { console.log('· 跳过(已是增强版): ' + file); return; }
  backupOnce(file); writeFileSync(file, content); console.log('✓ 重写: ' + file);
};
const patch = (file, label, oldStr, newStr, sentinel) => {
  let src = readFileSync(file, 'utf8');
  if (src.includes(sentinel)) { console.log('· 跳过(已应用): ' + label); return; }
  const i = src.indexOf(oldStr);
  if (i === -1) throw new Error('锚点未找到: ' + label);
  if (src.indexOf(oldStr, i + oldStr.length) !== -1) throw new Error('锚点不唯一: ' + label);
  backupOnce(file);
  writeFileSync(file, src.slice(0, i) + newStr + src.slice(i + oldStr.length));
  console.log('✓ 补丁: ' + label);
};
const remove = (file, label, oldStr) => {
  let src = readFileSync(file, 'utf8');
  const i = src.indexOf(oldStr);
  if (i === -1) { console.log('· 跳过(已移除): ' + label); return; }
  if (src.indexOf(oldStr, i + oldStr.length) !== -1) throw new Error('待移除文本不唯一: ' + label);
  backupOnce(file);
  writeFileSync(file, src.slice(0, i) + src.slice(i + oldStr.length));
  console.log('✓ 移除: ' + label);
};

// ════════════════════ ① Worker 全量重写 ════════════════════
const WORKER_SRC = `import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import { bundledLanguages } from 'shiki/langs';
import { type IShikiThemedToken, resolveShikiLanguageId, SHIKI_THEME_NAME } from './shiki-shared';

/**
 * 方案B 增强：会话 + 增量编辑 + 后台预热 的有状态、按块语法状态接续 tokenize Worker。
 *
 * 对照 microsoft/vscode：MirrorTextModel 用增量(edit)同步文档而非每次重传整篇；
 * DefaultBackgroundTokenizer 在空闲时间分片地从首个失效块向后推进，把每块“末态”
 * (GrammarState) 算出并缓存，使深处视口可从最近块边界以真实语法状态续算——始终精确、零近似。
 * 配合 shiki @shikijs/primitive 的 codeToTokensBase({ grammarState }) / getLastGrammarState。
 * GrammarState 是带链式父引用与方法的不透明对象，无法跨线程，故整篇文档与每块末态全部留在
 * Worker：主线程只发“会话 + 行范围”，文档变更只发行级增量。
 *
 * 协议：reset(整篇,仅初始化/语言切换/重同步) · edit(行级覆盖增量) · tokenizeRange(视口) · dispose。
 * 需要 Shiki ≥ 1.16（grammarState / getLastGrammarState API）。
 */

const BLOCK_LINES = 512;
const MAX_SESSIONS = 16;
const BG_SLICE_MS = 15;

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
type TShikiWorkerRequest = TResetRequest | TEditRequest | TTokenizeRangeRequest | TDisposeRequest;

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

type TCodeToTokensBaseOptions = { lang: string; theme: string; grammarState?: unknown };

type TSession = {
  sessionKey: number;
  sessionId: number;
  docVersion: number;
  language: string;
  shikiId: string | null;
  resolved: boolean;
  resolving: boolean;
  lines: string[];
  blockEndState: Map<number, unknown>;
  bgCursor: number;
};

let highlighterPromise: Promise<HighlighterCore> | null = null;
let highlighterInstance: HighlighterCore | null = null;
const loadedLanguages = new Set<string>();
const pendingLanguages = new Map<string, Promise<boolean>>();
const sessions = new Map<number, TSession>();

const ensureHighlighter = (): Promise<HighlighterCore> => {
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
        highlighterPromise = null;
        throw error;
      });
  }
  return highlighterPromise;
};

const ensureLanguage = async (language: string): Promise<string | null> => {
  const shikiId = resolveShikiLanguageId(language);
  if (!shikiId) {
    return null;
  }
  if (loadedLanguages.has(shikiId)) {
    return shikiId;
  }

  let pending = pendingLanguages.get(shikiId);
  if (!pending) {
    const loader = bundledLanguages[shikiId as keyof typeof bundledLanguages];
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
      } finally {
        pendingLanguages.delete(shikiId);
      }
    })();
    pendingLanguages.set(shikiId, pending);
  }

  return (await pending) ? shikiId : null;
};

// 用给定起始语法状态 tokenize 一段代码，返回 token 与该段结束处的语法状态。
const tokenizeBlockCode = (
  highlighter: HighlighterCore,
  shikiId: string,
  code: string,
  startState: unknown,
): { tokens: IShikiThemedToken[][]; endState: unknown } => {
  const options: TCodeToTokensBaseOptions = { lang: shikiId, theme: SHIKI_THEME_NAME };
  if (startState) {
    options.grammarState = startState;
  }
  const tokens = highlighter.codeToTokensBase(
    code,
    options as Parameters<HighlighterCore['codeToTokensBase']>[1],
  ) as unknown as IShikiThemedToken[][];
  const getLastGrammarState = (
    highlighter as unknown as { getLastGrammarState?: (value: unknown) => unknown }
  ).getLastGrammarState;
  const endState =
    typeof getLastGrammarState === 'function'
      ? (getLastGrammarState.call(highlighter, tokens) ?? null)
      : null;
  return { tokens, endState };
};

// 计算并缓存 blockIndex 结束处的语法状态（含其之前所有块）；blockIndex < 0 => INITIAL(null)。
const ensureBlockEndState = (
  highlighter: HighlighterCore,
  session: TSession,
  shikiId: string,
  blockIndex: number,
): unknown => {
  if (blockIndex < 0) {
    return null;
  }
  const cached = session.blockEndState.get(blockIndex);
  if (cached !== undefined) {
    return cached;
  }
  let prevState: unknown = null;
  for (let b = 0; b <= blockIndex; b += 1) {
    const existing = session.blockEndState.get(b);
    if (existing !== undefined) {
      prevState = existing;
      continue;
    }
    const fromLine = b * BLOCK_LINES;
    const blockCode = session.lines.slice(fromLine, fromLine + BLOCK_LINES).join('\\n');
    const { endState } = tokenizeBlockCode(highlighter, shikiId, blockCode, prevState);
    session.blockEndState.set(b, endState);
    prevState = endState;
  }
  return session.blockEndState.get(blockIndex) ?? null;
};

// 后台预热：空闲分片把每块末态从首个失效块算到尾并缓存，使深处视口请求变快且始终精确。
let bgScheduled = false;
const scheduleBackground = (): void => {
  if (bgScheduled) {
    return;
  }
  bgScheduled = true;
  setTimeout(runBackground, 0);
};

const runBackground = (): void => {
  bgScheduled = false;
  const highlighter = highlighterInstance;
  if (!highlighter) {
    return;
  }
  const startedAt = Date.now();
  for (const session of sessions.values()) {
    const shikiId = session.shikiId;
    if (!session.resolved || !shikiId) {
      continue;
    }
    const totalBlocks = Math.ceil(session.lines.length / BLOCK_LINES);
    while (session.bgCursor < totalBlocks && Date.now() - startedAt < BG_SLICE_MS) {
      if (session.blockEndState.has(session.bgCursor)) {
        session.bgCursor += 1;
        continue;
      }
      const b = session.bgCursor;
      const prevState = b === 0 ? null : (session.blockEndState.get(b - 1) ?? null);
      const fromLine = b * BLOCK_LINES;
      const blockCode = session.lines.slice(fromLine, fromLine + BLOCK_LINES).join('\\n');
      try {
        const { endState } = tokenizeBlockCode(highlighter, shikiId, blockCode, prevState);
        session.blockEndState.set(b, endState);
        session.bgCursor += 1;
      } catch {
        session.bgCursor = totalBlocks;
      }
    }
    if (Date.now() - startedAt >= BG_SLICE_MS) {
      break;
    }
  }
  for (const session of sessions.values()) {
    const totalBlocks = Math.ceil(session.lines.length / BLOCK_LINES);
    if (session.resolved && session.shikiId && session.bgCursor < totalBlocks) {
      scheduleBackground();
      return;
    }
  }
};

// 异步解析会话语言并启动后台预热（reset / edit 后调用；幂等）。
const resolveSession = (session: TSession): void => {
  if (session.resolved || session.resolving) {
    if (session.resolved) {
      scheduleBackground();
    }
    return;
  }
  session.resolving = true;
  void (async () => {
    try {
      const shikiId = await ensureLanguage(session.language);
      if (shikiId) {
        await ensureHighlighter();
      }
      if (sessions.get(session.sessionKey) !== session) {
        return;
      }
      session.shikiId = shikiId;
      session.resolved = true;
      scheduleBackground();
    } finally {
      session.resolving = false;
    }
  })();
};

const tokenizeRange = async (req: TTokenizeRangeRequest): Promise<IShikiThemedToken[][] | null> => {
  const session = sessions.get(req.sessionKey);
  if (!session || session.sessionId !== req.sessionId || session.docVersion !== req.docVersion) {
    return null;
  }
  if (!session.resolved) {
    session.shikiId = await ensureLanguage(session.language);
    session.resolved = true;
  }
  const shikiId = session.shikiId;
  if (!shikiId) {
    return null;
  }
  // 语言加载是异步的，期间该会话可能已被更新的版本替换；重校验，避免用旧文档着色。
  if (sessions.get(req.sessionKey) !== session || session.docVersion !== req.docVersion) {
    return null;
  }
  const totalLines = session.lines.length;
  if (totalLines === 0) {
    return null;
  }
  const highlighter = await ensureHighlighter();
  const startLine = Math.max(1, req.startLine);
  const endLine = Math.min(totalLines, Math.max(startLine, req.endLine));
  if (startLine > totalLines) {
    return null;
  }
  const startBlock = Math.floor((startLine - 1) / BLOCK_LINES);
  const blockStartLine = startBlock * BLOCK_LINES + 1;
  const startState = ensureBlockEndState(highlighter, session, shikiId, startBlock - 1);
  const code = session.lines.slice(blockStartLine - 1, endLine).join('\\n');
  const { tokens } = tokenizeBlockCode(highlighter, shikiId, code, startState);
  const offset = startLine - blockStartLine;
  const count = endLine - startLine + 1;
  return tokens.slice(offset, offset + count);
};

const workerSelf = self as unknown as {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<TShikiWorkerRequest>) => void,
  ): void;
  postMessage(message: TShikiWorkerResponse): void;
};

workerSelf.addEventListener('message', (event) => {
  const data = event.data;
  if (data.type === 'reset') {
    const session: TSession = {
      sessionKey: data.sessionKey,
      sessionId: data.sessionId,
      docVersion: data.docVersion,
      language: data.language,
      shikiId: null,
      resolved: false,
      resolving: false,
      lines: data.code.split('\\n'),
      blockEndState: new Map(),
      bgCursor: 0,
    };
    sessions.set(data.sessionKey, session);
    // 仅淘汰多余的一次性快照会话（负 key），绝不淘汰编辑器实例会话（正 key）。
    if (sessions.size > MAX_SESSIONS) {
      for (const key of sessions.keys()) {
        if (key < 0 && key !== data.sessionKey) {
          sessions.delete(key);
          if (sessions.size <= MAX_SESSIONS) {
            break;
          }
        }
      }
    }
    resolveSession(session);
    return;
  }

  if (data.type === 'edit') {
    const session = sessions.get(data.sessionKey);
    if (!session || session.sessionId !== data.sessionId) {
      return;
    }
    session.lines.splice(data.fromLine - 1, data.deletedLineCount, ...data.insertedLines);
    session.docVersion = data.docVersion;
    const editedBlock = Math.floor((data.fromLine - 1) / BLOCK_LINES);
    for (const b of [...session.blockEndState.keys()]) {
      if (b >= editedBlock) {
        session.blockEndState.delete(b);
      }
    }
    if (session.bgCursor > editedBlock) {
      session.bgCursor = editedBlock;
    }
    resolveSession(session);
    scheduleBackground();
    return;
  }

  if (data.type === 'dispose') {
    sessions.delete(data.sessionKey);
    return;
  }

  const req = data;
  void tokenizeRange(req)
    .then((tokens) => {
      workerSelf.postMessage({
        id: req.id,
        sessionKey: req.sessionKey,
        sessionId: req.sessionId,
        docVersion: req.docVersion,
        startLine: req.startLine,
        endLine: req.endLine,
        tokens,
      });
    })
    .catch((error: unknown) => {
      workerSelf.postMessage({
        id: req.id,
        sessionKey: req.sessionKey,
        sessionId: req.sessionId,
        docVersion: req.docVersion,
        startLine: req.startLine,
        endLine: req.endLine,
        tokens: null,
        error: error instanceof Error ? error.message : String(error),
      });
    });
});
`;

// ════════════════════ ② highlighter 全量重写 ════════════════════
const HILITE_SRC = `import { logger } from '@/utils/platform/logger';
import { type IShikiThemedToken, resolveShikiLanguageId } from './shiki-shared';

export {
  type IShikiThemedToken,
  resolveShikiLanguageId,
  SHIKI_BACKGROUND,
  SHIKI_FOREGROUND,
  SHIKI_THEME_NAME,
} from './shiki-shared';

/**
 * Shiki 高亮服务（worker-only，方案B 会话化 + 增量同步）。
 *
 * Worker 持有每个会话(sessionKey)的整篇文档与按块语法状态缓存；主线程按“会话 + 行范围”请求
 * token。整篇代码仅在会话首次建立 / 语言切换 / 丢包重同步时随 reset 发送一次；之后文档变更通过
 * applyShikiEdit 以行级增量(edit)同步，滚动只发行范围。GrammarState 不跨线程，始终留在 Worker。
 * 会话结束用 disposeShikiSession 通知 Worker 释放。静态片段用 tokenizeSnippetWithShikiWorker
 * （独立负数 sessionKey，用完即释放，不与编辑器会话串话）。
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

// 静态片段一次性高亮使用递减的负数 sessionKey，与编辑器实例的正数 sessionKey 不冲突，用完即弃。
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

// 确保 Worker 持有该会话的最新文档；仅在 worker 实例/语言/文档版本变化时重置（重置才携带整篇代码）。
// 正常编辑流由 applyShikiEdit 把 docVersion 与 Worker 同步推进，故此处不会触发 reset；
// 仅当增量丢失(docVersion 漂移)/语言切换/worker 重建时才整篇 reset 重同步，保证最终一致。
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
 * Worker 从该范围所在块边界以真实语法状态续算，跨行结构在任意文件体积下都着色正确。
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
 * 文档行级增量同步：把 [fromLine, fromLine+deletedLineCount) 替换为 insertedLines。
 * Worker 据此原地 splice 文档并失效受影响块及其后续块的语法状态(后台重新预热)，避免重传整篇。
 * 仅在会话已建立且 Worker 健在时发送；否则跳过——下次 tokenizeRange 会因 docVersion 不一致触发
 * 整篇 reset 重同步，保证最终一致。
 */
export const applyShikiEdit = (
  sessionKey: number,
  docVersion: number,
  fromLine: number,
  deletedLineCount: number,
  insertedLines: string[],
): void => {
  const worker = shikiWorker;
  const state = sessionStateByKey.get(sessionKey);
  if (!worker || shikiWorkerBroken || !state || state.worker !== worker) {
    return;
  }
  const edit: TEditRequest = {
    type: 'edit',
    sessionKey,
    sessionId: state.sessionId,
    docVersion,
    fromLine,
    deletedLineCount,
    insertedLines,
  };
  worker.postMessage(edit);
  state.docVersion = docVersion;
};

/** 释放会话：删除主线程会话记录并通知 Worker 丢弃其文档与状态缓存。 */
export const disposeShikiSession = (sessionKey: number): void => {
  const state = sessionStateByKey.get(sessionKey);
  sessionStateByKey.delete(sessionKey);
  const worker = shikiWorker;
  if (worker && !shikiWorkerBroken && state && state.worker === worker) {
    const dispose: TDisposeRequest = { type: 'dispose', sessionKey };
    worker.postMessage(dispose);
  }
};

/**
 * 一次性整段高亮（供静态高亮 highlightCodeAsync 使用）：分配独立负数 sessionKey 建立临时会话，
 * 整段 tokenize 后立即释放，不占用编辑器会话，亦不与之串话。
 */
export const tokenizeSnippetWithShikiWorker = async (
  code: string,
  language: string,
): Promise<IShikiThemedToken[][] | null> => {
  if (!resolveShikiLanguageId(language)) {
    return null;
  }
  const lineCount = code.length === 0 ? 1 : code.split('\\n').length;
  const sessionKey = snippetSessionKeySeq;
  snippetSessionKeySeq -= 1;
  const tokens = await tokenizeRangeWithShikiWorker(
    sessionKey,
    () => code,
    language,
    0,
    1,
    lineCount,
  );
  disposeShikiSession(sessionKey);
  return tokens;
};
`;

writeFull(WORKER, '方案B 增强：会话 + 增量编辑 + 后台预热', WORKER_SRC);
writeFull(HILITE, 'applyShikiEdit', HILITE_SRC);

// ════════════════════ ③ 静态高亮：改用 snippet 接口 ════════════════════
patch(STATIC, 'S1 import 改名', `  tokenizeWithShikiWorker,`, `  tokenizeSnippetWithShikiWorker,`, `tokenizeSnippetWithShikiWorker,`);
patch(STATIC, 'S2 调用改名', `  const lines = await tokenizeWithShikiWorker(code, language);`, `  const lines = await tokenizeSnippetWithShikiWorker(code, language);`, `tokenizeSnippetWithShikiWorker(code`);

// ════════════════════ ④ 主插件补丁 ════════════════════
patch(PLUGIN, 'P1 import 增量/释放接口',
`import { tokenizeRangeWithShikiWorker } from '@/services/editor/shiki-highlighter';`,
`import {
  applyShikiEdit,
  disposeShikiSession,
  tokenizeRangeWithShikiWorker,
} from '@/services/editor/shiki-highlighter';`,
`applyShikiEdit,`);

remove(PLUGIN, 'P2 删除三个切片常量',
`// 单次 tokenize 切片的字节上限：Worker 路径默认从文档开头切到可见区下沿，超过
// 此上限时退化为仅切可见区窗口；窗口切片仍超限（极端长行，如压缩成一行的文件）
// 则放弃高亮，避免 Worker 任务过重。注意这是“切片”上限而非“整文档”上限。
const MAX_HIGHLIGHT_SLICE_LENGTH = 200_000;

// 「从文档首行起」切片的舒适体积上限：超过即降级为有界窗口切片（仅取视口附近），避免向大
// 文件深处滚动时在主线程 sliceString 出超大前缀并结构化克隆给 Worker。低于
// MAX_HIGHLIGHT_SLICE_LENGTH（后者仍作为窗口切片的最终放弃阈值）。代价：极少数跨越数千行
// 的多行结构（超长 heredoc/字符串/注释）降级后可能着色不准，shell 脚本下罕见。
const MAX_FROM_DOCUMENT_START_SLICE_LENGTH = 120_000;

// 「从文档首行起」tokenize 切片下沿的块大小（行）。滚动/打字时把切片终点向上对齐到
// 块边界，使相同区段的切片字符串稳定 → 命中 shiki-highlighter 的按串 token 缓存与按行
// 缓存，把「向下滚动/打字时逐行重算整段前缀」从每行一次降到每跨一个块一次。512 行在
// 常规代码下远低于 MAX_HIGHLIGHT_SLICE_LENGTH 体积上限。
const HIGHLIGHT_SLICE_CHUNK_LINES = 512;

`);

remove(PLUGIN, 'P3 删除 TShikiHighlightSlice 类型',
`type TShikiHighlightSlice = {
  code: string;
  startLine: number;
  endLine: number;
};

`);

remove(PLUGIN, 'P4 删除 computeShikiHighlightSlice 函数',
`/**
 * 截取需要 tokenize 的切片，单次成本与可见行数相关而非文档总长。
 * - fromDocumentStart=true（Worker 路径）：从文档首行切起，跨行结构完全正确；超过体积
 *   上限则退化为可见区窗口（fromDocumentStart=false 模式）。
 * - fromDocumentStart=false：仅切 [视口顶 - leadInLines .. 视口底 + overscan] 的有界窗口。
 * 窗口切片仍超体积上限（极端长行）时返回 null，调用方据此放弃高亮。返回所用行范围供复用判定。
 */
const computeShikiHighlightSlice = (
  view: EditorView,
  options: { fromDocumentStart: boolean; leadInLines?: number },
): TShikiHighlightSlice | null => {
  const { doc } = view.state;
  if (doc.length === 0) {
    return null;
  }

  const { visibleRanges } = view;
  if (visibleRanges.length === 0) {
    return null;
  }

  const firstVisibleLine = doc.lineAt(visibleRanges[0].from).number;
  const lastVisibleLine = doc.lineAt(visibleRanges[visibleRanges.length - 1].to).number;

  const buildSlice = (
    fromDocumentStart: boolean,
  ): { range: { startLine: number; endLine: number }; sliceFrom: number; sliceTo: number } => {
    const range = computeShikiHighlightRange({
      firstVisibleLine,
      lastVisibleLine,
      totalLines: doc.lines,
      overscanLines: HIGHLIGHT_OVERSCAN_LINES,
      leadInLines: options.leadInLines ?? HIGHLIGHT_OVERSCAN_LINES,
      fromDocumentStart,
      chunkLines: fromDocumentStart ? HIGHLIGHT_SLICE_CHUNK_LINES : undefined,
    });
    return {
      range,
      sliceFrom: doc.line(range.startLine).from,
      sliceTo: doc.line(range.endLine).to,
    };
  };

  let { range, sliceFrom, sliceTo } = buildSlice(options.fromDocumentStart);

  // 仅 fromDocumentStart 模式可能切片过大（超大文件），退化为可见区窗口；窗口模式本就有界。
  if (options.fromDocumentStart && sliceTo - sliceFrom > MAX_FROM_DOCUMENT_START_SLICE_LENGTH) {
    ({ range, sliceFrom, sliceTo } = buildSlice(false));
  }

  // 窗口切片仍超限（极端长行）时放弃高亮，避免任务过重。
  if (sliceTo - sliceFrom > MAX_HIGHLIGHT_SLICE_LENGTH) {
    return null;
  }

  return {
    code: doc.sliceString(sliceFrom, sliceTo),
    startLine: range.startLine,
    endLine: range.endLine,
  };
};

`);

patch(PLUGIN, 'P5 recompute 改为请求未命中区间(去切片)',
`      // —— Worker tokenize ——
      // 先用现有缓存（可能为部分命中）同步重建，已着色的行保持不变、不清空、不露白；再从
      // 文档开头切片交给 Worker，保证跨行结构配色正确，回包后入缓存重建。
      this.renderViewportFromCache(view);

      const slice = computeShikiHighlightSlice(view, { fromDocumentStart: false });
      if (!slice) {
        return;
      }

      const docVersion = this.docVersion;
      const requestKey = createShikiHighlightRequestKey({
        language,
        docVersion,
        startLine: slice.startLine,
        endLine: slice.endLine,
        codeLength: slice.code.length,
      });

      if (
        options.allowReuse &&
        this.pendingRequest &&
        this.pendingRequest.language === language &&
        this.pendingRequest.docVersion === docVersion &&
        (this.pendingRequest.key === requestKey ||
          isShikiHighlightRangeCovered({
            coveredStartLine: this.pendingRequest.startLine,
            coveredEndLine: this.pendingRequest.endLine,
            requestedStartLine: slice.startLine,
            requestedEndLine: slice.endLine,
          }))
      ) {
        return;
      }

      const requestId = this.nextRequestId;
      this.nextRequestId += 1;
      this.latestRequestId = requestId;
      this.pendingRequest = {
        key: requestKey,
        requestId,
        docVersion,
        language,
        startLine: slice.startLine,
        endLine: slice.endLine,
      };

      this.enqueueWorkerTokenize({
        view,
        getFullCode: () => view.state.doc.toString(),
        sessionKey: this.shikiSessionKey,
        requestId,
        docVersion,
        language,
        startLine: slice.startLine,
        endLine: slice.endLine,
      });
    }`,
`      // —— Worker tokenize（方案B：会话化 + 有界视口窗口；Worker 持有整篇文档与按块语法状态）——
      // 先用现有缓存（可能部分命中）同步重建，已着色行不清空、不露白；再请求视口内未命中缓存的
      // 行范围。Worker 从该范围所在块边界以真实语法状态续算，跨行结构在任意文件体积下都正确，
      // 且单次成本仅与窗口大小相关——深处前缀块状态由 Worker 后台预热并缓存复用。
      this.renderViewportFromCache(view);

      const requestStartLine = uncached.startLine;
      const requestEndLine = uncached.endLine;
      const docVersion = this.docVersion;
      const requestKey = createShikiHighlightRequestKey({
        language,
        docVersion,
        startLine: requestStartLine,
        endLine: requestEndLine,
        codeLength: view.state.doc.length,
      });

      if (
        options.allowReuse &&
        this.pendingRequest &&
        this.pendingRequest.language === language &&
        this.pendingRequest.docVersion === docVersion &&
        (this.pendingRequest.key === requestKey ||
          isShikiHighlightRangeCovered({
            coveredStartLine: this.pendingRequest.startLine,
            coveredEndLine: this.pendingRequest.endLine,
            requestedStartLine: requestStartLine,
            requestedEndLine: requestEndLine,
          }))
      ) {
        return;
      }

      const requestId = this.nextRequestId;
      this.nextRequestId += 1;
      this.latestRequestId = requestId;
      this.pendingRequest = {
        key: requestKey,
        requestId,
        docVersion,
        language,
        startLine: requestStartLine,
        endLine: requestEndLine,
      };

      this.enqueueWorkerTokenize({
        view,
        getFullCode: () => view.state.doc.toString(),
        sessionKey: this.shikiSessionKey,
        requestId,
        docVersion,
        language,
        startLine: requestStartLine,
        endLine: requestEndLine,
      });
    }`,
`const requestStartLine = uncached.startLine;`);

patch(PLUGIN, 'P6 文档变更发送行级增量',
`      if (update.docChanged) {
        this.docVersion += 1;
      }`,
`      if (update.docChanged) {
        this.docVersion += 1;
        this.sendShikiEdit(update);
      }`,
`this.sendShikiEdit(update);`);

patch(PLUGIN, 'P7 新增 sendShikiEdit 方法',
`    private recompute(view: EditorView, options: { allowReuse: boolean }): void {`,
`    /**
     * 把一次文档变更转换为基于行的覆盖增量(delta)发给 Worker：Worker 原地 splice 文档并失效
     * 受影响块及其后续块的语法状态(后台重新预热)，避免每次编辑都重传整篇文本。取整个 ChangeSet
     * 的最小/最大触及位置作为单个覆盖区间——对常见单点编辑精确，对多光标/分散编辑覆盖其跨度
     * (结果仍与新文档一致，仅多失效中间若干行的状态缓存)。
     */
    private sendShikiEdit(update: ViewUpdate): void {
      const language = update.state.field(shikiLanguageField, false) ?? 'text';
      if (!resolveShikiLanguageId(language)) {
        return;
      }
      const oldDoc = update.startState.doc;
      const newDoc = update.state.doc;
      let minFromA = Number.POSITIVE_INFINITY;
      let maxToA = -1;
      let maxToB = -1;
      update.changes.iterChanges((fromA, toA, _fromB, toB) => {
        if (fromA < minFromA) {
          minFromA = fromA;
        }
        if (toA > maxToA) {
          maxToA = toA;
        }
        if (toB > maxToB) {
          maxToB = toB;
        }
      });
      if (maxToA < 0 || maxToB < 0) {
        return;
      }
      const fromLine = oldDoc.lineAt(minFromA).number;
      		const oldEndLine = oldDoc.lineAt(maxToA).number;
		const newEndLine = newDoc.lineAt(maxToB).number;
		const deletedLineCount = oldEndLine - fromLine + 1;
		const insertedLines = [];
		for (let ln = fromLine; ln <= newEndLine; ln += 1) {
			insertedLines.push(newDoc.line(ln).text);
		}
		applyShikiEdit(
			this.shikiSessionKey,
			this.docVersion,
			fromLine,
			deletedLineCount,
			insertedLines,
		);
	}
`;
	patch(
		PLUGIN,
		// 锚点：recompute 方法定义前插入 sendShikiEdit
		'\tprivate recompute(',
		P7_SEND_EDIT + '\n\tprivate recompute(',
	);

	// ---- P8: destroy() 内派发 dispose ----
	patch(
		PLUGIN,
		'\t\tthis.destroyed = true;\n\t\tthis.cancelScheduledRecompute();',
		'\t\tthis.destroyed = true;\n\t\tthis.cancelScheduledRecompute();\n\t\tdisposeShikiSession(this.shikiSessionKey);',
	);

	console.log('  ✓ 插件文件补丁完成 (P1–P8)');
}

// ============================================================
// 执行
// ============================================================
function main() {
	console.log('方案B 增强：会话 + 增量编辑 + 后台预热');
	console.log('工作目录:', process.cwd());

	rewriteWorker();      // WORKER 全量重写
	rewriteHighlighter(); // HIGHLIGHTER 全量重写
	patchStatic();        // S1 + S2
	patchPlugin();        // P1–P8

	console.log('\n全部完成。备份后缀 .b2.bak');
	console.log('回滚：把 *.b2.bak 还原即可。');
}

main();