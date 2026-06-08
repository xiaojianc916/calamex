// scripts/apply-terminal-backlog-opt.mjs
//
// 终端「离屏输出 backlog」算法优化 codemod。
// 把 O(n²) 的全量字符串拼接换成复用 ring-buffer 的有界尾缓冲（append 均摊 O(1)、UTF-16 边界安全）。
//
// 特点：
//  - 只做精确锚点替换；任一锚点未命中或命中多次 => 报错并中止，不写入任何文件。
//  - 自动探测 session.ts 的换行符（LF/CRLF），所有替换与新建文件都跟随同一 EOL。
//  - 幂等：已应用的改动会被自动跳过。
//
// 用法（仓库根目录）：
//   node scripts/apply-terminal-backlog-opt.mjs
//   pnpm lint && pnpm typecheck && pnpm test src/utils/hidden-write-backlog.spec.ts

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';

const root = process.cwd();
const sessionPath = joinPath(root, 'src/terminal/session.ts');
const utilPath = joinPath(root, 'src/utils/hidden-write-backlog.ts');
const specPath = joinPath(root, 'src/utils/hidden-write-backlog.spec.ts');

if (!existsSync(sessionPath)) {
  console.error('✗ 未找到 src/terminal/session.ts，请在仓库根目录运行本脚本。');
  process.exit(1);
}

const original = readFileSync(sessionPath, 'utf8');
const eol = original.includes('\r\n') ? '\r\n' : '\n';
const j = (lines) => lines.join(eol);
const count = (hay, needle) => (needle === '' ? 0 : hay.split(needle).length - 1);

const utilSource = `import { createTerminalOutputBuffer } from '@/utils/terminal-output-buffer';

export type THiddenWriteBacklogOptions = {
  /** backlog 总字符上限（含省略提示标记）。 */
  maxChars: number;
  /** 单个内部 chunk 的最大字符数，用于合并细碎写入。 */
  maxChunkChars: number;
  /** 头部发生丢弃时，回灌内容前补上的可见提示标记。 */
  omittedMarker: string;
};

/**
 * 终端面板隐藏期间到达的输出先缓存在这里，待面板重新可见时一次性回灌。
 *
 * 旧实现用 previous + value 全量字符串拼接再 slice，在「离屏 + 高吞吐」场景下是
 * O(n²)（每个 chunk 复制整段 backlog）。这里复用 ring-buffer 风格的有界尾缓冲：
 * append 均摊 O(1)，超出预算时按 code point 边界从头部丢弃（不会劈开 UTF-16 代理对）；
 * 一旦发生丢弃，drain 时在最前面补上 omittedMarker，保持原有「已省略」的可见语义。
 */
export const createHiddenWriteBacklog = ({
  maxChars,
  maxChunkChars,
  omittedMarker,
}: THiddenWriteBacklogOptions) => {
  // 预留 marker 长度，保证补上提示后的总长度仍不超过 maxChars。
  const capacity = Math.max(0, maxChars - omittedMarker.length);
  const buffer = createTerminalOutputBuffer({
    maxLength: capacity,
    maxChunkLength: maxChunkChars,
  });
  let truncated = false;

  const append = (value: string): void => {
    if (!value) return;
    const lengthBefore = buffer.length;
    buffer.append(value);
    // 写入总量超过容量 => 头部一定发生了丢弃。
    if (lengthBefore + value.length > buffer.length) {
      truncated = true;
    }
  };

  const drain = (): string => {
    const body = buffer.toString();
    const result = truncated ? omittedMarker + body : body;
    buffer.clear();
    truncated = false;
    return result;
  };

  const clear = (): void => {
    buffer.clear();
    truncated = false;
  };

  return {
    /** 近似的已缓存字符数，仅供诊断展示。 */
    get length(): number {
      return truncated ? omittedMarker.length + buffer.length : buffer.length;
    },
    get isEmpty(): boolean {
      return buffer.length === 0 && !truncated;
    },
    append,
    drain,
    clear,
  };
};
`;

