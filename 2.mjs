#!/usr/bin/env node
// arch-cleanup.mjs
// 清理两处死配置（架构级审查第四轮）：
//   1) 从 package.json devDependencies 移除未使用的 dependency-cruiser
//   2) 从 vite.config.ts 删除死的 @copilotkit 分包 matcher，并修正过时注释
// 默认 dry-run，仅打印将做的改动；加 --apply 才写盘。幂等：已清理则报无操作。
//
// 用法：
//   node arch-cleanup.mjs            # 预览
//   node arch-cleanup.mjs --apply    # 落盘

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const ROOT = process.cwd();
let changed = 0;
let skipped = 0;

function log(tag, msg) {
  const c = { OK: '\x1b[32m', SKIP: '\x1b[33m', ERR: '\x1b[31m', INFO: '\x1b[36m' }[tag] || '';
  console.log(`${c}${tag}\x1b[0m ${msg}`);
}

async function readMaybe(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

// --- 1) package.json: 移除 dependency-cruiser -------------------------------
async function cleanPackageJson() {
  const file = path.join(ROOT, 'package.json');
  const raw = await readMaybe(file);
  if (raw == null) {
    log('ERR', 'package.json 未找到，跳过（请在仓库根目录运行）');
    return;
  }

  // 探测缩进（默认 2 空格）与是否带尾换行，写回时保持原样
  const indentMatch = raw.match(/\n([ \t]+)"/);
  const indent = indentMatch ? indentMatch[1] : '  ';
  const hadTrailingNewline = raw.endsWith('\n');

  const pkg = JSON.parse(raw);
  const dev = pkg.devDependencies || {};

  if (!('dependency-cruiser' in dev)) {
    log('SKIP', 'package.json: dependency-cruiser 不存在（已清理）');
    skipped++;
    return;
  }

  delete dev['dependency-cruiser'];
  let out = JSON.stringify(pkg, null, indent);
  if (hadTrailingNewline) out += '\n';

  if (APPLY) {
    await writeFile(file, out, 'utf8');
    log('OK', 'package.json: 已移除 devDependency "dependency-cruiser"（记得重跑 pnpm install 更新 lockfile）');
  } else {
    log('INFO', 'package.json: [dry-run] 将移除 devDependency "dependency-cruiser"');
  }
  changed++;
}

// --- 2) vite.config.ts: 删除死的 @copilotkit matcher + 修正注释 -------------
async function cleanViteConfig() {
  const file = path.join(ROOT, 'vite.config.ts');
  let src = await readMaybe(file);
  if (src == null) {
    log('ERR', 'vite.config.ts 未找到，跳过');
    return;
  }
  const before = src;

  // 2a) 删除 vendor-ai patterns 里的死 matcher（容忍单/双引号与其后逗号+空格）
  const deadMatcher = /(['"])\/node_modules\/@copilotkit\/\1,\s*/;
  if (deadMatcher.test(src)) {
    src = src.replace(deadMatcher, '');
  } else {
    log('SKIP', "vite.config.ts: 未找到 '@copilotkit/' 死 matcher（已清理）");
    skipped++;
  }

  // 2b) 修正 vendor-zod 的过时注释（把 @copilotkit/CopilotKit 改为真实消费者 ai）
  const staleComment =
    `  // zod 是首屏核心路径(tauri.contracts / store / IPC 工厂都用),但 @copilotkit\n` +
    `  // 也引用它,默认会被 Rollup 合进最大消费者 vendor-ai(2MB),导致首屏把整个\n` +
    `  // CopilotKit 也拽进来。这里单独拆出,既避免重复,也让 vendor-ai 退出首屏。\n`;
  const freshComment =
    `  // zod 是首屏核心路径(tauri.contracts / store / IPC 工厂都用),但 ai SDK\n` +
    `  // 也引用它,默认会被 Rollup 合进其消费者 vendor-ai,导致首屏把懒加载的 ai\n` +
    `  // 也拽进来。这里单独拆出,既避免重复,也让 vendor-ai 退出首屏。\n`;
  if (src.includes(staleComment)) {
    src = src.replace(staleComment, freshComment);
  } else if (src.includes('@copilotkit') || src.includes('CopilotKit')) {
    log('SKIP', 'vite.config.ts: 注释块与预期不完全一致，未自动改注释（请手动核对 @copilotkit 字样）');
    skipped++;
  }

  if (src === before) return;

  if (APPLY) {
    await writeFile(file, src, 'utf8');
    log('OK', 'vite.config.ts: 已删除死 matcher 并修正注释');
  } else {
    log('INFO', 'vite.config.ts: [dry-run] 将删除死 matcher 并修正注释');
  }
  changed++;
}

console.log(`\n=== arch-cleanup (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
await cleanPackageJson();
await cleanViteConfig();
console.log(`\n--- 完成：${changed} 处待改 / ${skipped} 处已是目标态 ---`);
if (!APPLY && changed > 0) console.log('预览无误后加 --apply 落盘。\n');