#!/usr/bin/env node
/*
 * 残留门禁:扫描 legacy「plan/orchestrate」自研编排管线的残留引用。
 *
 * 设计:
 *  - 仅匹配动词族 orchestrate / orchestration;通过负向先行 (?!or) 排除完全
 *    无关的 TerminalRunOrchestrator(终端运行编排器,名词 *Orchestrator)。
 *      orchestrate    -> orchestrat + 'e'   命中
 *      orchestration  -> orchestrat + 'ion' 命中
 *      Orchestrator   -> orchestrat + 'or'  排除
 *  - 不剥离注释:stale 文档注释里的 orchestrate 也是要清的「新旧杂糅」,一并报。
 *  - 自排除 src/bindings(tauri-specta 生成物)与 scripts/refactor(改造脚本/本门禁自身)。
 *
 * 退出码:0 = 干净;2 = 仍有残留。可任意次幂等重跑。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, sep } from 'node:path';

const SCAN_DIRS = ['builtin-agent/src', 'src-tauri/src', 'src'];
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'target', '.git']);
const EXCLUDE_PATH_SUBSTRINGS = ['src/bindings', 'scripts/refactor'];

// 仅匹配动词族 orchestrate/orchestration;(?!or) 排除名词 "Orchestrator"。
const LEGACY_RE = /orchestrat(?!or)/i;

const toPosix = (p) => p.split(sep).join(posix.sep);

const isExcludedPath = (relPath) => {
  const norm = toPosix(relPath);
  return EXCLUDE_PATH_SUBSTRINGS.some((frag) => norm.includes(frag));
};

const walk = (dir, acc) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      walk(full, acc);
    } else if (entry.isFile()) {
      acc.push(full);
    }
  }
  return acc;
};

const hits = [];
for (const root of SCAN_DIRS) {
  try {
    statSync(root);
  } catch {
    continue;
  }
  for (const file of walk(root, [])) {
    if (isExcludedPath(file)) continue;
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    content.split(/\r?\n/).forEach((line, idx) => {
      if (LEGACY_RE.test(line)) {
        hits.push(`${toPosix(file)}:${idx + 1}: ${line.trim()}`);
      }
    });
  }
}

if (hits.length === 0) {
  console.log('【残留门禁:通过】无 legacy orchestrate/orchestration 引用。');
  process.exit(0);
}

console.error(`【残留门禁:未通过】仍有 ${hits.length} 处 legacy orchestrate 引用待清:\n`);
for (const hit of hits) console.error(hit);
console.error(
  '\n注:TerminalRunOrchestrator(终端运行编排器)为无关功能,已通过 (?!or) 先行排除,不计入。',
);
process.exit(2);
