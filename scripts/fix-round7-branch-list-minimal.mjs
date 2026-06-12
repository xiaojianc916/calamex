#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const filePath = 'src-tauri/src/commands/git/branches.rs';
const absolutePath = resolve(root, filePath);

const fail = (message) => {
  throw new Error(`[${filePath}] ${message}`);
};

let source = readFileSync(absolutePath, 'utf8');

if (source.includes('if is_current && upstream_name.is_some()')) {
  console.log('Round7 branch-list optimization already applied.');
  process.exit(0);
}

const functionName = 'fn build_git_branch_payload_from_ref(';
const functionStart = source.indexOf(functionName);
if (functionStart === -1) {
  fail(`找不到函数 ${functionName}`);
}

const functionBodyStart = source.indexOf('{', functionStart);
if (functionBodyStart === -1) {
  fail('找不到 build_git_branch_payload_from_ref 函数体开始');
}

let depth = 0;
let functionEnd = -1;
for (let index = functionBodyStart; index < source.length; index += 1) {
  const char = source[index];
  if (char === '{') depth += 1;
  if (char === '}') {
    depth -= 1;
    if (depth === 0) {
      functionEnd = index + 1;
      break;
    }
  }
}

if (functionEnd === -1) {
  fail('找不到 build_git_branch_payload_from_ref 函数体结束');
}

const beforeFunction = source.slice(0, functionStart);
let functionText = source.slice(functionStart, functionEnd);
const afterFunction = source.slice(functionEnd);

const oldConditionPattern =
  /let\s*\(\s*ahead\s*,\s*behind\s*\)\s*=\s*if\s+upstream_name\.is_some\(\)\s*\{\s*[\r\n]+\s*resolve_ahead_behind_cli\s*\(\s*repository_root\s*,\s*shorthand\s*\)\?/;

const match = functionText.match(oldConditionPattern);
if (!match) {
  fail('找不到可安全替换的 upstream_name.is_some ahead/behind 条件');
}

const oldText = match[0];
const newText = oldText.replace(
  /if\s+upstream_name\.is_some\(\)/,
  'if is_current && upstream_name.is_some()',
);

functionText = functionText.replace(oldText, newText);

const commentNeedle = '逐个分支计算 ahead/behind';
if (!functionText.includes(commentNeedle)) {
  functionText = functionText.replace(
    newText,
    `// 分支列表可能包含大量本地分支；非当前分支不在 UI 展示 ahead/behind，避免逐个分支计算 ahead/behind 造成卡顿。\n        ${newText}`,
  );
}

source = beforeFunction + functionText + afterFunction;
writeFileSync(absolutePath, source, 'utf8');

console.log('Applied minimal round7 branch-list optimization.');
console.log('');
console.log('Changed:');
console.log(' - Only current local branch computes ahead/behind in branch list.');
console.log('');
console.log('Next:');
console.log('  cd src-tauri && cargo fmt && cargo check');
console.log('  pnpm lint');
console.log('  pnpm typecheck');
console.log('');
console.log('Rollback:');
console.log(`  git checkout -- ${filePath}`);