import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import { bundledLanguages } from 'shiki/langs';
import { type IShikiThemedToken, resolveShikiLanguageId, SHIKI_THEME_NAME } from './shiki-shared';

/**
 * 方案B：有状态、按块语法状态接续的 tokenize Worker。
 *
 * 设计对照 microsoft/vscode 的 TrackingTokenizationStateStore（逐行/逐块缓存“末态”，
 * 从最近已知状态续算）与 shiki @shikijs/primitive 的 codeToTokensBase({ grammarState })
 * / getLastGrammarState。GrammarState 是带链式父引用与方法的不透明对象，无法跨线程
 * postMessage，因此整篇文档与每块末态全部留在 Worker 内：主线程只发“会话 + 行范围”。
 *
 * 块大小 BLOCK_LINES：每个块结束处缓存一份 GrammarState，使深处视口可从最近块边界以
 * “真实语法状态”续算，而非从 INITIAL 重新开始（后者会让跨块的长字符串/heredoc/块注释
 * 着色错误）。单次成本仅与窗口大小相关：深处前缀块状态一次算出后即缓存复用。
 *
 * 需要 Shiki ≥ 1.16（grammarState / getLastGrammarState API）。
 */

const BLOCK_LINES = 512;
const MAX_SESSIONS = 8;

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

type TShikiWorkerRequest = TResetRequest | TTokenizeRangeRequest;

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
  sessionId: number;
  docVersion: number;
  language: string;
  shikiId: string | null;
  resolved: boolean;
  lines: string[];
  blockEndState: Map<number, unknown>;
};

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLanguages = new Set<string>();
const pendingLanguages = new Map<string, Promise<boolean>>();
const sessions = new Map<number, TSession>();

const ensureHighlighter = (): Promise<HighlighterCore> => {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [import('@shikijs/themes/github-light')],
      langs: [],
      engine: createOnigurumaEngine(import('shiki/wasm')),
    }).catch((error) => {
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

// 用给定的起始语法状态 tokenize 一段代码，返回 token 与该段结束处的语法状态。
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
    const blockCode = session.lines.slice(fromLine, fromLine + BLOCK_LINES).join('\n');
    const { endState } = tokenizeBlockCode(highlighter, shikiId, blockCode, prevState);
    session.blockEndState.set(b, endState);
    prevState = endState;
  }
  return session.blockEndState.get(blockIndex) ?? null;
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
  const code = session.lines.slice(blockStartLine - 1, endLine).join('\n');
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
    sessions.set(data.sessionKey, {
      sessionId: data.sessionId,
      docVersion: data.docVersion,
      language: data.language,
      shikiId: null,
      resolved: false,
      lines: data.code.split('\n'),
      blockEndState: new Map(),
    });
    if (sessions.size > MAX_SESSIONS) {
      for (const key of sessions.keys()) {
        if (key !== data.sessionKey) {
          sessions.delete(key);
          break;
        }
      }
    }
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
