#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const filePath = 'src-tauri/src/commands/git/branches.rs';
const absolutePath = resolve(root, filePath);

const fail = (message) => {
  throw new Error(`[${filePath}] ${message}`);
};

const source = readFileSync(absolutePath, 'utf8');

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
const functionText = source.slice(functionStart, functionEnd);
const afterFunction = source.slice(functionEnd);

if (functionText.includes('if is_current && upstream_name.is_some()')) {
  console.log('Round7 branch-list optimization already applied.');
  process.exit(0);
}

const blockStartNeedle = '    let (ahead, behind, upstream_name) = if kind == "local" {';
const blockStart = functionText.indexOf(blockStartNeedle);
if (blockStart === -1) {
  fail('找不到 ahead/behind 分支计算块开始');
}

const blockEndNeedle = '\n\n    let last_commit = repository';
const blockEnd = functionText.indexOf(blockEndNeedle, blockStart);
if (blockEnd === -1) {
  fail('找不到 ahead/behind 分支计算块结束锚点');
}

const oldBlock = functionText.slice(blockStart, blockEnd);

if (!oldBlock.includes('resolve_branch_upstream(repository_root, shorthand)')) {
  fail('ahead/behind 块内找不到 upstream 解析逻辑，停止以避免误改');
}

if (!oldBlock.includes('resolve_ahead_behind_cli(repository_root, shorthand)')) {
  fail('ahead/behind 块内找不到 resolve_ahead_behind_cli 调用，停止以避免误改');
}

const newBlock = `    let (ahead, behind, upstream_name) = if kind == "local" {
        let upstream_name = resolve_branch_upstream(repository_root, shorthand);
        // 分支列表可能包含大量本地分支；逐个分支计算 ahead/behind 会对每个
        // upstream 分支做两次 rev_walk。当前 UI 只需要完整展示当前分支的同步状态，
        // 非当前分支保留 upstream / last_commit 信息即可，避免打开分支面板时卡顿。
        let (ahead, behind) = if is_current && upstream_name.is_some() {
            resolve_ahead_behind_cli(repository_root, shorthand)?
        } else {
            (0, 0)
        };
        (ahead, behind, upstream_name)
    } else {
        (0, 0, None)
    };`;

const nextFunctionText =
  functionText.slice(0, blockStart) + newBlock + functionText.slice(blockEnd);

const nextSource = beforeFunction + nextFunctionText + afterFunction;
writeFileSync(absolutePath, nextSource, 'utf8');

console.log('Applied round7 branch-list optimization with structural repair.');
console.log('');
console.log('Touched:');
console.log(` - ${filePath}`);
console.log('');
console.log('Next:');
console.log('  cd src-tauri && cargo fmt && cargo check');
console.log('  pnpm lint');
console.log('  pnpm typecheck');
console.log('');
console.log('Rollback:');
console.log(`  git checkout -- ${filePath}`);