#!/usr/bin/env node
// scripts/migrate-builtin-agent.mjs   (Node >= 26, 仓库根目录运行)
//
// A. agent-sidecar 包 → builtin-agent:目录 / 包名 / env / Rust 符号 / 路径字面量
// B. P3:前端移除 ai + @ai-sdk/deepseek;'ai' 的 LanguageModelUsage → '@/types/ai' 的 IAiLanguageModelUsage
//
// 用法:
//   node scripts/migrate-builtin-agent.mjs          # 应用(要求 git 工作区干净,便于回滚)
//   node scripts/migrate-builtin-agent.mjs --dry    # 仅预览
//   node scripts/migrate-builtin-agent.mjs --force  # 跳过 git 干净检查
//
// 跑完务必本地过闸(我这边沙箱无网,无法替你跑):
//   pnpm install
//   pnpm typecheck && pnpm lint && pnpm test
//   cargo clippy --manifest-path src-tauri/Cargo.toml && cargo test --manifest-path src-tauri/Cargo.toml
//   pnpm guard && pnpm tauri:build      # 验证打包路径(resources-bundle/builtin-agent)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const SELF = fileURLToPath(import.meta.url);
const flags = new Set(process.argv.slice(2));
const DRY = flags.has('--dry');
const FORCE = flags.has('--force');
const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('⚠️ ', ...a);

// ---- 0. 前置校验 ----------------------------------------------------------
const rootPkgPath = path.join(ROOT, 'package.json');
if (!fs.existsSync(rootPkgPath) || !/"name"\s*:\s*"calamex"/.test(fs.readFileSync(rootPkgPath, 'utf8'))) {
  console.error('✗ 请在 calamex 仓库根目录运行。'); process.exit(1);
}
if (!DRY && !FORCE) {
  let dirty = '';
  try { dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }); }
  catch { console.error('✗ 无法执行 git;确认无误可加 --force。'); process.exit(1); }
  if (dirty.trim()) { console.error('✗ git 工作区不干净。请先提交/暂存(便于 `git checkout .` 回滚),或加 --force。'); process.exit(1); }
}

// ---- 遍历器 ---------------------------------------------------------------
const TEXT_EXT = new Set(['.ts','.tsx','.mts','.cts','.js','.mjs','.cjs','.jsx','.vue','.json','.jsonc','.json5','.yaml','.yml','.toml','.rs','.md','.mdx','.html','.css','.scss','.env','.sh','.txt','.conf','.cfg']);
const EXCLUDE_DIRS = new Set(['.git','node_modules','dist','build','coverage','.turbo','.vite','.cache','target']);
const EXCLUDE_FILES = new Set(['pnpm-lock.yaml','Cargo.lock','package-lock.json','yarn.lock']);
function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (!EXCLUDE_DIRS.has(ent.name)) walk(fp, out); }
    else if (ent.isFile()) {
      if (fp === SELF || EXCLUDE_FILES.has(ent.name) || !TEXT_EXT.has(path.extname(ent.name))) continue;
      out.push(fp);
    }
  }
  return out;
}

// ---- A1. 目录重命名(保留 git 历史) -------------------------------------
const oldDir = path.join(ROOT, 'agent-sidecar');
const newDir = path.join(ROOT, 'builtin-agent');
if (fs.existsSync(oldDir)) {
  if (fs.existsSync(newDir)) { console.error('✗ builtin-agent 已存在,手动处理。'); process.exit(1); }
  log('• agent-sidecar/ → builtin-agent/');
  if (!DRY) {
    try { execFileSync('git', ['mv', 'agent-sidecar', 'builtin-agent'], { cwd: ROOT, stdio: 'inherit' }); }
    catch { warn('git mv 失败,回退 fs.rename(丢失重命名追踪)。'); fs.renameSync(oldDir, newDir); }
  }
} else if (fs.existsSync(newDir)) { log('• 目录已是 builtin-agent/(幂等跳过)。'); }
else { warn('未找到 agent-sidecar/ 与 builtin-agent/,仅做文本替换。'); }

