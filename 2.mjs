// scripts/migrate-workbench-phase1b.mjs
//
// Phase 1b —— workbench composition root 领域化
//   src/views/ShellWorkbenchView.vue                -> src/app/ShellWorkbenchView.vue
//   src/composables/useShellWorkbenchView.*         -> src/app/composables/
//   src/composables/useShellWorkbenchViewportState.* -> src/app/composables/
//   src/composables/useShellWorkbenchAiBridge.*      -> src/app/composables/
//   src/composables/useShellResizeFrameScheduler.*   -> src/app/composables/
//   src/composables/useWorkbench.*                   -> src/app/composables/
//   src/components/workbench/RunPanel.*             -> src/domains/terminal/ui/RunPanel.*
//
// 同时：
//   - 基于解析器重写全仓库 import / dynamic import / require / new URL / vi.mock 引用
//   - 把 src/app 加入 check-workbench-facade.ts 的 SCAN_DIRS，并跳过 composables/ 聚合层
//   - 重映射 scripts/baselines/file-size.json 中被移动文件的豁免路径
//   - 残留引用扫描（只报告，不猜测乱改）
//
// 用法：
//   node scripts/migrate-workbench-phase1b.mjs            # dry-run（默认，不写盘）
//   node scripts/migrate-workbench-phase1b.mjs --apply    # 实际执行
//   node scripts/migrate-workbench-phase1b.mjs --root=D:\path\to\repo

import fs from 'node:fs';
import path from 'node:path';

/* ------------------------------------------------------------------ */
/* CLI / root 检测                                                      */
/* ------------------------------------------------------------------ */
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const rootArg = argv.find((a) => a.startsWith('--root='));

