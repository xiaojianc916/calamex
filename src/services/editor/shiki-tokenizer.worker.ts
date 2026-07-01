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
 *    Worker 用 splice 原地更新整篇文本，并仅作废受影响块（editedBlock 及其之后）的末态缓存。
 *
 * 2) 后台预热（background pre-warm）：会话建立 / 语言就绪 / 编辑之后，用时间分片（≤ BG_SLICE_MS）
 *    在空闲回合里从 bgCursor 向后逐块计算并缓存块末态。
 *
 * GrammarState 无法跨线程 postMessage，因此整篇文档与每块末态全部留在 Worker 内。需 Shiki ≥ 1.16。
 */

const BLOCK_LINES = 512;
const MAX_SESSIONS = 16;
const BG_SLICE_MS = 15;
// 续算检查点数量上限（纯内存护栏，非行为调参）：仅在静态文档滚动时按真实请求边界累积，
// 每次编辑按行失效。超限按最旧插入淘汰，淘汰仅退化为块首起切，绝不影响正确性。
const MAX_RESUME_CHECKPOINTS = 4096;

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
  sessionId: number;
  docVersion: number;
  language: string;
  shikiId: string | null;
  resolved: boolean;
  resolving: boolean;
  lines: string[];
  blockEndState: Map<number, unknown>;
  bgCursor: number;
  // 续算检查点：行号(1-based) -> 该行“起始处”的语法状态。键全部来自既往请求的真实边界
  // （切片起始行 sliceStartLine 与结束行下一行 endLine+1），不引入任何固定间隔魔数。
  // tokenizeRange 取 (blockStartLine, startLine] 内行号最大的检查点起切以缩短导入行；
  // 语法 token 是「起始态+文本」的确定函数，故与块首起切结果完全一致。编辑时按行失效。
  resumeCheckpoints: Map<number, unknown>;
  // 与 resumeCheckpoints 同步维护的升序行号数组，供二分查找（O(log n)）。
  resumeCheckpointLines: number[];
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

const advanceSessionBackground = (
  highlighter: HighlighterCore,
  session: TSession,
  deadline: number,
): boolean => {
  if (!session.resolved || !session.shikiId) {
    return false;
  }
  const blocks = totalBlocks(session);
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
  for (const blockIndex of session.blockEndState.keys()) {
    if (blockIndex >= editedBlock) {
      session.blockEndState.delete(blockIndex);
    }
  }
  if (session.bgCursor > editedBlock) {
    session.bgCursor = editedBlock;
  }
  // 编辑使 fromLine 之后所有行的起始语法态与行号失效（splice 同时位移行号）；
  // fromLine 及之前的检查点仍精确有效，按行删除其后的检查点即可。
  {
    const lines = session.resumeCheckpointLines;
    const cut = lowerBound(lines, req.fromLine + 1);
    for (let i = cut; i < lines.length; i += 1) {
      session.resumeCheckpoints.delete(lines[i]);
    }
    lines.length = cut;
  }
  scheduleBackground();
};

// 升序数组二分：返回第一个 >= target 的下标（lower bound）。
const lowerBound = (sorted: number[], target: number): number => {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
};

const insertSortedUnique = (sorted: number[], value: number): void => {
  const index = lowerBound(sorted, value);
  if (sorted[index] === value) {
    return;
  }
  sorted.splice(index, 0, value);
};

const removeSorted = (sorted: number[], value: number): void => {
  const index = lowerBound(sorted, value);
  if (sorted[index] === value) {
    sorted.splice(index, 1);
  }
};

const setResumeCheckpoint = (session: TSession, line: number, state: unknown): void => {
  if (state == null || line < 1) {
    return;
  }
  if (session.resumeCheckpoints.has(line)) {
    // 已存在：仅刷新 LRU 新近度（Map 重新入队尾），有序行数组无需变动。
    session.resumeCheckpoints.delete(line);
    session.resumeCheckpoints.set(line, state);
    return;
  }
  session.resumeCheckpoints.set(line, state);
  insertSortedUnique(session.resumeCheckpointLines, line);
  while (session.resumeCheckpoints.size > MAX_RESUME_CHECKPOINTS) {
    const oldest = session.resumeCheckpoints.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    session.resumeCheckpoints.delete(oldest);
    removeSorted(session.resumeCheckpointLines, oldest);
  }
};

