#!/usr/bin/env node
// fix-git-perf.mjs —— 复用已打开的 gix Repository，消除 git status / 分支列举热路径上的重复 gix::open
// 用法： node fix-git-perf.mjs [仓库根路径]    默认取当前工作目录
// 兼容 CRLF / LF 行尾：匹配时归一化为 LF，写回时还原原文件行尾风格。
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const repoRoot = process.argv[2] ?? process.cwd();

const FILES = {
  branches: 'src-tauri/src/commands/git/branches.rs',
  status: 'src-tauri/src/commands/git/status.rs',
};

// 所有 find/replace 一律用 LF 书写；脚本会按文件实际行尾自动适配。
const edits = [
  // ---- branches.rs ----
  {
    file: FILES.branches,
    find: `fn resolve_branch_upstream(repository_root: &Path, branch_name: &str) -> Option<String> {`,
    replace: `fn resolve_branch_upstream(repository: &Repository, branch_name: &str) -> Option<String> {`,
  },
  {
    file: FILES.branches,
    find: `    let repository = gix::open(repository_root).ok()?;\n    let config = repository.config_snapshot();`,
    replace: `    // 复用调用方已打开的 Repository，避免在 git status / 分支列举热路径上重复 gix::open。\n    let config = repository.config_snapshot();`,
  },
  {
    file: FILES.branches,
    find: `        let upstream_name = resolve_branch_upstream(repository_root, shorthand);\n        let (ahead, behind) = if is_current && upstream_name.is_some() {\n            resolve_ahead_behind_cli(repository_root, shorthand)?`,
    replace: `        let upstream_name = resolve_branch_upstream(repository, shorthand);\n        let (ahead, behind) = if is_current && upstream_name.is_some() {\n            resolve_ahead_behind_cli(repository, shorthand)?`,
  },
  {
    file: FILES.branches,
    find: `pub(super) fn resolve_ahead_behind_cli(\n    repository_root: &Path,\n    branch_name: &str,\n) -> Result<(usize, usize), String> {`,
    replace: `pub(super) fn resolve_ahead_behind_cli(\n    repository: &Repository,\n    branch_name: &str,\n) -> Result<(usize, usize), String> {`,
  },
  {
    file: FILES.branches,
    find: `    let repository =\n        gix::open(repository_root).map_err(|error| format!("打开 Git 仓库失败：{error}"))?;\n\n    let local_id = match repository.rev_parse_single(branch_name) {`,
    replace: `    // 复用调用方已打开的 Repository，避免在 git status 热路径上重复 gix::open。\n    let local_id = match repository.rev_parse_single(branch_name) {`,
  },
  {
    file: FILES.branches,
    find: `    let upstream_name = match resolve_branch_upstream(repository_root, branch_name) {`,
    replace: `    let upstream_name = match resolve_branch_upstream(repository, branch_name) {`,
  },
  // ---- status.rs ----
  {
    file: FILES.status,
    find: `        let (ahead, behind) = super::branches::resolve_ahead_behind_cli(&repository_root, branch)?;`,
    replace: `        let (ahead, behind) = super::branches::resolve_ahead_behind_cli(repository, branch)?;`,
  },
];

// 每个文件：原始文本、是否 CRLF、以及归一化为 LF 的工作副本
const state = new Map();
async function load(rel) {
  if (!state.has(rel)) {
    const raw = await readFile(resolve(repoRoot, rel), 'utf8');
    state.set(rel, { isCRLF: raw.includes('\r\n'), text: raw.replace(/\r\n/g, '\n') });
  }
  return state.get(rel);
}

let applied = 0;
for (const [i, e] of edits.entries()) {
  const st = await load(e.file);
  const n = st.text.split(e.find).length - 1; // find/replace 已是 LF，与归一化文本一致
  if (n !== 1) {
    throw new Error(`编辑 #${i + 1}（${e.file}）期望命中 1 处，实际 ${n} 处。请确认仓库在 main 且未被改动后重试。`);
  }
  st.text = st.text.replace(e.find, e.replace);
  applied += 1;
}

for (const [rel, st] of state) {
  const out = st.isCRLF ? st.text.replace(/\n/g, '\r\n') : st.text; // 还原原文件行尾
  await writeFile(resolve(repoRoot, rel), out, 'utf8');
}

console.log(`✅ 已应用 ${applied} 处修改，写回 ${state.size} 个文件（行尾风格已保留）：`);
for (const [rel, st] of state) console.log(`   - ${rel}  [${st.isCRLF ? 'CRLF' : 'LF'}]`);
console.log('\n下一步：cargo clippy && cargo test（git 模块），确认编译与单测通过。');