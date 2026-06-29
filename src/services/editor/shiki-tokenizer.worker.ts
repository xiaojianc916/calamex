import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import { bundledLanguages } from 'shiki/langs';
import { type IShikiThemedToken, resolveShikiLanguageId, SHIKI_THEME_NAME } from './shiki-shared';

/**
 * 方案B 增强：会话 + 增量编辑 + 后台预热
 *
 * 在方案B（有状态、按块语法状态接续）的基础上新增两项能力，且不保留任何旧路径/兼容层：
 *
 * 1) 增量编辑（edit）：文档变更时主线程只发送行级 delta（起始行 / 删除行数 / 新增行），
 *    Worker 用 splice 原地更新整篇文本，并仅作废受影响块（editedBlock 及其之后）的末态缓存，
 *    无需每次变更都重传整篇代码。对照 microsoft/vscode 的 TextModel 增量分词：编辑只让
 *    编辑点之后的分词状态失效，之前的行保持已算结果。
 *
 * 2) 后台预热（background pre-warm）：会话建立 / 语言就绪 / 编辑之后，用时间分片（≤ BG_SLICE_MS）
 *    在空闲回合里从 bgCursor 向后逐块计算并缓存块末态。这样向文件深处滚动时，前缀块状态多已就绪，
 *    tokenizeRange 直接从最近块边界以“真实语法状态”续算，无需现场从头补算整段前缀。
 *
 * GrammarState 含链式父引用与方法，无法跨线程 postMessage，因此整篇文档与每块末态全部留在
 * Worker 内：主线程只发“会话 + 行范围 / 行级 delta”。需要 Shiki ≥ 1.16
 * （grammarState / getLastGrammarState API）。
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

type TShikiWorkerRequest =
  | TResetRequest
  | TEditRequest
  | TTokenizeRangeRequest
  | TDisposeRequest;

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
let backgroundScheduled = false;

const ensureHighlighter = (): Promise<HighlighterCore> => {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [import('@shikijs/themes/github-light')],
      langs: [],
      engine: createOnigurumaEngine(import('shiki/wasm')),
    })
      .then((instance) => {
        highlighterInstance = instance;
        return instance;
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

const totalBlocks = (session: TSession): number =>
  Math.max(1, Math.ceil(session.lines.length / BLOCK_LINES));

// 异步解析会话语言；就绪后开启后台预热。语言加载经 pendingLanguages 去重。
const resolveSession = (session: TSession): void => {
  if (session.resolved) {
    scheduleBackground();
    return;
  }
  if (session.resolving) {
    return;
  }
  session.resolving = true;
  void ensureLanguage(session.language)
    .then((shikiId) => {
      session.shikiId = shikiId;
      session.resolved = true;
      session.resolving = false;
      scheduleBackground();
    })
    .catch(() => {
      session.shikiId = null;
      session.resolved = true;
      session.resolving = false;
    });
};

// 后台预热：时间分片地从 bgCursor 向后逐块计算并缓存块末态。返回该会话是否仍有剩余工作。
const advanceSessionBackground = (
  highlighter: HighlighterCore,
  session: TSession,
  deadline: number,
): boolean => {
  if (!session.resolved || !session.shikiId) {
    return false;
  }
  const blocks = totalBlocks(session);
  // 最后一块之后没有内容，无需缓存其末态；填到 blocks - 1 即可。
  while (session.bgCursor < blocks - 1) {
    if (Date.now() >= deadline) {
      return true;
    }
    ensureBlockEndState(highlighter, session, session.shikiId, session.bgCursor);
    session.bgCursor += 1;
  }
  return false;
};

const runBackground = (): void => {
  backgroundScheduled = false;
  const highlighter = highlighterInstance;
  if (!highlighter) {
    return;
  }
  const deadline = Date.now() + BG_SLICE_MS;
  let moreWork = false;
  for (const [key, session] of sessions) {
    if (key < 0) {
      // 片段会话（静态高亮）一次性使用、随即 dispose，不做预热。
      continue;
    }
    if (advanceSessionBackground(highlighter, session, deadline)) {
      moreWork = true;
    }
    if (Date.now() >= deadline) {
      moreWork = true;
      break;
    }
  }
  if (moreWork) {
    scheduleBackground();
  }
};

const scheduleBackground = (): void => {
  if (backgroundScheduled) {
    return;
  }
  backgroundScheduled = true;
  setTimeout(runBackground, 0);
};

const applyEdit = (req: TEditRequest): void => {
  const session = sessions.get(req.sessionKey);
  if (!session || session.sessionId !== req.sessionId) {
    return;
  }
  const fromIndex = Math.max(0, req.fromLine - 1);
  session.lines.splice(fromIndex, req.deletedLineCount, ...req.insertedLines);
  session.docVersion = req.docVersion;
  const editedBlock = Math.floor(fromIndex / BLOCK_LINES);
  for (const blockIndex of [...session.blockEndState.keys()]) {
    if (blockIndex >= editedBlock) {
      session.blockEndState.delete(blockIndex);
    }
  }
  if (session.bgCursor > editedBlock) {
    session.bgCursor = editedBlock;
  }
  scheduleBackground();
};

const tokenizeRange = async (req: TTokenizeRangeRequest): Promise<IShikiThemedToken[][] | null> => {
  const session = sessions.