// 在 (afterLine, startLine] 内取行号最大的可用检查点，缩短导入行；找不到返回 null。
// 仅当比块首更近时由 tokenizeRange 采用，绝不会比块首起切更差。
const nearestResumeCheckpoint = (
  session: TSession,
  afterLine: number,
  startLine: number,
): { line: number; state: unknown } | null => {
  // 有序行数组取 <= startLine 的最大行（lowerBound(startLine+1)-1），再校验 > afterLine。
  // 所有已存状态非空，故与原线性扫描结果等价。
  const lines = session.resumeCheckpointLines;
  const index = lowerBound(lines, startLine + 1) - 1;
  if (index < 0) {
    return null;
  }
  const bestLine = lines[index];
  if (bestLine <= afterLine) {
    return null;
  }
  const bestState = session.resumeCheckpoints.get(bestLine);
  return bestState == null ? null : { line: bestLine, state: bestState };
};

const tokenizeRange = async (req: TTokenizeRangeRequest): Promise<IShikiThemedToken[][] | null> => {
  const session = sessions.get(req.sessionKey);
  if (!session || session.sessionId !== req.sessionId || session.docVersion !== req.docVersion) {
    return null;
  }
  if (!session.resolved) {
    session.shikiId = await ensureLanguage(session.language);
    session.resolved = true;
    session.resolving = false;
  }
  const { shikiId } = session;
  if (!shikiId) {
    return null;
  }
  if (sessions.get(req.sessionKey) !== session || session.docVersion !== req.docVersion) {
    return null;
  }
  const totalLines = session.lines.length;
  if (totalLines === 0) {
    return null;
  }
  const highlighter = highlighterInstance ?? (await ensureHighlighter());
  const startLine = Math.max(1, req.startLine);
  const endLine = Math.min(totalLines, Math.max(startLine, req.endLine));
  if (startLine > totalLines) {
    return null;
  }
  // 续算检查点：先以块首为基准（startState 取自块末态链，导入行最多 BLOCK_LINES-1），
  // 再在 (blockStartLine, startLine] 内取行号最大的既往请求检查点；命中则从它起切，导入行更短。
  // 覆盖向下滚动（endLine+1 检查点 → 零导入行）、向上滚动与跳转定位（既往切片起始行检查点）。
  const startBlock = Math.floor((startLine - 1) / BLOCK_LINES);
  const blockStartLine = startBlock * BLOCK_LINES + 1;
  let sliceStartLine = blockStartLine;
  let startState = ensureBlockEndState(highlighter, session, shikiId, startBlock - 1);
  const nearer = nearestResumeCheckpoint(session, blockStartLine, startLine);
  if (nearer) {
    sliceStartLine = nearer.line;
    startState = nearer.state;
  }
  const code = session.lines.slice(sliceStartLine - 1, endLine).join('\n');
  const { tokens, endState } = tokenizeBlockCode(highlighter, shikiId, code, startState);
  // 记录本次两个真实边界检查点：切片起始行（向上/跳转续算）与结束行下一行（向下续算）。
  setResumeCheckpoint(session, sliceStartLine, startState);
  setResumeCheckpoint(session, endLine + 1, endState);
  const offset = startLine - sliceStartLine;
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
      sessionId: data.sessionId,
      docVersion: data.docVersion,
      language: data.language,
      shikiId: null,
      resolved: false,
      resolving: false,
      lines: data.code.split('\n'),
      blockEndState: new Map(),
      bgCursor: 0,
      resumeCheckpoints: new Map(),
      resumeCheckpointLines: [],
    };
    sessions.set(data.sessionKey, session);
    if (sessions.size > MAX_SESSIONS) {
      for (const [key] of sessions) {
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
    applyEdit(data);
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
