#!/usr/bin/env node
/**
 * scripts/migrate-terminal-domain.mjs
 * 领域化迁移 — 第 1 域：terminal。
 * 把分散在 6+ 处的 terminal 代码收敛到 src/domains/terminal/，并：
 *   1) 全仓库重写 import / export…from / 动态 import() / vi.mock / new URL / require 引用；
 *   2) 同步 check-terminal-singleton 白名单 与 file-size 基线路径；
 *   3) 生成桶文件 src/domains/terminal/index.ts；
 *   4) 扫描 scripts/ 与配置里残留的旧路径字面量并“报告”（不擅自改）。
 *
 *   node scripts/migrate-terminal-domain.mjs          # 预览(dry-run，不写盘)
 *   node scripts/migrate-terminal-domain.mjs --apply  # 执行
 *
 * 设计原则：
 *   - 最小 diff：同组同迁的相对 import 保持相对、绝不无谓改成别名；只重写真正会断的引用。
 *   - 只搬纯 terminal；跨域组合根 / IO 边界 / 生成物不在本期。
 *   - 只搬文件 + 改引用字符串，不动任何运行时逻辑，零用户体验影响。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const log = (tag, msg) => console.log(`[${tag}] ${msg}`);
const toPosix = (p) => p.replace(/\\/g, '/');
const abs = (rel) => path.join(ROOT, rel);
const exists = (rel) => fs.existsSync(abs(rel));
const read = (rel) => fs.readFileSync(abs(rel), 'utf-8');

if (!exists('package.json') || !exists('src')) {
  console.error('请在仓库根目录运行（缺少 package.json / src）。');
  process.exit(1);
}

// ─── 1) 迁移映射（显式、可审阅） ───────────────────────────────────────────────
const GROUPS = [
  { to: 'src/domains/terminal/core', files: [
    'src/terminal/registry.ts', 'src/terminal/run-visual-sequencer.ts',
    'src/terminal/session-ansi.ts', 'src/terminal/session-constants.ts',
    'src/terminal/session-helpers.ts', 'src/terminal/session-types.ts',
    'src/terminal/session.ts', 'src/terminal/terminal-write-buffer.ts',
  ]},
  { to: 'src/domains/terminal/services', files: [
    'src/services/terminal/eventBus.ts', 'src/services/terminal/eventBus.ack.spec.ts',
    'src/services/terminal/facade.ts', 'src/services/terminal/facade.spec.ts',
    'src/services/terminal/runOrchestrator.ts', 'src/services/terminal/runOrchestrator.spec.ts',
    'src/services/terminal/state.ts',
  ]},
  { to: 'src/domains/terminal/utils', files: [
    'src/utils/terminal/shell-completion.ts', 'src/utils/terminal/shell-completion.spec.ts',
    'src/utils/terminal/shfmt.ts', 'src/utils/terminal/shfmt.worker.ts',
    'src/utils/terminal/startup-shell.ts', 'src/utils/terminal/startup-shell.spec.ts',
    'src/utils/terminal/terminal-output-buffer.ts', 'src/utils/terminal/terminal-output-buffer.spec.ts',
    'src/utils/terminal/terminal-run.ts', 'src/utils/terminal/terminal-run.spec.ts',
  ]},
  { to: 'src/domains/terminal/state', files: [
    'src/store/terminal.ts', 'src/store/terminal.store.spec.ts',
    'src/store/terminalRunRouting.ts', 'src/store/terminalRunRouting.store.spec.ts',
    'src/store/terminalTabs.ts', 'src/store/terminalTabs.store.spec.ts',
  ]},
  { to: 'src/domains/terminal/composables', files: [
    'src/composables/useIntegratedTerminal.ts',
    'src/composables/useTerminalRun.ts', 'src/composables/useTerminalRun.lifecycle.spec.ts',
    'src/composables/useTerminalRunControl.ts', 'src/composables/useTerminalRunControl.spec.ts',
  ]},
  { to: 'src/domains/terminal/ui', files: [
    'src/components/workbench/EmbeddedTerminal.vue',
    'src/components/workbench/TerminalTabBar.vue',
  ]},
];

/** Map<oldRel, newRel> */
const moveMap = new Map();
for (const g of GROUPS) for (const f of g.files) moveMap.set(f, `${g.to}/${path.posix.basename(f)}`);

// 预检：所有源文件必须存在（取证一致性）
const missing = [...moveMap.keys()].filter((r) => !exists(r));
if (missing.length) {
  console.error('以下登记文件不存在（仓库已变化，请更新 GROUPS 后重试）：');
  missing.forEach((m) => console.error('  - ' + m));
  process.exit(1);
}

