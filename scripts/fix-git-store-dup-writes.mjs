#!/usr/bin/env node
// scripts/fix-git-store-dup-writes.mjs
// 去重 src/store/git.ts 中重复的 writePersistedPullRequestList 写盘调用。
// 用法: node scripts/fix-git-store-dup-writes.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));

// 从脚本所在目录向上查找包含 src/store/git.ts 的仓库根目录。
const findTargetFile = () => {
  let dir = scriptDir;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, 'src', 'store', 'git.ts');
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // 继续向上
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('未能定位 src/store/git.ts，请在仓库内运行此脚本。');
};

const detectEol = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

const countOccurrences = (haystack, needle) => {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
};

// 锚点严格匹配，count===1 才替换；0=已修复跳过；>1=有歧义，中止。
const applyEdit = (source, eol, label, fromLines, toLines) => {
  const from = fromLines.join(eol);
  const to = toLines.join(eol);
  const count = countOccurrences(source, from);
  if (count === 0) return { source, changed: false };
  if (count > 1) {
    throw new Error(`[${label}] 匹配到 ${count} 处锚点，存在歧义，已中止，请人工核对。`);
  }
  return { source: source.replace(from, to), changed: true };
};

const target = findTargetFile();
const original = readFileSync(target, 'utf8');
const eol = detectEol(original);

let next = original;
let applied = 0;
let skipped = 0;

// 修复点 ①：applyPullRequestSummaryMutation 内 for 循环里的连续重复写盘。
{
  const result = applyEdit(next, eol, 'mutation-loop',
    [
      '      nextFetchedAt[cacheKey] = now;',
      '      writePersistedPullRequestList(cacheKey, nextCache[cacheKey], now);',
      '      writePersistedPullRequestList(cacheKey, nextCache[cacheKey], now);',
    ],
    [
      '      nextFetchedAt[cacheKey] = now;',
      '      writePersistedPullRequestList(cacheKey, nextCache[cacheKey], now);',
    ],
  );
  next = result.source;
  result.changed ? (applied += 1) : (skipped += 1);
}

// 修复点 ②：loadPullRequests 成功回调里跨行重复的写盘。
{
  const result = applyEdit(next, eol, 'load-then',
    [
      '        writePersistedPullRequestList(cacheKey, nextPayload, fetchedAt);',
      '        clearPullRequestListRevalidateFailure(cacheKey);',
      '        writePersistedPullRequestList(cacheKey, nextPayload, fetchedAt);',
    ],
    [
      '        writePersistedPullRequestList(cacheKey, nextPayload, fetchedAt);',
      '        clearPullRequestListRevalidateFailure(cacheKey);',
    ],
  );
  next = result.source;
  result.changed ? (applied += 1) : (skipped += 1);
}

if (next === original) {
  console.log('无需改动：未发现重复写盘（可能已修复）。');
} else {
  writeFileSync(target, next, 'utf8');
  console.log(`已更新 ${target}`);
}
console.log(`应用 ${applied} 处，跳过 ${skipped} 处。`);