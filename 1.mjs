// 1.mjs  —  P2 微优化（性能向，零行为变更）
//
//   ① src/services/editor/codemirror-static-highlight.ts
//      escapeHtml：3 次 replace 全量扫描 → 单遍 replace(/[&<>]/gu, fn)
//   ② src/utils/core/hash.ts
//      computeFnv1a32CodePoints：for...of → 索引遍历 codePointAt（hash 输出逐位一致）
//
// 用法（默认 dry-run）：
//   node 1.mjs            # 预览
//   node 1.mjs --write    # 写入
//   node 1.mjs --revert   # 回滚

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MODE = process.argv.includes('--write')
  ? 'write'
  : process.argv.includes('--revert')
    ? 'revert'
    : 'dry';

// 从 cwd / 脚本目录向上探测仓库根（含 src/utils/core/hash.ts 的目录）
const findRepoRoot = (startDirs) => {
  for (const start of startDirs) {
    let dir = start;
    for (let depth = 0; depth < 8; depth += 1) {
      if (existsSync(join(dir, 'src', 'utils', 'core', 'hash.ts'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
};

const REPO_ROOT = findRepoRoot([process.cwd(), __dirname]);
if (!REPO_ROOT) {
  console.error('✗ 未能定位仓库根目录（未找到 src/utils/core/hash.ts）。请在仓库内运行。');
  process.exit(1);
}
console.log(`仓库根：${REPO_ROOT}`);

/** @type {{file: string, before: string, after: string}[]} */
const EDITS = [
  // ① escapeHtml 单遍化
  {
    file: 'src/services/editor/codemirror-static-highlight.ts',
    before: `const escapeHtml = (value: string): string =>
  value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');`,
    after: `const escapeHtmlChar = (char: string): string =>
  char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;';

const escapeHtml = (value: string): string => value.replace(/[&<>]/gu, escapeHtmlChar);`,
  },

  // ② FNV-1a code-point 计算：for...of → 索引遍历（hash 输出逐位一致）
  {
    file: 'src/utils/core/hash.ts',
    before: `const computeFnv1a32CodePoints = (value: string): number => {
  let hash = 0x811c9dc5;
  // for...of 比 indexed loop 慢；但要正确处理 surrogate pair 又不破坏既有 hash 值，
  // 这里保留 code-point 语义。如需更快路径，使用 fnv1a32Bytes 走 UTF-8。
  for (const char of value) {
    // codePointAt 在 for...of 产生的非空字符串上必返回 number，无需 ?? 兜底。
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};`,
    after: `const computeFnv1a32CodePoints = (value: string): number => {
  let hash = 0x811c9dc5;
  // 索引遍历替代 for...of：避免字符串迭代器协议开销与逐 code point 子串分配。
  // 通过 codePointAt + 跳过低位代理项保持 code-point 语义，hash 输出与旧实现逐位一致。
  for (let i = 0; i < value.length; i += 1) {
    const codePoint = value.codePointAt(i)!;
    hash ^= codePoint;
    hash = Math.imul(hash, 0x01000193);
    if (codePoint > 0xffff) {
      // 完整 surrogate pair：跳过其低位代理项，避免重复计入。
      i += 1;
    }
  }
  return hash >>> 0;
};`,
  },
];

const countOccurrences = (haystack, needle) => {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
};

let changed = 0;
let skipped = 0;
let failed = 0;

for (const edit of EDITS) {
  const abs = join(REPO_ROOT, edit.file);
  const from = MODE === 'revert' ? edit.after : edit.before;
  const to = MODE === 'revert' ? edit.before : edit.after;

  let src;
  try {
    src = await readFile(abs, 'utf8');
  } catch (err) {
    console.error(`✗ 读取失败 ${edit.file}: ${err.message}`);
    failed += 1;
    continue;
  }

  if (!src.includes(from) && src.includes(to)) {
    console.log(`• 已是目标状态，跳过：${edit.file}`);
    skipped += 1;
    continue;
  }

  const hits = countOccurrences(src, from);
  if (hits !== 1) {
    console.error(`✗ 锚点未唯一命中（出现 ${hits} 次），跳过：${edit.file}`);
    failed += 1;
    continue;
  }

  const next = src.replace(from, to);
  if (MODE === 'dry') {
    console.log(`\n===== ${edit.file} (${MODE}) =====`);
    console.log('--- before ---\n' + from);
    console.log('--- after ----\n' + to);
    changed += 1;
    continue;
  }

  await writeFile(abs, next, 'utf8');
  console.log(`✓ ${MODE === 'revert' ? '已回滚' : '已写入'}：${edit.file}`);
  changed += 1;
}

console.log(`\n[${MODE}] 变更 ${changed} · 跳过 ${skipped} · 失败 ${failed}`);
if (failed > 0) process.exitCode = 1;