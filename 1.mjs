// scripts/feature-treesitter-bash-phase1.mjs
//
// tree-sitter-bash 高亮 Phase 1（自包含单文件）。
// 用法:
//   node scripts/feature-treesitter-bash-phase1.mjs                  # dry-run（只打印计划）
//   node scripts/feature-treesitter-bash-phase1.mjs --write          # 落盘：新增6文件 + 接线2处
//   node scripts/feature-treesitter-bash-phase1.mjs --revert --write # 还原：删新文件 + 回退接线
//
// 设计：tree-sitter 输出与 Shiki 完全相同的 IShikiThemedToken[][]，复用现有渲染/缓存管线；
// feature flag 默认关 → 合入后行为与现状逐字节一致；worker 失败/超时/覆盖校验未过 → 回退 Shiki。
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const ROOT = process.cwd();
const WRITE = process.argv.includes('--write');
const REVERT = process.argv.includes('--revert');
const EDITOR = 'src/services/editor';

// ───────────────────────── 新文件（源码用 String.raw 内联，转义保持原样） ─────────────────────────

const SHARED_TS = String.raw`import { type IShikiThemedToken, SHIKI_FOREGROUND } from '@/services/editor/shiki-shared';

/** 默认前景：与 Shiki github-light 一致，用于 query 未命中的 gap 文本。 */
export const TREE_SITTER_BASH_DEFAULT_FG = SHIKI_FOREGROUND;

const FONT_STYLE_ITALIC = 1;

interface ICaptureStyle {
  color: string;
  fontStyle?: number;
}

// capture 名 → github-light 配色。未命中精确名时退化到首段（string.special → string）；
// 未知 capture 返回 null（按默认前景渲染）。校色以 Shiki 为基准（见 PR 描述的定标步骤）。
const CAPTURE_STYLES: Readonly<Record<string, ICaptureStyle>> = {
  comment: { color: '#6e7781', fontStyle: FONT_STYLE_ITALIC },
  keyword: { color: '#cf222e' },
  conditional: { color: '#cf222e' },
  repeat: { color: '#cf222e' },
  function: { color: '#8250df' },
  string: { color: '#0a3069' },
  number: { color: '#0550ae' },
  boolean: { color: '#0550ae' },
  constant: { color: '#0550ae' },
  variable: { color: '#953800' },
  parameter: { color: '#953800' },
  property: { color: '#953800' },
  operator: { color: '#24292f' },
  punctuation: { color: '#24292f' },
  embedded: { color: '#24292f' },
};

export const resolveBashCaptureStyle = (name: string): ICaptureStyle | null => {
  const exact = CAPTURE_STYLES[name];
  if (exact) {
    return exact;
  }
  const head = name.split('.')[0];
  return CAPTURE_STYLES[head] ?? null;
};

export interface ITreeSitterBashCapture {
  startByte: number;
  endByte: number;
  name: string;
}

// charByteOffsets[i] = 第 i 个字符起始处的 UTF-8 字节偏移；长度 code.length+1，单调非减。
const buildCharByteOffsets = (code: string): number[] => {
  const offsets = new Array<number>(code.length + 1);
  let byte = 0;
  for (let index = 0; index < code.length; index += 1) {
    offsets[index] = byte;
    const unit = code.charCodeAt(index);
    if (unit < 0x80) {
      byte += 1;
    } else if (unit < 0x800) {
      byte += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < code.length) {
      const next = code.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        byte += 4;
        offsets[index + 1] = byte;
        index += 1;
        continue;
      }
      byte += 3;
    } else {
      byte += 3;
    }
  }
  offsets[code.length] = byte;
  return offsets;
};

// 二分：返回满足 offsets[i] <= byteOffset 的最大 i（节点边界总落在字符边界上，故为精确点）。
export const byteToCharIndex = (offsets: number[], byteOffset: number): number => {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid] <= byteOffset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
};

interface ICharCapture {
  startChar: number;
  endChar: number;
  style: ICaptureStyle;
}

interface ISpan {
  from: number;
  to: number;
  color: string;
  fontStyle?: number;
}

// tree 节点天然嵌套或不相交：用栈把（嵌套的）capture 压平成非重叠、连续覆盖的 span。
const buildNonOverlappingSpans = (length: number, captures: ICharCapture[]): ISpan[] => {
  const spans: ISpan[] = [];
  const stack: Array<{ end: number; color: string; fontStyle?: number }> = [];
  let cursor = 0;

  const emit = (from: number, to: number, color: string, fontStyle?: number): void => {
    if (to > from) {
      spans.push({ from, to, color, fontStyle });
    }
  };

  for (const capture of captures) {
    for (
      let top = stack[stack.length - 1];
      top && top.end <= capture.startChar;
      top = stack[stack.length - 1]
    ) {
      emit(cursor, top.end, top.color, top.fontStyle);
      cursor = Math.max(cursor, top.end);
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (capture.startChar > cursor) {
      emit(cursor, capture.startChar, parent?.color ?? TREE_SITTER_BASH_DEFAULT_FG, parent?.fontStyle);
      cursor = capture.startChar;
    }
    if (capture.endChar <= cursor) {
      continue;
    }
    stack.push({ end: capture.endChar, color: capture.style.color, fontStyle: capture.style.fontStyle });
  }

  for (let top = stack.pop(); top; top = stack.pop()) {
    emit(cursor, top.end, top.color, top.fontStyle);
    cursor = Math.max(cursor, top.end);
  }
  emit(cursor, length, TREE_SITTER_BASH_DEFAULT_FG);
  return spans;
};

const splitSpansIntoLines = (code: string, spans: ISpan[]): IShikiThemedToken[][] => {
  const lines: IShikiThemedToken[][] = [];
  let current: IShikiThemedToken[] = [];
  let lineStart = 0;

  for (const span of spans) {
    let position = span.from;
    while (position < span.to) {
      const newlineIndex = code.indexOf('\n', position);
      const cut = newlineIndex === -1 || newlineIndex >= span.to ? span.to : newlineIndex;
      if (cut > position) {
        current.push({
          content: code.slice(position, cut),
          offset: position - lineStart,
          color: span.color,
          fontStyle: span.fontStyle,
        });
      }
      if (newlineIndex !== -1 && newlineIndex < span.to) {
        lines.push(current);
        current = [];
        lineStart = newlineIndex + 1;
        position = newlineIndex + 1;
      } else {
        position = cut;
      }
    }
  }
  lines.push(current);
  return lines;
};

/** 把 query captures（字节偏移）转成逐行、连续覆盖的 themed tokens（形状同 Shiki）。 */
export const treeSitterBashCapturesToThemedLines = (
  code: string,
  captures: ITreeSitterBashCapture[],
): IShikiThemedToken[][] => {
  const offsets = buildCharByteOffsets(code);
  const charCaptures: ICharCapture[] = [];
  for (const capture of captures) {
    const style = resolveBashCaptureStyle(capture.name);
    if (!style) {
      continue;
    }
    const startChar = byteToCharIndex(offsets, capture.startByte);
    const endChar = byteToCharIndex(offsets, capture.endByte);
    if (endChar > startChar) {
      charCaptures.push({ startChar, endChar, style });
    }
  }
  charCaptures.sort((left, right) => left.startChar - right.startChar || right.endChar - left.endChar);
  return splitSpansIntoLines(code, buildNonOverlappingSpans(code.length, charCaptures));
};

/** 覆盖校验：token 内容字符数 + 换行数 应等于源码长度；不等说明偏移映射有误 → 调用方回退 Shiki。 */
export const verifyBashThemedLinesCoverage = (code: string, lines: IShikiThemedToken[][]): boolean => {
  let contentChars = 0;
  for (const line of lines) {
    for (const token of line) {
      contentChars += token.content.length;
    }
  }
  let newlineCount = 0;
  for (let index = 0; index < code.length; index += 1) {
    if (code.charCodeAt(index) === 10) {
      newlineCount += 1;
    }
  }
  return contentChars + newlineCount === code.length;
};
`;