const specSource = `import { describe, expect, it } from 'vitest';
import { createHiddenWriteBacklog } from '@/utils/hidden-write-backlog';

const MARKER = '<<omitted>>';

describe('hidden write backlog', () => {
  it('未超预算时原样累积并回灌', () => {
    const backlog = createHiddenWriteBacklog({
      maxChars: 1000,
      maxChunkChars: 64,
      omittedMarker: MARKER,
    });
    expect(backlog.isEmpty).toBe(true);
    backlog.append('hello ');
    backlog.append('world');
    expect(backlog.isEmpty).toBe(false);
    expect(backlog.drain()).toBe('hello world');
    expect(backlog.isEmpty).toBe(true);
  });

  it('超出预算时丢弃头部并补上省略提示', () => {
    const backlog = createHiddenWriteBacklog({
      maxChars: MARKER.length + 6,
      maxChunkChars: 4,
      omittedMarker: MARKER,
    });
    backlog.append('1234');
    backlog.append('5678');
    backlog.append('90');
    const drained = backlog.drain();
    expect(drained.startsWith(MARKER)).toBe(true);
    expect(drained.slice(MARKER.length)).toBe('567890');
  });

  it('裁剪不会劈开 UTF-16 代理对', () => {
    const backlog = createHiddenWriteBacklog({
      maxChars: MARKER.length + 3,
      maxChunkChars: 16,
      omittedMarker: MARKER,
    });
    backlog.append('a😀b');
    expect(backlog.drain()).toBe(MARKER + '😀b');
  });

  it('drain / clear 后状态复位', () => {
    const backlog = createHiddenWriteBacklog({
      maxChars: 50,
      maxChunkChars: 8,
      omittedMarker: MARKER,
    });
    backlog.append('abc');
    expect(backlog.drain()).toBe('abc');
    expect(backlog.isEmpty).toBe(true);
    backlog.append('xyz');
    backlog.clear();
    expect(backlog.isEmpty).toBe(true);
    expect(backlog.drain()).toBe('');
  });
});
`;

// session.ts 精确锚点替换：from/to 用「行数组」表示，运行时按目标 EOL join。
const edits = [
  {
    name: 'import',
    from: ["} from '@/utils/window-resize-events';"],
    to: [
      "} from '@/utils/window-resize-events';",
      "import { createHiddenWriteBacklog } from '@/utils/hidden-write-backlog';",
    ],
  },
  {
    name: 'const:chunk-chars',
    from: ['const TERMINAL_HIDDEN_WRITE_BACKLOG_MAX_CHARS = 512 * 1024;'],
    to: [
      'const TERMINAL_HIDDEN_WRITE_BACKLOG_MAX_CHARS = 512 * 1024;',
      'const TERMINAL_HIDDEN_WRITE_BACKLOG_CHUNK_CHARS = 8 * 1024;',
    ],
  },
  {
    name: 'field',
    from: [
      "  private _bufferedTerminalWrite = '';",
      "  private _hiddenTerminalWriteBacklog = '';",
    ],
    to: [
      "  private _bufferedTerminalWrite = '';",
      '  private readonly _hiddenWriteBacklog = createHiddenWriteBacklog({',
      '    maxChars: TERMINAL_HIDDEN_WRITE_BACKLOG_MAX_CHARS,',
      '    maxChunkChars: TERMINAL_HIDDEN_WRITE_BACKLOG_CHUNK_CHARS,',
      '    omittedMarker: TERMINAL_HIDDEN_WRITE_BACKLOG_OMITTED_MARKER,',
      '  });',
    ],
  },
  {
    name: 'remove:_appendHiddenTerminalWriteBacklog',
    from: [
      '  private _appendHiddenTerminalWriteBacklog(value: string): void {',
      '    if (!value) return;',
      '',
      '    const previous = this._hiddenTerminalWriteBacklog.startsWith(',
      '      TERMINAL_HIDDEN_WRITE_BACKLOG_OMITTED_MARKER,',
      '    )',
      '      ? this._hiddenTerminalWriteBacklog.slice(',
      '          TERMINAL_HIDDEN_WRITE_BACKLOG_OMITTED_MARKER.length,',
      '        )',
      '      : this._hiddenTerminalWriteBacklog;',
      '    const combined = `${previous}${value}`;',
      '    if (combined.length <= TERMINAL_HIDDEN_WRITE_BACKLOG_MAX_CHARS) {',
      '      this._hiddenTerminalWriteBacklog = combined;',
      '      return;',
      '    }',
      '',
      '    const tailBudget = Math.max(',
      '      0,',
      '      TERMINAL_HIDDEN_WRITE_BACKLOG_MAX_CHARS -',
      '        TERMINAL_HIDDEN_WRITE_BACKLOG_OMITTED_MARKER.length,',
      '    );',
      '    this._hiddenTerminalWriteBacklog = `${TERMINAL_HIDDEN_WRITE_BACKLOG_OMITTED_MARKER}${combined.slice(',
      '      Math.max(0, combined.length - tailBudget),',
      '    )}`;',
      '  }',
    ],
    to: [],
  },
  {
    name: 'queue:not-visible',
    from: ['      this._appendHiddenTerminalWriteBacklog(normalizedValue);'],
    to: ['      this._hiddenWriteBacklog.append(normalizedValue);'],
  },
  {
    name: 'flush:not-visible',
    from: ['        this._appendHiddenTerminalWriteBacklog(this._bufferedTerminalWrite);'],
    to: ['        this._hiddenWriteBacklog.append(this._bufferedTerminalWrite);'],
  },
  {
    name: 'flush:merge',
    from: [
      '    if (this._hiddenTerminalWriteBacklog) {',
      '      this._bufferedTerminalWrite = `${this._hiddenTerminalWriteBacklog}${this._bufferedTerminalWrite}`;',
      "      this._hiddenTerminalWriteBacklog = '';",
    ],
    to: [
      '    if (!this._hiddenWriteBacklog.isEmpty) {',
      '      this._bufferedTerminalWrite = `${this._hiddenWriteBacklog.drain()}${this._bufferedTerminalWrite}`;',
    ],
  },
  {
    name: 'handleBecomeVisible',
    from: [
      '    if (this._hiddenTerminalWriteBacklog) {',
      '      this._shouldFitBeforeNextVisibleWrite = true;',
    ],
    to: [
      '    if (!this._hiddenWriteBacklog.isEmpty) {',
      '      this._shouldFitBeforeNextVisibleWrite = true;',
    ],
  },
  {
    name: 'diagnostic',
    from: ['      hiddenBacklogChars: this._hiddenTerminalWriteBacklog.length,'],
    to: ['      hiddenBacklogChars: this._hiddenWriteBacklog.length,'],
  },
  {
    name: 'ensureConnect:reset',
    from: [
      "        this._bufferedTerminalWrite = '';",
      "        this._hiddenTerminalWriteBacklog = '';",
      '        this._pendingScrollToBottomAfterWrite = false;',
    ],
    to: [
      "        this._bufferedTerminalWrite = '';",
      '        this._hiddenWriteBacklog.clear();',
      '        this._pendingScrollToBottomAfterWrite = false;',
    ],
  },
  {
    name: 'detach:reset',
    from: [
      "    this._bufferedTerminalWrite = '';",
      "    this._hiddenTerminalWriteBacklog = '';",
      '    this._pendingTerminalWriteCallbacks.length = 0;',
    ],
    to: [
      "    this._bufferedTerminalWrite = '';",
      '    this._hiddenWriteBacklog.clear();',
      '    this._pendingTerminalWriteCallbacks.length = 0;',
    ],
  },
];

