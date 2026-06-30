import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = 'src/services/editor/'

const edit = ({ file, find, replace, marker, label }) => {
  const path = ROOT + file
  let src = readFileSync(path, 'utf8')
  if (marker && src.includes(marker)) {
    console.log('[skip] ' + label)
    return
  }
  const n = src.split(find).length - 1
  if (n !== 1) {
    throw new Error('[' + label + '] 期望唯一匹配，实际 ' + n + ' 处')
  }
  src = src.replace(find, () => replace)
  writeFileSync(path, src)
  console.log('[ok] ' + label)
}

// A) TSession：单检查点字段 -> 多检查点 Map
edit({
  file: 'shiki-tokenizer.worker.ts',
  marker: 'resumeCheckpoints: Map<number, unknown>;',
  label: 'A TSession.resumeCheckpoints',
  find: `  // 向下滚动的“连续续算”提示：上一次 tokenizeRange 结束处的下一行与其语法末态。
  // 下一请求若正好从 nextLine 开始（典型向下滚动），可直接以 endState 续算、零导入行重切。
  lastForwardRange: { docVersion: number; nextLine: number; endState: unknown } | null;`,
  replace: `  // 续算检查点：行号(1-based) -> 该行“起始处”的语法状态。键全部来自既往请求的真实边界
  // （切片起始行 sliceStartLine 与结束行下一行 endLine+1），不引入任何固定间隔魔数。
  // tokenizeRange 取 (blockStartLine, startLine] 内行号最大的检查点起切以缩短导入行；
  // 语法 token 是「起始态+文本」的确定函数，故与块首起切结果完全一致。编辑时按行失效。
  resumeCheckpoints: Map<number, unknown>;`,
})

// B) 内存护栏常量
edit({
  file: 'shiki-tokenizer.worker.ts',
  marker: 'const MAX_RESUME_CHECKPOINTS = 4096;',
  label: 'B MAX_RESUME_CHECKPOINTS',
  find: `const BLOCK_LINES = 512;
const MAX_SESSIONS = 16;
const BG_SLICE_MS = 15;`,
  replace: `const BLOCK_LINES = 512;
const MAX_SESSIONS = 16;
const BG_SLICE_MS = 15;
// 续算检查点数量上限（纯内存护栏，非行为调参）：仅在静态文档滚动时按真实请求边界累积，
// 每次编辑按行失效。超限按最旧插入淘汰，淘汰仅退化为块首起切，绝不影响正确性。
const MAX_RESUME_CHECKPOINTS = 4096;`,
})

// C) 新增检查点读写辅助函数（插在 tokenizeRange 之前）
edit({
  file: 'shiki-tokenizer.worker.ts',
  marker: 'const setResumeCheckpoint =',
  label: 'C checkpoint helpers',
  find: `const tokenizeRange = async (req: TTokenizeRangeRequest): Promise<IShikiThemedToken[][] | null> => {`,
  replace: `const setResumeCheckpoint = (session: TSession, line: number, state: unknown): void => {
  if (state == null || line < 1) {
    return;
  }
  if (session.resumeCheckpoints.has(line)) {
    session.resumeCheckpoints.delete(line);
  }
  session.resumeCheckpoints.set(line, state);
  while (session.resumeCheckpoints.size > MAX_RESUME_CHECKPOINTS) {
    const oldest = session.resumeCheckpoints.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    session.resumeCheckpoints.delete(oldest);
  }
};

// 在 (afterLine, startLine] 内取行号最大的可用检查点，缩短导入行；找不到返回 null。
// 仅当比块首更近时由 tokenizeRange 采用，绝不会比块首起切更差。
const nearestResumeCheckpoint = (
  session: TSession,
  afterLine: number,
  startLine: number,
): { line: number; state: unknown } | null => {
  let bestLine = afterLine;
  let bestState: unknown = null;
  for (const [line, state] of session.resumeCheckpoints) {
    if (line > bestLine && line <= startLine && state != null) {
      bestLine = line;
      bestState = state;
    }
  }
  return bestState == null ? null : { line: bestLine, state: bestState };
};

const tokenizeRange = async (req: TTokenizeRangeRequest): Promise<IShikiThemedToken[][] | null> => {`,
})

// D) tokenizeRange 尾部：单检查点快路径 -> 多检查点最近起切
edit({
  file: 'shiki-tokenizer.worker.ts',
  marker: 'nearestResumeCheckpoint(session, blockStartLine, startLine)',
  label: 'D tokenizeRange resume',
  find: `  // 续算快路径：上一次该会话的 tokenize 正好停在 startLine-1（典型向下滚动），且已拿到
  // 真实语法末态时，直接复用它从 startLine 起切，免去“块首→startLine”的导入行重切。
  const last = session.lastForwardRange;
  let sliceStartLine: number;
  let startState: unknown;
  if (
    last &&
    last.docVersion === session.docVersion &&
    last.nextLine === startLine &&
    last.endState != null
  ) {
    sliceStartLine = startLine;
    startState = last.endState;
  } else {
    const startBlock = Math.floor((startLine - 1) / BLOCK_LINES);
    sliceStartLine = startBlock * BLOCK_LINES + 1;
    startState = ensureBlockEndState(highlighter, session, shikiId, startBlock - 1);
  }
  const code = session.lines.slice(sliceStartLine - 1, endLine).join('\\n');
  const { tokens, endState } = tokenizeBlockCode(highlighter, shikiId, code, startState);
  // 记录本次末态供下一段连续区间续算；docVersion 变化时由 applyEdit 清空。
  session.lastForwardRange = { docVersion: session.docVersion, nextLine: endLine + 1, endState };`,
  replace: `  // 续算检查点：先以块首为基准（startState 取自块末态链，导入行最多 BLOCK_LINES-1），
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
  const code = session.lines.slice(sliceStartLine - 1, endLine).join('\\n');
  const { tokens, endState } = tokenizeBlockCode(highlighter, shikiId, code, startState);
  // 记录本次两个真实边界检查点：切片起始行（向上/跳转续算）与结束行下一行（向下续算）。
  setResumeCheckpoint(session, sliceStartLine, startState);
  setResumeCheckpoint(session, endLine + 1, endState);`,
})

// E) applyEdit：整体清空 -> 按行精确失效
edit({
  file: 'shiki-tokenizer.worker.ts',
  marker: '编辑使 fromLine 之后所有行',
  label: 'E applyEdit invalidation',
  find: `  if (session.bgCursor > editedBlock) {
    session.bgCursor = editedBlock;
  }
  session.lastForwardRange = null;
  scheduleBackground();`,
  replace: `  if (session.bgCursor > editedBlock) {
    session.bgCursor = editedBlock;
  }
  // 编辑使 fromLine 之后所有行的起始语法态与行号失效（splice 同时位移行号）；
  // fromLine 及之前的检查点仍精确有效，按行删除其后的检查点即可。
  for (const line of session.resumeCheckpoints.keys()) {
    if (line > req.fromLine) {
      session.resumeCheckpoints.delete(line);
    }
  }
  scheduleBackground();`,
})

// F) reset 初始化
edit({
  file: 'shiki-tokenizer.worker.ts',
  marker: 'resumeCheckpoints: new Map(),',
  label: 'F reset init',
  find: `      blockEndState: new Map(),
      bgCursor: 0,
      lastForwardRange: null,
    };`,
  replace: `      blockEndState: new Map(),
      bgCursor: 0,
      resumeCheckpoints: new Map(),
    };`,
})

console.log('done')