const WORKER_TS = String.raw`import bashLanguageWasmUrl from 'tree-sitter-bash/tree-sitter-bash.wasm?url';
import highlightsQuerySource from 'tree-sitter-bash/queries/highlights.scm?raw';
import { Language, Parser, Query } from 'web-tree-sitter';
import treeSitterWasmUrl from 'web-tree-sitter/web-tree-sitter.wasm?url';
import type { IShikiThemedToken } from '@/services/editor/shiki-shared';
import {
  type ITreeSitterBashCapture,
  treeSitterBashCapturesToThemedLines,
  verifyBashThemedLinesCoverage,
} from '@/services/editor/treesitter-bash-shared';

interface ITreeSitterBashRequest {
  id: number;
  code: string;
}
interface ITreeSitterBashResponse {
  id: number;
  tokens: IShikiThemedToken[][] | null;
  error?: string;
}

let runtimePromise: Promise<{ parser: Parser; query: Query }> | null = null;

const ensureRuntime = (): Promise<{ parser: Parser; query: Query }> => {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      await Parser.init({ locateFile: () => treeSitterWasmUrl });
      const language = await Language.load(bashLanguageWasmUrl);
      const parser = new Parser();
      parser.setLanguage(language);
      const query = new Query(language, highlightsQuerySource);
      return { parser, query };
    })().catch((error: unknown) => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
};

const tokenizeBash = async (code: string): Promise<IShikiThemedToken[][] | null> => {
  const { parser, query } = await ensureRuntime();
  const tree = parser.parse(code);
  if (!tree) {
    return null;
  }
  try {
    const captures: ITreeSitterBashCapture[] = query.captures(tree.rootNode).map((capture) => ({
      startByte: capture.node.startIndex,
      endByte: capture.node.endIndex,
      name: capture.name,
    }));
    const lines = treeSitterBashCapturesToThemedLines(code, captures);
    return verifyBashThemedLinesCoverage(code, lines) ? lines : null;
  } finally {
    tree.delete();
  }
};

const workerSelf = self as unknown as {
  addEventListener(type: 'message', listener: (event: MessageEvent<ITreeSitterBashRequest>) => void): void;
  postMessage(message: ITreeSitterBashResponse): void;
};

workerSelf.addEventListener('message', (event) => {
  const { id, code } = event.data;
  void tokenizeBash(code)
    .then((tokens) => {
      workerSelf.postMessage({ id, tokens });
    })
    .catch((error: unknown) => {
      workerSelf.postMessage({ id, tokens: null, error: error instanceof Error ? error.message : String(error) });
    });
});
`;

