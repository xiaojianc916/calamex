#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

const filePath = 'src-tauri/src/commands/git/branches.rs';
const absolutePath = resolve(root, filePath);

const read = () => readFileSync(absolutePath, 'utf8');
const write = (text) => writeFileSync(absolutePath, text, 'utf8');

const fail = (message) => {
  throw new Error(`[${filePath}] ${message}`);
};

const oldBlock = `    let (ahead, behind, upstream_name) = if kind == "local" {
        let upstream_name = resolve_branch_upstream(repository_root, shorthand);
        let (ahead, behind) = if upstream_name.is_some() {
            resolve_ahead_behind_cli(repository_root, shorthand)?
        } else {
            (0, 0)
        };
        (ahead, behind, upstream_name)
    } else {
        (0, 0, None)
    };
`;

const newBlock = `    let (ahead, behind, upstream_name) = if kind == "local" {
        let upstream_name = resolve_branch_upstream(repository_root, shorthand);
        // 分支列表可能包含大量本地分支；逐个分支计算 ahead/behind 会对每个
        // upstream 分支做两次 rev_walk，打开分支面板时容易形成 O(branches * history)
        // 的卡顿。当前 UI 只需要完整展示当前分支的同步状态，非当前分支保留
        // upstream / last_commit 信息即可，避免无意义的提交图遍历。
        let (ahead, behind) = if is_current && upstream_name.is_some() {
            resolve_ahead_behind_cli(repository_root, shorthand)?
        } else {
            (0, 0)
        };
        (ahead, behind, upstream_name)
    } else {
        (0, 0, None)
    };
`;

let source = read();

if (source.includes(newBlock)) {
  console.log('Round7 branch-list optimization already applied.');
  process.exit(0);
}

const count = source.split(oldBlock).length - 1;
if (count !== 1) {
  fail(`branch ahead/behind block: expected 1 match, got ${count}`);
}

source = source.replace(oldBlock, newBlock);
write(source);

console.log('Applied round7 branch-list optimization.');
console.log('');
console.log('Touched:');
console.log(` - ${filePath}`);
console.log('');
console.log('Why:');
console.log(' - Avoids per-branch ahead/behind rev_walk for non-current branches.');
console.log(' - Keeps current branch sync state and visible branch list behavior intact.');
console.log('');
console.log('Next:');
console.log('  pnpm lint');
console.log('  pnpm typecheck');
console.log('  cd src-tauri && cargo fmt && cargo test && cargo clippy');
console.log('');
console.log('Rollback:');
console.log(`  git checkout -- ${filePath}`);