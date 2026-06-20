// fix-biome-and-ansi.mjs
// 修复 lefthook pre-commit 失败的三个问题
// 用法：node fix-biome-and-ansi.mjs [--dry-run]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const dryRun = process.argv.includes('--dry-run');

const replacements = (target, patch) => {
  const filePath = join(root, target);
  if (!existsSync(filePath)) {
    console.warn(`[skip] not found: ${target}`);
    return;
  }
  let src = readFileSync(filePath, 'utf8');
  let changed = false;
  for (const [oldStr, newStr] of patch) {
    if (typeof oldStr === 'string') {
      if (!src.includes(oldStr)) {
        console.warn(`[miss] ${target}\n  expected: ${oldStr.slice(0, 100)}...`);
        continue;
      }
      src = src.replace(oldStr, newStr);
      changed = true;
    } else if (oldStr instanceof RegExp) {
      if (!oldStr.test(src)) {
        console.warn(`[miss] ${target}\n  pattern: ${oldStr.source}`);
        continue;
      }
      src = src.replace(oldStr, newStr);
      changed = true;
    }
  }
  if (changed && !dryRun) writeFileSync(filePath, src, 'utf8');
  console.log(`${changed ? (dryRun ? '[dry-run]' : '[ok]') : '[no-change]'} ${target}`);
};

// ── 1. 回退 ANSI 正则：/\x1b/gu → new RegExp(String.fromCharCode(27), 'gu')
//    biome 的 noControlCharactersInRegex 规则禁止正则字面量中的控制字符
//    原来的 String.fromCharCode(27) 写法反而是合规的 ────────────────
replacements('src/store/terminal.ts', [
  [
    `const ANSI_ESCAPE_CHARACTER_PATTERN = /\\x1b/gu;`,
    `const ANSI_ESCAPE_CHARACTER_PATTERN = new RegExp(String.fromCharCode(27), 'gu');`,
  ],
]);

// ── 2. biome.json：schema 版本 2.4.16 → 2.5.0 ──────────────────────
replacements('biome.json', [
  [
    `"$schema": "https://biomejs.dev/schemas/2.4.16/schema.json"`,
    `"$schema": "https://biomejs.dev/schemas/2.5.0/schema.json"`,
  ],
]);

// ── 3. biome.json：recommended → preset（biome 2.5.0 语法） ────────
replacements('biome.json', [
  [
    `"recommended": true,`,
    `"preset": "recommended",`,
  ],
]);

console.log(dryRun ? '── dry-run complete, no files changed. ──' : '── fixes applied. ──');
console.log('');
console.log('建议接下来跑：');
console.log('  1. node fix-biome-and-ansi.mjs');
console.log('  2. pnpm biome check --write   # 让 biome 自动修复格式');
console.log('  3. git add -A && git commit -m "fix(core): 修复已知问题"');