function detectRoot() {
  if (rootArg) return path.resolve(rootArg.slice('--root='.length));
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (
      fs.existsSync(path.join(dir, 'package.json')) &&
      fs.existsSync(path.join(dir, 'src'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const ROOT = detectRoot();
if (!ROOT) {
  console.error('请在仓库根目录运行（缺少 package.json / src），或用 --root=<repo> 指定。');
  process.exit(1);
}

const toRel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');
const toAbs = (rel) => path.join(ROOT, rel.split('/').join(path.sep));

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */
const EXTS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.jsx', '.cjs', '.vue', '.css', '.json'];
const CODE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.jsx', '.cjs', '.vue']);
const TEXT_EXT = new Set([...CODE_EXT, '.json', '.md', '.html', '.css']);
const SKIP = new Set(['node_modules', 'dist', 'target', '.git', '.idea', '.vscode']);
const KEEP_EXT = new Set(['.vue', '.css', '.json']); // 这些扩展名在 import 里必须保留
const HAS_EXT_RE = /\.(ts|tsx|mts|cts|js|mjs|jsx|cjs|vue|css|json)$/;

const FACADE_GUARD = 'scripts/check-workbench-facade.ts';
const FILE_SIZE_BASELINE = 'scripts/baselines/file-size.json';

const MOVE_GROUPS = [
  { srcDir: 'src/views', destDir: 'src/app', stems: ['ShellWorkbenchView'] },
  {
    srcDir: 'src/composables',
    destDir: 'src/app/composables',
    stems: [
      'useShellWorkbenchView',
      'useShellWorkbenchViewportState',
      'useShellWorkbenchAiBridge',
      'useShellResizeFrameScheduler',
      'useWorkbench',
    ],
  },
  { srcDir: 'src/components/workbench', destDir: 'src/domains/terminal/ui', stems: ['RunPanel'] },
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ------------------------------------------------------------------ */
/* 1) 构建 moveMap（基于磁盘真实文件 + stem 锚点）                       */
/* ------------------------------------------------------------------ */
/** oldRel -> newRel */
const moveMap = new Map();

for (const { srcDir, destDir, stems } of MOVE_GROUPS) {
  const absSrcDir = toAbs(srcDir);
  if (!fs.existsSync(absSrcDir)) continue;
  const stemRes = stems.map((s) => new RegExp('^' + esc(s) + '\\.'));
  for (const entry of fs.readdirSync(absSrcDir)) {
    const full = path.join(absSrcDir, entry);
    if (!fs.statSync(full).isFile()) continue;
    if (!stemRes.some((re) => re.test(entry))) continue; // `^stem\.` 锚点：排除 useWorkbenchDocumentIO 等同前缀文件
    const oldRel = `${srcDir}/${entry}`;
    const newRel = `${destDir}/${entry}`;
    if (oldRel !== newRel) moveMap.set(oldRel, newRel);
  }
}

if (moveMap.size === 0) {
  console.log('⚠️  未发现待移动文件（可能已迁移）。仍会校验 guard / baseline。');
}

/* ------------------------------------------------------------------ */
/* 2) 收集全仓库文本文件 + 预移动文件集合（用于解析）                     */
/* ------------------------------------------------------------------ */
const allTextFiles = []; // rel[]
const fileSet = new Set(); // 预移动磁盘上存在的所有 rel（用于解析扩展名/index）

(function walk(absDir) {
  for (const entry of fs.readdirSync(absDir)) {
    if (SKIP.has(entry)) continue;
    const full = path.join(absDir, entry);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      walk(full);
    } else {
      const rel = toRel(full);
      fileSet.add(rel);
      if (TEXT_EXT.has(path.extname(entry))) allTextFiles.push(rel);
    }
  }
})(toAbs('src'));

// scripts 与根目录下的 config/doc 也纳入文本扫描（guard、baseline、vite 等）
for (const extraDir of ['scripts']) {
  const abs = toAbs(extraDir);
  if (!fs.existsSync(abs)) continue;
  (function walk(absDir) {
    for (const entry of fs.readdirSync(absDir)) {
      if (SKIP.has(entry)) continue;
      const full = path.join(absDir, entry);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else {
        const rel = toRel(full);
        fileSet.add(rel);
        if (TEXT_EXT.has(path.extname(entry))) allTextFiles.push(rel);
      }
    }
  })(abs);
}
for (const rootFile of ['vite.config.ts', 'index.html']) {
  if (fs.existsSync(toAbs(rootFile))) {
    fileSet.add(rootFile);
    allTextFiles.push(rootFile);
  }
}

/* ------------------------------------------------------------------ */
/* 3) 解析器 / 发射器                                                   */
/* ------------------------------------------------------------------ */
function resolveSpecifier(spec, fromOldRel) {
  let base;
  if (spec.startsWith('@/')) base = 'src/' + spec.slice(2);
  else if (spec.startsWith('./') || spec.startsWith('../')) {
    base = path.posix.normalize(path.posix.join(path.posix.dirname(fromOldRel), spec));
  } else return null; // 裸模块

  for (const ext of EXTS) {
    const cand = base + ext;
    if (fileSet.has(cand)) return cand;
  }
  for (const ext of EXTS.filter((e) => e)) {
    const cand = base + '/index' + ext;
    if (fileSet.has(cand)) return cand;
  }
  return null;
}

function stripExt(p) {
  const ext = path.posix.extname(p);
  return ext ? p.slice(0, -ext.length) : p;
}

function emitSpecifier(originalSpec, fromNewRel, targetNewRel) {
  const targetExt = path.posix.extname(targetNewRel);
  const includeExt = HAS_EXT_RE.test(originalSpec) || KEEP_EXT.has(targetExt);

  let targetPath = includeExt ? targetNewRel : stripExt(targetNewRel);

  // index 文件：原引用未显式写 /index 时，发射目录形式
  const originalRefsIndex = /\/index(\.\w+)?$/.test(originalSpec);
  if (!originalRefsIndex) {
    const bn = path.posix.basename(stripExt(targetNewRel));
    if (bn === 'index') targetPath = path.posix.dirname(targetPath);
  }

  const isAlias = originalSpec.startsWith('@/');
  if (isAlias && targetPath.startsWith('src/')) {
    return '@/' + targetPath.slice('src/'.length);
  }
  // 相对（或目标不在 src 下）：从新位置重算相对路径
  let rel = path.posix.relative(path.posix.dirname(fromNewRel), targetPath);
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

function computeNewSpec(spec, fromOldRel) {
  const resolved = resolveSpecifier(spec, fromOldRel);
  if (!resolved) return null;

  const fromMoved = moveMap.has(fromOldRel);
  const targetMoved = moveMap.has(resolved);
  const isRel = spec.startsWith('./') || spec.startsWith('../');

  // @/ 别名与文件位置无关：仅当目标被移动，或（本文件被移动且是相对路径）时才需重写
  if (!targetMoved && !(fromMoved && isRel)) return null;

  const fromNew = moveMap.get(fromOldRel) ?? fromOldRel;
  const targetNew = moveMap.get(resolved) ?? resolved;
  const next = emitSpecifier(spec, fromNew, targetNew);
  return next === spec ? null : next;
}

const SPEC_PATTERNS = [
  /(\bfrom\s*)(['"])([^'"]+)(['"])/g, // import ... from / export ... from
  /(\bimport\s*\(\s*)(['"])([^'"]+)(['"])/g, // dynamic import()
  /(\bimport\s+)(['"])([^'"]+)(['"])/g, // 副作用 import 'x'
  /(\brequire\s*\(\s*)(['"])([^'"]+)(['"])/g,
  /(\bnew\s+URL\s*\(\s*)(['"])([^'"]+)(['"])/g,
  /(\bvi\.(?:mock|doMock|unmock|importActual|importMock)\s*\(\s*)(['"])([^'"]+)(['"])/g,
];

function rewriteImports(content, fromOldRel) {
  let out = content;
  let count = 0;
  for (const re of SPEC_PATTERNS) {
    out = out.replace(re, (m, pre, q, spec) => {
      const next = computeNewSpec(spec, fromOldRel);
      if (next === null) return m;
      count++;
      return pre + q + next + q;
    });
  }
  return { content: out, count };
}

/* ------------------------------------------------------------------ */
/* 4) 计划：writes / deletes                                            */
/* ------------------------------------------------------------------ */
const writes = new Map(); // finalRel -> content
const deletes = new Set(); // oldRel
let rewriteFileCount = 0;
let rewriteRefCount = 0;
const movedReport = [];

for (const rel of allTextFiles) {
  const ext = path.extname(rel);
  const isCode = CODE_EXT.has(ext);
  const original = fs.readFileSync(toAbs(rel), 'utf-8');
  let finalContent = original;

  if (isCode) {
    const { content, count } = rewriteImports(original, rel);
    finalContent = content;
    if (count > 0) {
      rewriteFileCount++;
      rewriteRefCount += count;
    }
  }

  const newRel = moveMap.get(rel);
  if (newRel) {
    writes.set(newRel, finalContent);
    deletes.add(rel);
    movedReport.push({ from: rel, to: newRel });
  } else if (finalContent !== original) {
    writes.set(rel, finalContent);
  }
}

/* ------------------------------------------------------------------ */
/* 5) 补丁：check-workbench-facade.ts                                   */
/* ------------------------------------------------------------------ */
let facadePatched = false;
let facadeNote = '';
if (fileSet.has(FACADE_GUARD)) {
  let src = writes.get(FACADE_GUARD) ?? fs.readFileSync(toAbs(FACADE_GUARD), 'utf-8');
  const before = src;

  // 5.1 SCAN_DIRS 加入 src/app
  src = src.replace(/const SCAN_DIRS = \[([^\]]*)\];/, (m, inner) => {
    if (/['"]src\/app['"]/.test(inner)) return m;
    return `const SCAN_DIRS = ['src/app', 'src/views', 'src/layouts'];`;
  });

  // 5.2 walk 跳过 composables/（façade 聚合层，非视图层）
  if (!src.includes("if (entry === 'composables') continue;")) {
    src = src.replace(
      /(if \(fs\.statSync\(full\)\.isDirectory\(\)\) \{\s*\n)(\s*)(walk\(full\);)/,
      (m, head, indent, call) =>
        `${head}${indent}// composables/ 是 façade 聚合层（非视图层），按 R-18.11.1 豁免多 store 规则\n${indent}if (entry === 'composables') continue;\n${indent}${call}`,
    );
  }

  // 5.3 同步顶部注释，避免陈述与实现不符
  src = src.replace(
    ' * 扫描 views/** 与 layouts/** 中对业务 store 的直接 import。',
    ' * 扫描 app/**、views/** 与 layouts/**（不含 composables/ 聚合层）中对业务 store 的直接 import。',
  );

  if (src !== before) {
    writes.set(FACADE_GUARD, src);
    facadePatched = true;
    const ok =
      /['"]src\/app['"]/.test(src) && src.includes("if (entry === 'composables') continue;");
    facadeNote = ok ? '✓ SCAN_DIRS + composables 跳过' : '⚠️ 补丁可能不完整，请核对';
  } else {
    facadeNote = '已是目标状态（跳过）';
  }
} else {
  facadeNote = `未找到 ${FACADE_GUARD}`;
}

/* ------------------------------------------------------------------ */
/* 6) 重映射 file-size.json baseline 中被移动文件的路径                  */
/* ------------------------------------------------------------------ */
const baselineRemaps = [];
if (fileSet.has(FILE_SIZE_BASELINE)) {
  let bl = fs.readFileSync(toAbs(FILE_SIZE_BASELINE), 'utf-8');
  const before = bl;
  for (const [oldRel, newRel] of moveMap) {
    const needle = `"${oldRel}"`;
    const occ = bl.split(needle).length - 1;
    if (occ > 0) {
      bl = bl.split(needle).join(`"${newRel}"`);
      baselineRemaps.push({ oldRel, newRel, occ });
    }
  }
  if (bl !== before) writes.set(FILE_SIZE_BASELINE, bl);
} else {
  console.log(`⚠️  未找到 ${FILE_SIZE_BASELINE}`);
}

/* ------------------------------------------------------------------ */
/* 7) 残留引用扫描（虚拟 FS：写后状态）                                  */
/* ------------------------------------------------------------------ */
function virtualRead(rel) {
  if (writes.has(rel)) return writes.get(rel);
  return fs.readFileSync(toAbs(rel), 'utf-8');
}
const finalFileList = new Set([...fileSet, ...writes.keys()]);
for (const d of deletes) finalFileList.delete(d);

const residualNeedles = [];
for (const [oldRel] of moveMap) {
  const noExt = stripExt(oldRel); // src/composables/useWorkbench
  const aliasNoExt = '@/' + noExt.slice('src/'.length); // @/composables/useWorkbench
  for (const n of [aliasNoExt, noExt]) {
    residualNeedles.push({ needle: n, re: new RegExp(esc(n) + '(?![A-Za-z0-9_])') });
  }
}

const residuals = [];
for (const rel of finalFileList) {
  if (!TEXT_EXT.has(path.extname(rel))) continue;
  let content;
  try {
    content = virtualRead(rel);
  } catch {
    continue;
  }
  for (const { needle, re } of residualNeedles) {
    if (re.test(content)) {
      const line = content.split('\n').findIndex((l) => re.test(l)) + 1;
      residuals.push({ rel, needle, line });
    }
  }
}

/* ------------------------------------------------------------------ */
/* 8) 输出 / 落盘                                                       */
/* ------------------------------------------------------------------ */
console.log(`\n=== Phase 1b: workbench → src/app + RunPanel → terminal/ui ===`);
console.log(`ROOT: ${ROOT}`);
console.log(`模式: ${APPLY ? 'APPLY（写盘）' : 'DRY-RUN（不写盘，加 --apply 执行）'}\n`);

console.log(`移动文件 (${movedReport.length}):`);
for (const { from, to } of movedReport) console.log(`  ${from}  ->  ${to}`);

console.log(`\n引用重写: ${rewriteRefCount} 处，跨 ${rewriteFileCount} 个文件`);

console.log(`\nguard 补丁 (${FACADE_GUARD}): ${facadeNote}`);

console.log(`\nbaseline 重映射 (${FILE_SIZE_BASELINE}):`);
if (baselineRemaps.length === 0) console.log('  （无匹配条目）');
for (const { oldRel, newRel, occ } of baselineRemaps)
  console.log(`  ${oldRel} -> ${newRel}${occ > 1 ? `  ⚠️ 命中${occ}处` : ''}`);

console.log(`\n残留引用扫描: ${residuals.length === 0 ? '✓ 无残留' : `⚠️ ${residuals.length} 处`}`);
for (const { rel, needle, line } of residuals) console.log(`  ${rel}:${line}  ${needle}`);

const writeList = [...writes.keys()].filter((r) => !moveMap.has(r) || writes.has(r));
console.log(`\n待写文件 (${writes.size})，待删文件 (${deletes.size})`);

if (!APPLY) {
  console.log('\nDRY-RUN 结束。确认无误后加 --apply 执行。');
  process.exit(0);
}

/* ---- 实际写盘 ---- */
for (const [rel, content] of writes) {
  const abs = toAbs(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}
for (const rel of deletes) {
  const abs = toAbs(rel);
  if (fs.existsSync(abs)) fs.unlinkSync(abs);
}
// 清理空目录（仅当确实为空）
for (const { srcDir } of MOVE_GROUPS) {
  const abs = toAbs(srcDir);
  if (fs.existsSync(abs) && fs.readdirSync(abs).length === 0) {
    fs.rmdirSync(abs);
    console.log(`已删除空目录: ${srcDir}`);
  }
}

console.log('\n✅ APPLY 完成。请运行：pnpm guard && pnpm test && pnpm build（或 vue-tsc --noEmit），随后 git diff --stat 复核。');