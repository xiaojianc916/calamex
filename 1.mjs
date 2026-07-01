#!/usr/bin/env node
// codemod-drop-dead-token-log-migration.mjs
// 用途：删除 storage_paths.rs::migrate_legacy_storage() 里针对 builtin-agent.token /
//       builtin-agent.log(.old) 的 rename_within——这些是旧 HTTP 服务遗物：
//       现行 ACP stdio 边车不写 token（stdio 无鉴权）、日志走 stderr（见 builtin-agent
//       acp/stdio-entry.ts），Rust 侧也无任何读/写方。保留仍在用的 node-compile-cache 改名。
// 设计：单行锚点逐行删除、删前唯一性校验、幂等（已删则跳过）、任一冲突整体不写盘、dry-run 默认。
// 用法：node scripts/codemod-drop-dead-token-log-migration.mjs [repoRoot] [--write]
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
const eol = src.includes('\r\n') ? '\r\n' : '\n';

// 删除含 anchor 的整行（含行首缩进与行尾换行，CRLF/LF 通吃）；不存在=视为已删，跳过。
function deleteLine(name, anchor) {
  const i = src.indexOf(anchor);
  if (i === -1) { console.log('· ' + name + '：未见该行（可能已删除），跳过。'); return; }
  if (src.indexOf(anchor, i + anchor.length) !== -1) { console.error('✗ ' + name + '：锚点不唯一，拒删。'); hadError = true; return; }
  const ls = src.lastIndexOf('\n', i);
  const lineStart = ls === -1 ? 0 : ls + 1;
  const nl = src.indexOf('\n', i);
  const lineEnd = nl === -1 ? src.length : nl + 1;
  src = src.slice(0, lineStart) + src.slice(lineEnd);
  console.log('✓ ' + name + '：已删除。');
}

deleteLine('token 死改名', 'rename_within(&new_service, "builtin-agent.token", "auth.token");');
deleteLine('log 死改名', 'rename_within(&new_service, "builtin-agent.log", "service.log");');
deleteLine('log.old 死改名', 'rename_within(&new_service, "builtin-agent.log.old", "service.log.old");');

// 更新已不准确的注释（此处不再规整 token/log，只剩 node 编译缓存）。
const oldComment = '        // 整目录迁移后，再把目录内的旧文件名规整为按功能命名。';
if (src.includes('故删除那几条僵尸改名')) {
  console.log('· 注释：已更新，跳过。');
} else if (src.includes(oldComment)) {
  const newComment =
    '        // 整目录迁移后，把仍在用的 node 编译缓存目录名规整为按功能命名。' + eol +
    '        // 注：原先还把 builtin-agent.token/.log 规整为 auth.token/service.log，但那些是旧 HTTP' + eol +
    '        // 服务遗物；现行 ACP stdio 边车不写 token（stdio 无鉴权）、日志走 stderr（见 stdio-entry.ts），' + eol +
    '        // 故删除那几条僵尸改名，避免给死文件维护更好听的名字。';
  src = src.replace(oldComment, newComment);
  console.log('✓ 注释：已更新。');
} else {
  console.log('· 注释：未见旧文案，跳过（非致命）。');
}

if (hadError) { console.error('\n⚠ 有锚点不唯一，未写入。请人工核对。'); process.exit(2); }
if (src === before) { console.log('\n无改动（可能已全部删除）。'); process.exit(0); }
if (!WRITE) { console.log('\n[dry-run] 预览完成，未写盘。确认后加 --write 落盘。'); process.exit(0); }
writeFileSync(abs, src, 'utf8');
console.log('✓ 已写入 ' + rel + '。必做自检：cd src-tauri && cargo build && cargo test storage_paths');