const HIGHLIGHTER_TS = String.raw`import type { IShikiThemedToken } from '@/services/editor/shiki-shared';
import { getBoundedCacheValue, setBoundedCacheValue } from '@/utils/core/lru-cache';
import { logger } from '@/utils/platform/logger';

const MAX_TOKENIZE_CACHE_ENTRIES = 16;
const MAX_TOKENIZE_CACHE_CODE_LENGTH = 200_000;
const TREE_SITTER_WORKER_TIMEOUT_MS = 4000;

type TResponse = { id: number; tokens: IShikiThemedToken[][] | null; error?: string };

let worker: Worker | null = null;
let workerBroken = false;
let nextRequestId = 1;
const tokenizeCache = new Map<string, IShikiThemedToken[][]>();

const cacheKey = (code: string): string => 'bash\u0000' + code;

const getCachedTokens = (code: string): IShikiThemedToken[][] | null => {
  if (code.length > MAX_TOKENIZE_CACHE_CODE_LENGTH) {
    return null;
  }
  return getBoundedCacheValue(tokenizeCache, cacheKey(code)) ?? null;
};

const cacheTokens = (code: string, tokens: IShikiThemedToken[][]): void => {
  if (code.length <= MAX_TOKENIZE_CACHE_CODE_LENGTH) {
    setBoundedCacheValue(tokenizeCache, cacheKey(code), tokens, MAX_TOKENIZE_CACHE_ENTRIES);
  }
};

const getWorker = (): Worker | null => {
  if (workerBroken || typeof Worker === 'undefined') {
    return null;
  }
  if (!worker) {
    try {
      worker = new Worker(new URL('./treesitter-bash.worker.ts', import.meta.url), { type: 'module' });
      worker.addEventListener('error', (event) => {
        workerBroken = true;
        logger.error({ event: 'treesitter.bash.worker.error', err: event.message });
        worker?.terminate();
        worker = null;
      });
    } catch (error) {
      workerBroken = true;
      logger.error({ event: 'treesitter.bash.worker.create_failed', err: error });
      return null;
    }
  }
  return worker;
};

export const isTreeSitterBashWorkerBroken = (): boolean => workerBroken;

/** Worker bash 高亮：不可用/失败/超时/覆盖校验未过 → 返回 null，调用方回退 Shiki。 */
export const tokenizeBashWithTreeSitterWorker = (code: string): Promise<IShikiThemedToken[][] | null> => {
  const cached = getCachedTokens(code);
  if (cached) {
    return Promise.resolve(cached);
  }
  const activeWorker = getWorker();
  if (!activeWorker) {
    return Promise.resolve(null);
  }

  const id = nextRequestId;
  nextRequestId += 1;

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    const cleanup = (): void => {
      clearTimeout(timeoutId);
      activeWorker.removeEventListener('message', handleMessage);
      activeWorker.removeEventListener('error', handleError);
    };
    const finish = (tokens: IShikiThemedToken[][] | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (tokens) {
        cacheTokens(code, tokens);
      }
      resolve(tokens);
    };
    const handleMessage = (event: MessageEvent<TResponse>): void => {
      if (event.data.id !== id) {
        return;
      }
      if (event.data.error || !event.data.tokens) {
        if (event.data.error) {
          logger.error({ event: 'treesitter.bash.worker.tokenize_failed', err: event.data.error });
        }
        finish(null);
        return;
      }
      finish(event.data.tokens);
    };
    const handleError = (event: ErrorEvent): void => {
      workerBroken = true;
      logger.error({ event: 'treesitter.bash.worker.runtime_failed', err: event.message });
      worker?.terminate();
      worker = null;
      finish(null);
    };
    timeoutId = setTimeout(() => {
      logger.error({ event: 'treesitter.bash.worker.timeout' });
      finish(null);
    }, TREE_SITTER_WORKER_TIMEOUT_MS);
    activeWorker.addEventListener('message', handleMessage);
    activeWorker.addEventListener('error', handleError);
    activeWorker.postMessage({ id, code });
  });
};
`;

