#!/usr/bin/env node
// codemod-move-node-compile-cache.mjs
// 用途：把 Node 编译缓存从「塔在 feature 目录」的 ~/.calamex/ai-service/node-compile-cache
//       移到「按类别」的 ~/.calamex/cache/node-compile。编译缓存可丢弃（Node 会在新位置重建），
//       故不搬数据、不加迁移、不 bump schema 水位——顺序无关，跑几次都幂等。
//   - launch.rs：重定向 NODE_COMPILE_CACHE 落点，并删掉随之变死的 builtin_agent_runtime_dir()。
//   - storage_paths.rs：删掉 ai-service 内那条已错位的 rename_within(.node-compile-cache)。
// 设计：单行锚点 + 唯一性校验；函数块用「按文件实际 EOL 拼多行 needle」删除（CRLF/LF 通吃）；
//       任一未命中整体不写盘（原子）、幂等、纯 std、dry-run 默认。
// 用法：node scripts/codemod-move-node-compile-cache.mjs [repoRoot] [--write]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WRITE = process.argv.includes('--write');
const posArgs = process.argv.slice(2).filter((a) => a !== '--write');
const ROOT = posArgs[0] ? resolve(posArgs[0]) : process.cwd();

let hadError = false;
const plans = [];
const eolOf = (t) => (t.includes('\r\n') ? '\r\n' : '\n');

function replaceOnce(ctx, name, needle, replacement, doneMark) {
  if (ctx.src.includes(doneMark)) { console.log('· [' + ctx.rel + '] ' + name + '：已是新写法，跳过。'); return; }
  const i = ctx.src.indexOf(needle);
  if (i === -1) { console.error('✗ [' + ctx.rel + '] ' + name + '：未命中锚点，请人工核对。'); hadError = true; return; }
  if (ctx.src.indexOf(needle, i + needle.length) !== -1) { console.error('✗ [' + ctx.rel + '] ' + name + '：锚点不唯一，拒绝盲改。'); hadError = true; return; }
  ctx.src = ctx.src.slice(0, i) + replacement + ctx.src.slice(i + needle.length);
  console.log('✓ [' + ctx.rel + '] ' + name + '：已更新。');
}

// 删除含 anchor 的整行（含行首缩进与行尾换行，CRLF/LF 通吃）；不存在=视为已删，跳过。
function deleteLine(ctx, name, anchor) {
  const i = ctx.src.indexOf(anchor);
  if (i === -1) { console.log('· [' + ctx.rel + '] ' + name + '：未见该行（可能已删除），跳过。'); return; }
  if (ctx.src.indexOf(anchor, i + anchor.length) !== -1) { console.error('✗ [' + ctx.rel + '] ' + name + '：锚点不唯一，拒删。'); hadError = true; return; }
  const ls = ctx.src.lastIndexOf('\n', i);
  const lineStart = ls === -1 ? 0 : ls + 1;
  const nl = ctx.src.indexOf('\n', i);
  const lineEnd = nl === -1 ? ctx.src.length : nl + 1;
  ctx.src = ctx.src.slice(0, lineStart) + ctx.src.slice(lineEnd);
  console.log('✓ [' + ctx.rel + '] ' + name + '：已删除。');
}

// 删除多行块（按文件实际 EOL 拼 needle，唯一性校验）；已删则跳过。
function deleteBlock(ctx, name, lines, aliveMark) {
  if (aliveMark && !ctx.src.includes(aliveMark)) { console.log('· [' + ctx.rel + '] ' + name + '：未见（可能已删除），跳过。'); return; }
  const eol = eolOf(ctx.src);
  const needle = lines.join(eol) + eol + eol; // 连同其后一空行一并删除，避免留双空行
  const i = ctx.src.indexOf(needle);
  if (i === -1) { console.error('✗ [' + ctx.rel + '] ' + name + '：未命中块锚点，请人工核对。'); hadError = true; return; }
  if (ctx.src.indexOf(needle, i + needle.length) !== -1) { console.error('✗ [' + ctx.rel + '] ' + name + '：块锚点不唯一，拒删。'); hadError = true; return; }
  ctx.src = ctx.src.slice(0, i) + ctx.src.slice(i + needle.length);
  console.log('✓ [' + ctx.rel + '] ' + name + '：已删除。');
}

