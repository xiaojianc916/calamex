#!/usr/bin/env node
// codemod-refresh-rename-within-test.mjs
// 用途：脚本 5 删掉了 builtin-agent.token/.log 的死迁移，但单测
//       rename_within_normalizes_file_name 仍拿这对死名当夹具（doc-rot）：
//       grep auth.token 仍命中、且这条单测在“测一个已不存在的迁移场景”。
//       把夹具改指到仍在用的 .node-compile-cache -> node-compile-cache，
//       保持对 rename_within helper 的覆盖，同时清干净死名。
// 设计：单行锚点、逐条唯一性校验、幂等、任一冲突整体不写盘、dry-run 默认。
// 用法：node scripts/codemod-refresh-rename-within-test.mjs [repoRoot] [--write]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WRITE = process.argv.includes('--write');
const posArgs = process.argv.slice(2).filter((a) => a !== '--write');
const ROOT = posArgs[0] ? resolve(posArgs[0]) : process.cwd();
const rel = 'src-tauri/src/storage_paths.rs';
const abs = join(ROOT, rel);
if (!existsSync(abs)) { console.error('✗ 找不到 ' + rel); process.exit(1); }

let src = readFileSync(abs, 'utf8');
const before = src;
let hadError = false;

// 单行替换：needle 不含换行，CRLF/LF 通吃；已是新写法则跳过；要求唯一命中。
function replaceLine(name, needle, replacement) {
  if (src.includes(replacement) && !src.includes(needle)) {
    console.log('· ' + name + '：已是新写法，跳过。');
    return;
  }
  const i = src.indexOf(needle);
  if (i === -1) { console.error('✗ ' + name + '：未命中锚点，文件已漂移，拒改。'); hadError = true; return; }
  if (src.indexOf(needle, i + needle.length) !== -1) { console.error('✗ ' + name + '：锚点不唯一，拒改。'); hadError = true; return; }
  src = src.slice(0, i) + replacement + src.slice(i + needle.length);
  console.log('✓ ' + name + '：已更新。');
}

replaceLine('夹具写入',
  'fs::write(dir.join("builtin-agent.token"), b"tok").unwrap();',
  'fs::write(dir.join(".node-compile-cache"), b"cache").unwrap();');
replaceLine('改名调用',
  'rename_within(&dir, "builtin-agent.token", "auth.token");',
  'rename_within(&dir, ".node-compile-cache", "node-compile-cache");');
replaceLine('断言-新名存在',
  'assert!(dir.join("auth.token").exists());',
  'assert!(dir.join("node-compile-cache").exists());');
replaceLine('断言-旧名消失',
  'assert!(!dir.join("builtin-agent.token").exists());',
  'assert!(!dir.join(".node-compile-cache").exists());');

if (hadError) { console.error('\n⚠ 有锚点未命中/不唯一，未写入。请人工核对。'); process.exit(2); }
if (src === before) { console.log('\n无改动（可能已全部更新）。'); process.exit(0); }
if (!WRITE) { console.log('\n[dry-run] 预览完成，未写盘。确认后加 --write 落盘。'); process.exit(0); }
writeFileSync(abs, src, 'utf8');
console.log('✓ 已写入 ' + rel + '。必做自检：cd src-tauri && cargo test storage_paths');