const DISPATCH_TS = String.raw`import type { IShikiThemedToken } from '@/services/editor/shiki-shared';
import { resolveShikiLanguageId, tokenizeWithShikiWorker } from '@/services/editor/shiki-highlighter';
import { isTreeSitterBashEnabled } from '@/services/editor/treesitter-bash-flag';
import { tokenizeBashWithTreeSitterWorker } from '@/services/editor/treesitter-bash-highlighter';

// sh/shell/zsh/bash 都会被 resolveShikiLanguageId 归一为 'bash'。
const isBashLanguage = (language: string): boolean => resolveShikiLanguageId(language) === 'bash';

/**
 * 统一 token 源调度：bash 且 flag 开 → tree-sitter（同形状 token，失败回退 Shiki）；
 * 其它一律 Shiki。flag 关时与现状逐字节一致。编辑器与静态高亮两条路径都调它。
 */
export const tokenizeForLanguage = async (
  code: string,
  language: string,
): Promise<IShikiThemedToken[][] | null> => {
  if (isTreeSitterBashEnabled() && isBashLanguage(language)) {
    const tokens = await tokenizeBashWithTreeSitterWorker(code);
    if (tokens) {
      return tokens;
    }
  }
  return tokenizeWithShikiWorker(code, language);
};
`;

const FLAG_TS = String.raw`// 实验开关：默认关闭 → 全局行为与现状完全一致。后续把它接到 editorSettings 即可。
let enabled = false;
export const isTreeSitterBashEnabled = (): boolean => enabled;
export const setTreeSitterBashEnabled = (value: boolean): void => {
  enabled = value;
};
`;

const SPEC_TS = String.raw`import { describe, expect, it } from 'vitest';
import {
  resolveBashCaptureStyle,
  treeSitterBashCapturesToThemedLines,
  verifyBashThemedLinesCoverage,
} from './treesitter-bash-shared';

describe('resolveBashCaptureStyle', () => {
  it('精确命中 + 首段退化 + 未知返回 null', () => {
    expect(resolveBashCaptureStyle('comment')).toEqual({ color: '#6e7781', fontStyle: 1 });
    expect(resolveBashCaptureStyle('string.special')).toEqual({ color: '#0a3069' });
    expect(resolveBashCaptureStyle('totally.unknown')).toBeNull();
  });
});

describe('treeSitterBashCapturesToThemedLines', () => {
  it('UTF-8 字节偏移 → 正确切到中文字符（注释含多字节）', () => {
    const code = '# 注释\necho';
    const lines = treeSitterBashCapturesToThemedLines(code, [{ startByte: 0, endByte: 8, name: 'comment' }]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual([{ content: '# 注释', offset: 0, color: '#6e7781', fontStyle: 1 }]);
    expect(lines[1][0].content).toBe('echo');
    expect(verifyBashThemedLinesCoverage(code, lines)).toBe(true);
  });
});
`;