// ─── 2) 引用解析 + 重写 ────────────────────────────────────────────────────────
const RESOLVE_EXTS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.vue', '.css', '.json',
  '/index.ts', '/index.tsx', '/index.mts', '/index.js'];
const HAS_EXT_RE = /\.(ts|tsx|mts|cts|js|mjs|vue|css|json)$/;
const STRIP_EXT_RE = /\.(ts|tsx|mts|cts|js|mjs)$/;

function resolveSpec(importerRel, spec) {
  let base;
  if (spec.startsWith('@/')) base = 'src/' + spec.slice(2);
  else if (spec.startsWith('./') || spec.startsWith('../')) base = toPosix(path.posix.join(path.posix.dirname(importerRel), spec));
  else return null; // 裸模块 / 第三方
  for (const ext of RESOLVE_EXTS) if (exists(base + ext)) return toPosix(base + ext);
  return null;
}

/** 计算新 specifier；返回 null 表示无需改动 */
function buildNewSpec(importerOldRel, spec, targetOldRel) {
  const importerNew = moveMap.get(importerOldRel) ?? importerOldRel;
  const targetNew = moveMap.get(targetOldRel) ?? targetOldRel;
  if (importerNew === importerOldRel && targetNew === targetOldRel) return null; // 两端都没动

  const hadExt = HAS_EXT_RE.test(spec);
  let emit = hadExt ? targetNew : targetNew.replace(STRIP_EXT_RE, '').replace(/\/index$/, '');

  if (spec.startsWith('@/')) return '@/' + emit.slice('src/'.length);
  let rel = path.posix.relative(path.posix.dirname(importerNew), emit);
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

const SPEC_RES = [
  /(\bfrom\s*)(['"])([^'"\n]+)(['"])/g,          // import…from / export…from
  /(\bimport\s*\(\s*)(['"])([^'"\n]+)(['"])/g,    // 动态 import()
  /(\bimport\s+)(['"])([^'"\n]+)(['"])/g,         // 副作用 import 'x'
  /(\brequire\s*\(\s*)(['"])([^'"\n]+)(['"])/g,   // require()
  /(\bnew\s+URL\s*\(\s*)(['"])([^'"\n]+)(['"])/g, // new URL('./x', import.meta.url)
  /(\bvi\.(?:mock|doMock|unmock|importActual|importMock)\s*\(\s*)(['"])([^'"\n]+)(['"])/g,
];

function rewrite(importerOldRel, content) {
  let changed = false;
  for (const re of SPEC_RES) {
    content = content.replace(re, (m, pre, q, spec, q2) => {
      const target = resolveSpec(importerOldRel, spec);
      if (!target) return m;
      const ns = buildNewSpec(importerOldRel, spec, target);
      if (!ns || ns === spec) return m;
      changed = true;
      return `${pre}${q}${ns}${q2}`;
    });
  }
  return { content, changed };
}

// ─── 3) 遍历 src，计算所有改动 ─────────────────────────────────────────────────
const CODE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.vue']);
const SKIP_DIR = new Set(['node_modules', 'dist', 'target', '.git']);
function walk(relDir, acc = []) {
  for (const name of fs.readdirSync(abs(relDir))) {
    if (SKIP_DIR.has(name)) continue;
    const rel = toPosix(path.posix.join(relDir, name));
    if (fs.statSync(abs(rel)).isDirectory()) walk(rel, acc);
    else if (CODE_EXT.has(path.extname(name))) acc.push(rel);
  }
  return acc;
}

const plannedWrites = []; // { oldRel, newRel, content }
let rewriteOnlyCount = 0, moveCount = 0;
for (const oldRel of walk('src')) {
  const newRel = moveMap.get(oldRel) ?? oldRel;
  const { content, changed } = rewrite(oldRel, read(oldRel));
  if (newRel !== oldRel) { plannedWrites.push({ oldRel, newRel, content }); moveCount++; }
  else if (changed) { plannedWrites.push({ oldRel, newRel, content }); rewriteOnlyCount++; }
}
log('plan', `迁移文件 ${moveCount} 个；仅改引用 ${rewriteOnlyCount} 个文件。`);

// ─── 4) 守卫 / 基线 / 桶文件 ───────────────────────────────────────────────────
function patchFile(rel, fn, label) {
  if (!exists(rel)) { log('miss', `${rel} 不存在，跳过（${label}）`); return null; }
  const before = read(rel);
  const after = fn(before);
  if (after === before) { log('miss', `${rel}: 未匹配「${label}」，跳过`); return null; }
  log('ok', `${rel}: ${label}`);
  return after;
}

// 4a) check-terminal-singleton 白名单
const singletonRel = 'scripts/check-terminal-singleton.ts';
const singletonNew = patchFile(singletonRel,
  (s) => s.replace(/(['"])src\/terminal\/session\.ts\1/, "'src/domains/terminal/core/session.ts'"),
  "白名单 src/terminal/session.ts → src/domains/terminal/core/session.ts");

// 4b) file-size 基线路径重写
const baselineRel = 'scripts/baselines/file-size.json';
let baselineNew = null;
if (exists(baselineRel)) {
  const json = JSON.parse(read(baselineRel));
  let hit = 0;
  for (const e of json.exemptions ?? []) {
    const p = toPosix(e.path || '');
    if (moveMap.has(p)) { e.path = moveMap.get(p); hit++; }
  }
  if (hit) { baselineNew = JSON.stringify(json, null, 2) + '\n'; log('ok', `基线重写 ${hit} 条 terminal 路径`); }
  else log('miss', '基线无 terminal 登记路径需重写');
}

// 4c) 桶文件（对外只暴露 facade，最小且无命名冲突风险）
const barrelRel = 'src/domains/terminal/index.ts';
const barrel = `/**
 * src/domains/terminal/index.ts
 * terminal 领域唯一对外出口（桶文件）。对外消费请优先从此处导入。
 * 后续可按需扩充 re-export；当前仅暴露领域 facade，避免命名冲突。
 */
export * from './services/facade';
`;

// ─── 5) 旧路径字面量扫描（只报告，交人工确认） ─────────────────────────────────
const literals = new Set();
for (const oldRel of moveMap.keys()) {
  literals.add(oldRel);
  literals.add(oldRel.replace(STRIP_EXT_RE, ''));
  literals.add('@/' + oldRel.slice('src/'.length));
  literals.add('@/' + oldRel.slice('src/'.length).replace(STRIP_EXT_RE, ''));
}
['src/terminal/', 'src/services/terminal/', 'src/utils/terminal/', '@/terminal/', '@/services/terminal/', '@/utils/terminal/']
  .forEach((l) => literals.add(l));

const scanTargets = ['vite.config.ts', 'vitest.config.ts', 'tsconfig.json', 'tsconfig.app.json',
  'tsconfig.node.json', 'package.json', ...walk('scripts').filter((f) => f.endsWith('.ts') || f.endsWith('.mjs'))];
const movedSpecPaths = new Set(plannedWrites.filter((w) => w.newRel !== w.oldRel).map((w) => w.oldRel));
const residual = [];
for (const rel of scanTargets) {
  if (!exists(rel) || movedSpecPaths.has(rel)) continue;
  if (rel === singletonRel || rel === baselineRel) continue; // 已自动处理
  const lines = read(rel).split('\n');
  lines.forEach((line, i) => {
    for (const lit of literals) {
      if (line.includes(lit)) { residual.push(`${rel}:${i + 1}  含「${lit}」`); break; }
    }
  });
}
if (residual.length) {
  log('scan', `脚本/配置仍有 ${residual.length} 处旧路径字面量，需人工确认：`);
  residual.forEach((r) => log('residual', r));
} else log('scan', '脚本/配置无残留旧路径字面量。');

// ─── 6) 写盘 ───────────────────────────────────────────────────────────────────
if (!APPLY) {
  log('dry', `dry-run 结束：将搬 ${moveCount} 个文件、改 ${rewriteOnlyCount} 个引用文件、写守卫/基线/桶文件。加 --apply 执行。`);
  process.exit(0);
}

for (const w of plannedWrites) {
  fs.mkdirSync(path.dirname(abs(w.newRel)), { recursive: true });
  fs.writeFileSync(abs(w.newRel), w.content, 'utf-8');
  if (w.newRel !== w.oldRel) fs.rmSync(abs(w.oldRel));
}
// 清理已空的源目录
for (const d of ['src/terminal', 'src/services/terminal', 'src/utils/terminal']) {
  if (exists(d) && fs.readdirSync(abs(d)).length === 0) fs.rmdirSync(abs(d));
}
if (singletonNew !== null) fs.writeFileSync(abs(singletonRel), singletonNew, 'utf-8');
if (baselineNew !== null) fs.writeFileSync(abs(baselineRel), baselineNew, 'utf-8');
fs.mkdirSync(path.dirname(abs(barrelRel)), { recursive: true });
fs.writeFileSync(abs(barrelRel), barrel, 'utf-8');

log('done', '迁移完成。务必依次运行：pnpm guard && pnpm test && pnpm build（或 vue-tsc）复核。');