#!/usr/bin/env node
// scripts/codemod/step7-fix-export-normalize.mjs
//
// 修复: hydrate.ts (7.3) 的 normalizeActiveThreadId 未 export, 但 project.ts (7.4a)
// 第 2 行 import 了它 → 运行时 SyntaxError:
//   "does not provide an export named 'normalizeActiveThreadId'"
//
// 编辑 (仅一个文件):
//   src/store/aiThread/hydrate.ts
//     function normalizeActiveThreadId(  →  export function normalizeActiveThreadId(
//
// 幂等: 若已是 export 形式则跳过, 退出 0。
//
// 用法:
//   node scripts/codemod/step7-fix-export-normalize.mjs --check
//   node scripts/codemod/step7-fix-export-normalize.mjs
//   REPO_ROOT=/path node scripts/codemod/step7-fix-export-normalize.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(process.env.REPO_ROOT ?? process.cwd());
const CHECK = new Set(process.argv.slice(2)).has('--check');

const log = (...a) => console.log('[step7-fix]', ...a);
const fail = (msg) => {
  console.error('[step7-fix] ✗', msg);
  process.exit(1);
};

const TARGET = 'src/store/aiThread/hydrate.ts';
const FIND = 'function normalizeActiveThreadId(';
const REPLACE = 'export function normalizeActiveThreadId(';
const ALREADY = 'export function normalizeActiveThreadId(';

const run = () => {
  log('REPO_ROOT =', REPO_ROOT);
  log(CHECK ? '模式: --check (干跑)' : '模式: 写入');

  const abs = join(REPO_ROOT, TARGET);
  if (!existsSync(abs)) {
    fail(`缺少 ${TARGET}。`);
  }

  const before = readFileSync(abs, 'utf8');

  if (before.includes(ALREADY)) {
    log(`✓ ${TARGET} 已是 export 形式, 跳过 (无操作)。`);
    return;
  }

  const occurrences = before.split(FIND).length - 1;
  if (occurrences !== 1) {
    fail(`锚点 "${FIND}" 预期出现 1 次, 实际 ${occurrences} 次; 未写入。`);
  }

  const next = before.replace(FIND, () => REPLACE);
  if (next === before) {
    fail('替换后内容无变化, 异常; 未写入。');
  }

  if (CHECK) {
    log(`  [将修改] ${TARGET} (${before.length} → ${next.length} bytes)`);
    log('✓ --check 通过, 未写入。');
    return;
  }

  writeFileSync(abs, next, { encoding: 'utf8' });
  log('  ✓ 写入', TARGET);
  log('✓ 完成。下一步: pnpm typecheck && pnpm lint && pnpm test');
};

run();