// ---- A2. 全仓 token 替换 -------------------------------------------------
// 顺序:scoped/大写在前,通用在后(literal 全量替换,互不冲突)。
// 刻意不碰裸 "sidecar":Tauri 打包语义(.sidecar()/externalBin)与前端
// ai:sidecar-stream 事件通道(P6)需另行处理,见末尾报告。
const TOKENS = [
  ['@xiaojianc/agent-sidecar', '@xiaojianc/builtin-agent'],
  ['XIAOJIANC_AGENT_SIDECAR_ROOT', 'XIAOJIANC_BUILTIN_AGENT_ROOT'],
  ['AGENT_SIDECAR_', 'BUILTIN_AGENT_'],          // MODEL/API_KEY/BASE_URL/OBSERVER_MODEL/REFLECTOR_MODEL/DEEPSEEK_PROVIDER_ID/UNAVAILABLE/...
  ['resolve_sidecar_root', 'resolve_builtin_agent_root'],
  ['build_sidecar_env', 'build_builtin_agent_env'],
  ['sidecar_runtime_dir', 'builtin_agent_runtime_dir'],
  ['SIDECAR_ROOT_ENV', 'BUILTIN_AGENT_ROOT_ENV'],
  ['agent-sidecar', 'builtin-agent'],
  ['agent_sidecar', 'builtin_agent'],
];
let renameChanged = 0;
for (const fp of walk(ROOT)) {
  let txt = fs.readFileSync(fp, 'utf8'); const before = txt;
  for (const [from, to] of TOKENS) if (txt.includes(from)) txt = txt.split(from).join(to);
  if (txt !== before) { renameChanged++; if (!DRY) fs.writeFileSync(fp, txt); log(`  A ✎ ${path.relative(ROOT, fp)}`); }
}
log(`• 重命名改动文件:${renameChanged}`);

// ---- B1. 根 package.json 去依赖 -----------------------------------------
{
  const pkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
  const removed = [];
  for (const dep of ['ai', '@ai-sdk/deepseek'])
    if (pkg.dependencies?.[dep] !== undefined) { delete pkg.dependencies[dep]; removed.push(dep); }
  if (removed.length) { log(`• 移除前端依赖:${removed.join(', ')}`); if (!DRY) fs.writeFileSync(rootPkgPath, JSON.stringify(pkg, null, 2) + '\n'); }
  else log('• ai / @ai-sdk/deepseek 已不在前端依赖(跳过)。');
}

// ---- B2. 前端 'ai' 类型 import 改写(仅 src/,不动 builtin-agent 自己的 ai 依赖) ----
const SRC = path.join(ROOT, 'src');
const aiImportRe = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]ai['"];?/g;
const manualReview = [];
let p3Files = 0;
for (const fp of (fs.existsSync(SRC) ? walk(SRC) : []).filter(f => /\.(ts|tsx|mts|cts|vue)$/.test(f))) {
  let txt = fs.readFileSync(fp, 'utf8'); let touched = false;
  txt = txt.replace(aiImportRe, (full, names) => {
    const ids = names.split(',').map(s => s.trim().replace(/^type\s+/, '')).filter(Boolean);
    if (ids.length === 1 && ids[0] === 'LanguageModelUsage') { touched = true; return `import type { IAiLanguageModelUsage } from '@/types/ai';`; }
    manualReview.push(`${path.relative(ROOT, fp)} :: { ${ids.join(', ')} } from 'ai'`);
    return full; // 含其它符号 → 留给人工
  });
  if (touched) {
    txt = txt.replace(/\bLanguageModelUsage\b/g, 'IAiLanguageModelUsage'); // \b 不会命中 IAiLanguageModelUsage(前为 'i')
    p3Files++; if (!DRY) fs.writeFileSync(fp, txt); log(`  B ✎ ${path.relative(ROOT, fp)}`);
  }
}

// ---- C. 残留 "sidecar" 报告(不改,供人工判定) --------------------------
log('\n— 残留 "sidecar"(Tauri 打包语义=保留;前端 sidecar-events / ai:sidecar-stream=P6 行为重构,勿在此 PR 改)—');
let residual = 0;
for (const fp of walk(ROOT)) {
  const rel = path.relative(ROOT, fp);
  fs.readFileSync(fp, 'utf8').split('\n').forEach((ln, i) => {
    if (/sidecar/i.test(ln)) { residual++; if (residual <= 200) log(`  ${rel}:${i + 1}: ${ln.trim().slice(0, 120)}`); }
  });
}

// ---- 摘要 ----------------------------------------------------------------
log('\n=== 摘要 ===');
log(`A 重命名改动文件: ${renameChanged}`);
log(`B P3 改写文件:    ${p3Files}`);
log(`残留 sidecar 行:  ${residual}`);
if (manualReview.length) { warn("以下 'ai' import 含其它符号,需人工处理:"); manualReview.forEach(m => log('   - ' + m)); }
log(DRY ? '\n(--dry 预览,未写盘)' : '\n✓ 已写盘。git diff 复核 → 跑闸 → squash 提交到 main。');