const NEW_FILES = [
  { path: `${EDITOR}/treesitter-bash-shared.ts`, content: SHARED_TS },
  { path: `${EDITOR}/treesitter-bash.worker.ts`, content: WORKER_TS },
  { path: `${EDITOR}/treesitter-bash-highlighter.ts`, content: HIGHLIGHTER_TS },
  { path: `${EDITOR}/editor-tokenize-dispatch.ts`, content: DISPATCH_TS },
  { path: `${EDITOR}/treesitter-bash-flag.ts`, content: FLAG_TS },
  { path: `${EDITOR}/treesitter-bash-shared.spec.ts`, content: SPEC_TS },
];

// ───────────────────────── 两处接线（唯一锚点，已对照源码核实） ─────────────────────────

const PATCHES = [
  {
    file: `${EDITOR}/codemirror-shiki-highlight.ts`,
    from: `import { tokenizeWithShikiWorker } from '@/services/editor/shiki-highlighter';`,
    to: `import { tokenizeForLanguage } from '@/services/editor/editor-tokenize-dispatch';`,
  },
  {
    file: `${EDITOR}/codemirror-shiki-highlight.ts`,
    from: `void tokenizeWithShikiWorker(request.code, request.language)`,
    to: `void tokenizeForLanguage(request.code, request.language)`,
  },
  {
    file: `${EDITOR}/codemirror-static-highlight.ts`,
    from: `import {\n  type IShikiThemedToken,\n  resolveShikiLanguageId,\n  SHIKI_BACKGROUND,\n  SHIKI_FOREGROUND,\n  tokenizeWithShikiWorker,\n} from '@/services/editor/shiki-highlighter';`,
    to: `import {\n  type IShikiThemedToken,\n  resolveShikiLanguageId,\n  SHIKI_BACKGROUND,\n  SHIKI_FOREGROUND,\n} from '@/services/editor/shiki-highlighter';\nimport { tokenizeForLanguage } from '@/services/editor/editor-tokenize-dispatch';`,
  },
  {
    file: `${EDITOR}/codemirror-static-highlight.ts`,
    from: `const lines = await tokenizeWithShikiWorker(code, language);`,
    to: `const lines = await tokenizeForLanguage(code, language);`,
  },
];

// ───────────────────────── 执行 ─────────────────────────

const applyPatches = async () => {
  const byFile = new Map();
  for (const p of PATCHES) (byFile.get(p.file) ?? byFile.set(p.file, []).get(p.file)).push(p);
  for (const [file, patches] of byFile) {
    const full = resolve(ROOT, file);
    let text = await readFile(full, 'utf8');
    const original = text;
    for (const p of patches) {
      const find = REVERT ? p.to : p.from;
      const repl = REVERT ? p.from : p.to;
      if (text.includes(repl) && !text.includes(find)) {
        console.log(`⏭  接线已是目标状态: ${file}`);
        continue;
      }
      const count = text.split(find).length - 1;
      if (count !== 1) {
        throw new Error(`✗ 锚点不唯一(${count}) 中止: ${file}\n   ${find.slice(0, 60)}...`);
      }
      text = text.replace(find, repl);
      console.log(`✓ 接线: ${file}`);
    }
    if (text !== original && WRITE) await writeFile(full, text, 'utf8');
  }
};

const run = async () => {
  if (REVERT) {
    await applyPatches();
    for (const f of NEW_FILES) {
      console.log(`✓ 删除新文件: ${f.path}`);
      if (WRITE) await rm(resolve(ROOT, f.path), { force: true });
    }
  } else {
    for (const f of NEW_FILES) {
      console.log(`✓ 写入新文件: ${f.path}`);
      if (WRITE) {
        await mkdir(dirname(resolve(ROOT, f.path)), { recursive: true });
        await writeFile(resolve(ROOT, f.path), f.content, 'utf8');
      }
    }
    await applyPatches();
  }
  console.log(`\n${WRITE ? '已写入' : 'DRY-RUN'}${REVERT ? '（还原模式）' : ''}`);
  if (!WRITE) console.log('加 --write 落盘；随后 pnpm lint && pnpm typecheck && pnpm test');
};

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});