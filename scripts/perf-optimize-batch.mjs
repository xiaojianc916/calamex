#!/usr/bin/env node
// scripts/perf-optimize-batch.mjs
// 批量应用「干净低风险」性能优化（幂等、可重复执行）。
// 用法：
//   node scripts/perf-optimize-batch.mjs --dry   # 仅预览，不写文件
//   node scripts/perf-optimize-batch.mjs         # 实际写入
//
// 覆盖：
//   [1] 将 markstream-vue/index.css 移出首屏 styles.css，改由引用 markstream-vue
//       的组件（AI 面板懒加载）随包按需加载。
//   [2] emitIpcLog：常规 info 审计日志仅在 DEV 输出，避免生产环境每次 IPC 调用
//       都对整条 record 做 JSON.stringify + console。
//   [7] 删除 vite.config.ts 中指向不存在文件的 manualChunks 死规则。

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const DRY = process.argv.includes('--dry');
const ROOT = process.cwd();
const results = [];
const log = (file, status, detail) => results.push({ file, status, detail });

async function patchFile(relPath, mutate) {
  const abs = join(ROOT, relPath);
  let original;
  try {
    original = await readFile(abs, 'utf8');
  } catch {
    log(relPath, 'MISSING', '文件不存在，跳过');
    return;
  }
  const next = mutate(original);
  if (next == null || next === original) {
    log(relPath, 'SKIP', '无需修改（可能已应用）');
    return;
  }
  if (!DRY) await writeFile(abs, next, 'utf8');
  log(relPath, DRY ? 'WOULD-WRITE' : 'WRITTEN', '已修改');
}

async function listVueFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listVueFiles(full)));
    else if (e.isFile() && e.name.endsWith('.vue')) out.push(full);
  }
  return out;
}

const MS_CSS = 'markstream-vue/index.css';

// ── [1] styles.css：移除 markstream-vue/index.css 的 @import ──────────────
await patchFile('src/styles.css', (src) => {
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  const kept = lines.filter(
    (l) => l.trim() !== `@import '${MS_CSS}';` && l.trim() !== `@import "${MS_CSS}";`,
  );
  return kept.length === lines.length ? null : kept.join(eol);
});

// ── [1b] 在引用 markstream-vue 组件的 .vue 内注入 CSS 副作用 import ────────
let injected = 0;
for (const abs of await listVueFiles(join(ROOT, 'src'))) {
  const rel = relative(ROOT, abs).split('\\').join('/');
  // eslint-disable-next-line no-await-in-loop
  await patchFile(rel, (src) => {
    if (!/from\s+['"]markstream-vue['"]/.test(src)) return null; // 不引用 markstream-vue
    if (src.includes(`'${MS_CSS}'`) || src.includes(`"${MS_CSS}"`)) return null; // 已注入
    const m = src.match(/<script\b[^>]*>/);
    if (!m) return null;
    const eol = src.includes('\r\n') ? '\r\n' : '\n';
    const at = m.index + m[0].length;
    const snippet =
      `${eol}// markdown 节点样式仅 AI 面板需要：随本组件（懒加载）按需加载，` +
      `不再进首屏 styles.css。${eol}import '${MS_CSS}';`;
    injected += 1;
    return src.slice(0, at) + snippet + src.slice(at);
  });
}
if (injected === 0) log('(markstream 组件)', 'NOTE', '未找到引用 markstream-vue 的 .vue，或已注入');

// ── [2] tauri.ipc-runtime.ts：emitIpcLog DEV 守卫 ─────────────────────────
const IPC_OLD = `const emitIpcLog = (record: IIpcLogRecord): void => {
  const serialized = JSON.stringify(record);
  if (record.outcome === 'error') {
    console.error(serialized);
    return;
  }

  console.info(serialized);
};`;
const IPC_NEW = `const emitIpcLog = (record: IIpcLogRecord): void => {
  // 错误始终输出；常规 info 审计日志仅在开发环境序列化并打印，避免生产环境
  // 每次 IPC 调用都对整条 record 做 JSON.stringify 并写 console。
  if (record.outcome === 'error') {
    console.error(JSON.stringify(record));
    return;
  }

  if (import.meta.env.DEV) {
    console.info(JSON.stringify(record));
  }
};`;
await patchFile('src/services/tauri.ipc-runtime.ts', (src) => {
  if (src.includes('if (import.meta.env.DEV) {')) return null; // 已应用
  return src.includes(IPC_OLD) ? src.replace(IPC_OLD, IPC_NEW) : null; // 结构已变则交人工
});

// ── [7] vite.config.ts：删除 fig-shell-command-catalog 死规则 ─────────────
await patchFile('vite.config.ts', (src) => {
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  const kept = lines.filter(
    (l) => l.trim() !== "normalizedId.includes('/src/generated/fig-shell-command-catalog.ts') ||",
  );
  return kept.length === lines.length ? null : kept.join(eol);
});

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log(`\n性能优化批处理 ${DRY ? '(dry-run)' : ''}`);
for (const r of results) console.log(`  [${r.status}] ${r.file} — ${r.detail}`);
console.log('\n完成。建议随后执行：pnpm typecheck && pnpm test && pnpm build');