function processFile(rel, fn) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) { console.error('✗ 找不到 ' + rel); hadError = true; return; }
  const ctx = { rel, src: readFileSync(abs, 'utf8') };
  const before = ctx.src;
  fn(ctx);
  if (ctx.src !== before) plans.push({ abs, rel, content: ctx.src });
}

// 1) launch.rs：重定向 NODE_COMPILE_CACHE 落点 + 删除变死的 builtin_agent_runtime_dir()
processFile('src-tauri/src/acp/launch.rs', (ctx) => {
  replaceOnce(ctx, 'NODE_COMPILE_CACHE 落点',
    'path_to_string(&builtin_agent_runtime_dir().join("node-compile-cache")),',
    'path_to_string(&crate::storage_paths::local_root().join("cache").join("node-compile")),',
    'local_root().join("cache").join("node-compile")),');
  deleteBlock(ctx, 'builtin_agent_runtime_dir 死函数',
    [
      '/// 运行时可写目录：统一落到品牌根 `.calamex/ai-service`（与 `storage_paths` 一致）。',
      'fn builtin_agent_runtime_dir() -> PathBuf {',
      '    crate::storage_paths::local_root().join("ai-service")',
      '}',
    ],
    'fn builtin_agent_runtime_dir() -> PathBuf {');
  // NODE_COMPILE_CACHE 文档去掉「与旧路径一致」（已改路径，非致命）
  const docOld = '`NODE_COMPILE_CACHE`：复用编译缓存，缩短冷启动（与旧路径一致）；';
  const docNew = '`NODE_COMPILE_CACHE`：复用编译缓存，缩短冷启动（落 cache/node-compile）；';
  if (ctx.src.includes(docNew)) { console.log('· [launch.rs] NODE_COMPILE_CACHE 文档：已更新，跳过。'); }
  else if (ctx.src.includes(docOld)) { ctx.src = ctx.src.replace(docOld, docNew); console.log('✓ [launch.rs] NODE_COMPILE_CACHE 文档：已更新。'); }
  else { console.log('· [launch.rs] NODE_COMPILE_CACHE 文档：未见旧文案，跳过（非致命）。'); }
});

// 2) storage_paths.rs：删除已错位的 rename_within(.node-compile-cache) + 修正注释
processFile('src-tauri/src/storage_paths.rs', (ctx) => {
  deleteLine(ctx, 'ai-service 内缓存改名',
    'rename_within(&new_service, ".node-compile-cache", "node-compile-cache");');
  // 注释：node 缓存已移至 cache/node-compile（launch.rs），此处只剩整目录迁移
  const cOld = '        // 整目录迁移后，把仍在用的 node 编译缓存目录名规整为按功能命名。';
  const cNew = '        // 整目录迁移：把旧 builtin-agent 运行时目录搬到 ai-service（node 编译缓存已改落 cache/node-compile，见 launch.rs）。';
  if (ctx.src.includes(cNew)) { console.log('· [storage_paths.rs] 注释：已更新，跳过。'); }
  else if (ctx.src.includes(cOld)) { ctx.src = ctx.src.replace(cOld, cNew); console.log('✓ [storage_paths.rs] 注释：已更新。'); }
  else { console.log('· [storage_paths.rs] 注释：未见旧文案，跳过（非致命）。'); }
});

if (hadError) { console.error('\n⚠ 有锚点未命中/不唯一，未做任何写入。请人工核对后重跑。'); process.exit(2); }
if (plans.length === 0) { console.log('\n全部已是新写法，无需改动。'); process.exit(0); }
if (!WRITE) { console.log('\n[dry-run] 预览完成，未写盘。确认后加 --write 落盘。'); process.exit(0); }
for (const p of plans) { writeFileSync(p.abs, p.content, 'utf8'); console.log('✓ 已写入 ' + p.rel); }
console.log('\n✓ 完成。必做自检：cd src-tauri && cargo build && cargo test');