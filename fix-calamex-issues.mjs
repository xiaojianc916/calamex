#!/usr/bin/env node
/**
 * calamex 编译错误修复脚本 — 3 errors + 1 warning
 * 这些是仓库中已存在的问题，不是之前补丁引入的。
 * 用法: node fix-compile-errors.mjs [仓库根目录]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(process.argv[2] ?? 'D:\\com.xiaojianc\\my_desktop_app');

function getEol(raw) {
  return raw.includes('\r\n') ? '\r\n' : '\n';
}
function writeFile(fullPath, content, eol) {
  writeFileSync(fullPath, content.replace(/\n/g, eol), 'utf-8');
}

function patchAscii(filePath, patches) {
  const fullPath = join(repoRoot, filePath);
  const raw = readFileSync(fullPath, 'utf-8');
  const eol = getEol(raw);
  let content = raw.replace(/\r\n/g, '\n');
  for (const { name, find, replace } of patches) {
    const f = find.replace(/\r\n/g, '\n');
    const r = replace.replace(/\r\n/g, '\n');
    const idx = content.indexOf(f);
    if (idx === -1) throw new Error(`not found: ${name}`);
    if (content.indexOf(f, idx + 1) !== -1) throw new Error(`multiple matches: ${name}`);
    content = content.slice(0, idx) + r + content.slice(idx + f.length);
    console.log(`  ok: ${name}`);
  }
  writeFile(fullPath, content, eol);
}

// ═══════════════════════════════════════════
// 1. search/mod.rs — 缺少 if let Err(error) = 前缀
// ═══════════════════════════════════════════

patchAscii('src-tauri/src/commands/search/mod.rs', [
  {
    name: 'spawn missing if let Err(error) =',
    // 匹配函数体中 spawn 前缺少的 if let Err(error) =
    find: `    std::thread::Builder::new()
        .name("search-index-prewarm".into())
        .spawn(move || {`,
    replace: `    if let Err(error) = std::thread::Builder::new()
        .name("search-index-prewarm".into())
        .spawn(move || {`,
  },
]);

// ═══════════════════════════════════════════
// 2. contracts/mod.rs — 缺少 pub use secret::*
// ═══════════════════════════════════════════

patchAscii('src-tauri/src/commands/contracts/mod.rs', [
  {
    name: 'add pub use secret::* re-export',
    find: `pub use script::*;\npub use skills::*;`,
    replace: `pub use script::*;\npub use secret::*;\npub use skills::*;`,
  },
]);

// ═══════════════════════════════════════════
// 3. terminal/commands.rs — cancel_terminal_run 的 unused app
// ═══════════════════════════════════════════

patchAscii('src-tauri/src/commands/terminal/commands.rs', [
  {
    name: 'rename unused app to _app in cancel_terminal_run',
    find: `pub async fn cancel_terminal_run(
    app: AppHandle,`,
    replace: `pub async fn cancel_terminal_run(
    _app: AppHandle,`,
  },
]);

console.log('\nDone. Verify with: cargo build');