let next = original;
const applied = [];
const skipped = [];

for (const edit of edits) {
  const from = j(edit.from);
  const to = j(edit.to);
  if (to !== '' && next.includes(to)) {
    skipped.push(edit.name);
    continue;
  }
  const n = count(next, from);
  if (n === 0) {
    if (edit.to.length === 0) {
      skipped.push(edit.name);
      continue;
    }
    console.error(`✗ 锚点未命中：${edit.name}（session.ts 可能已变化，未写入任何文件）`);
    process.exit(1);
  }
  if (n !== 1) {
    console.error(`✗ 锚点命中 ${n} 次（期望 1）：${edit.name}，已中止。`);
    process.exit(1);
  }
  next = next.replace(from, to);
  applied.push(edit.name);
}

// 折叠多余空行（与 Biome「最多 1 个空行」一致），清理删除方法后留下的空隙。
next = next.replace(/(\r?\n){3,}/g, eol + eol);

const writeWithEol = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n/g, eol);
  writeFileSync(path, normalized, 'utf8');
};

writeWithEol(utilPath, utilSource);
writeWithEol(specPath, specSource);
if (next !== original) writeFileSync(sessionPath, next, 'utf8');

console.log('✓ src/utils/hidden-write-backlog.ts');
console.log('✓ src/utils/hidden-write-backlog.spec.ts');
console.log(
  `✓ session.ts：应用 ${applied.length} 处${skipped.length ? `，跳过 ${skipped.length} 处（已应用）` : ''}`,
);
if (applied.length) console.log('   ' + applied.join(', '));
console.log('下一步：pnpm lint && pnpm typecheck && pnpm test src/utils/hidden-write-backlog.spec.ts');