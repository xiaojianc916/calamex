// scripts/migrate-git-domain.mjs
// 领域化 Phase 2：git 域。把 git 的 状态/工具/组合式/领域服务 迁入 src/domains/git/{state,utils,composables,services}。
// UI 与 裸 tauri IPC、types/git 按 terminal 惯例保留中央。
// 默认 dry-run；--apply 落盘；--root=<path> 指定仓库根。
// 引擎与 Phase 1a/1b 一致：真 resolver/emitter，保留 alias-vs-relative 风格与扩展名存在性。
import fs from 'node:fs';
import path from 'node:path';

// ---------- CLI ----------
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const rootArg = args.find((a) => a.startsWith('--root='));

// ---------- 根目录探测 ----------
function detectRoot() {
  if (rootArg) return path.resolve(rootArg.slice('--root='.length));
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
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
  console.error('请在仓库根目录运行（缺少 package.json / src）。');
  process.exit(1);
}
const ROOT = detectRoot();
const SRC = path.join(ROOT, 'src');

// ---------- 常量 ----------
const EXTS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.jsx', '.cjs', '.vue', '.css', '.json'];
const CODE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.jsx', '.cjs'];
const TEXT_EXT = new Set([...CODE_EXTS, '.vue', '.json', '.md', '.html', '.css']);
const KEEP_EXT = new Set(['.vue', '.css', '.json']); // 这些扩展名必须显式保留
const SKIP = new Set(['node_modules', 'dist', 'target', '.git', '.idea', '.vscode']);

const toAbs = (rel) => path.join(ROOT, rel);
const toRel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

// ---------- 移动规格 ----------
const DOMAIN = 'src/domains/git';
const MOVE_DIRS = [
  { from: 'src/utils/git', to: `${DOMAIN}/utils` }, // 扁平：git-graph(.spec) / github-auth-header
  { from: 'src/store/git', to: `${DOMAIN}/state` }, // 扁平：use-background-queue(.spec)
];
const MOVE_FILES = [
  ['src/store/git.ts', `${DOMAIN}/state/git.ts`],
  ['src/store/git.store.spec.ts', `${DOMAIN}/state/git.store.spec.ts`],
  ['src/store/git-pull-request-helpers.ts', `${DOMAIN}/state/git-pull-request-helpers.ts`],
  ['src/store/github-auth.ts', `${DOMAIN}/state/github-auth.ts`],
  ['src/store/github-auth.store.spec.ts', `${DOMAIN}/state/github-auth.store.spec.ts`],
  ['src/composables/useGitRepositoryStatusBootstrap.ts', `${DOMAIN}/composables/useGitRepositoryStatusBootstrap.ts`],
  ['src/composables/useGitRepositoryStatusBootstrap.spec.ts', `${DOMAIN}/composables/useGitRepositoryStatusBootstrap.spec.ts`],
  ['src/composables/useSourceControlActions.ts', `${DOMAIN}/composables/useSourceControlActions.ts`],
  ['src/composables/useSourceControlContextMenu.ts', `${DOMAIN}/composables/useSourceControlContextMenu.ts`],
  ['src/services/github-author.ts', `${DOMAIN}/services/github-author.ts`],
  ['src/services/github-author.spec.ts', `${DOMAIN}/services/github-author.spec.ts`],
];

// ---------- 全仓文件索引 ----------
function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
}
const allFiles = [];
walk(ROOT, allFiles);
const origFiles = new Set(allFiles.map((f) => path.resolve(f)));

// ---------- 构造 moveMap（原始 abs -> 新 abs）----------
const moveMap = new Map();
function addMove(fromRel, toRel_) {
  const fromAbs = path.resolve(toAbs(fromRel));
  if (!origFiles.has(fromAbs)) return false; // 不存在则跳过（spec 可能没有）
  moveMap.set(fromAbs, path.resolve(toAbs(toRel_)));
  return true;
}
// 目录整体搬（仅一层，禁止嵌套子目录以防遗漏）
for (const { from, to } of MOVE_DIRS) {
  const fromAbs = toAbs(from);
  if (!fs.existsSync(fromAbs)) continue;
  for (const name of fs.readdirSync(fromAbs)) {
    const full = path.join(fromAbs, name);
    if (fs.statSync(full).isDirectory()) {
      console.error(`✗ 意外的嵌套子目录：${toRel(full)}（请人工确认后再跑）`);
      process.exit(1);
    }
    addMove(`${from}/${name}`, `${to}/${name}`);
  }
}
// 显式文件搬
for (const [f, t] of MOVE_FILES) addMove(f, t);

if (moveMap.size === 0) {
  console.error('没有匹配到任何待搬迁文件，可能已迁移或路径变化。');
  process.exit(1);
}

// ---------- specifier 解析 / 改写 ----------
function resolveOriginal(baseAbs) {
  for (const ext of EXTS) {
    const cand = baseAbs + ext;
    if (origFiles.has(path.resolve(cand))) return path.resolve(cand);
  }
  for (const ext of CODE_EXTS) {
    const cand = path.join(baseAbs, 'index' + ext);
    if (origFiles.has(path.resolve(cand))) return path.resolve(cand);
  }
  return null;
}

function rewriteSpec(spec, fromFileAbs) {
  const isAlias = spec.startsWith('@/');
  const isRel = spec.startsWith('./') || spec.startsWith('../');
  if (!isAlias && !isRel) return null; // 外部包

  const baseAbs = isAlias
    ? path.join(SRC, spec.slice(2))
    : path.resolve(path.dirname(fromFileAbs), spec);

  const origTarget = resolveOriginal(baseAbs);
  if (!origTarget) return null; // 解析不到具体文件，保守不动

  const newTarget = moveMap.get(origTarget) ?? origTarget;
  const newFrom = moveMap.get(fromFileAbs) ?? fromFileAbs;
  if (newTarget === origTarget && newFrom === fromFileAbs) return null; // 双方都没动

  // 原 spec 是否带扩展名 / 是否指向目录 index
  const lastSeg = spec.split('/').pop();
  const extMatch = lastSeg.match(/\.(ts|tsx|mts|cts|js|mjs|jsx|cjs|vue|css|json)$/);
  const hadExt = !!extMatch;
  const origBase = path.basename(origTarget);
  const isIndexFile = /^index\.(ts|tsx|mts|cts|js|mjs|jsx|cjs)$/.test(origBase);
  const specNoExt = spec.replace(/\.(ts|tsx|mts|cts|js|mjs|jsx|cjs|vue|css|json)$/, '');
  const specEndsWithIndex = /(^|\/)index$/.test(specNoExt);
  const pointedAtDir = isIndexFile && !specEndsWithIndex && !hadExt;

  let targetForEmit = pointedAtDir ? path.dirname(newTarget) : newTarget;

  // 组路径（保留 alias / relative 风格）
  let out;
  if (isAlias) {
    out = '@/' + path.relative(SRC, targetForEmit).split(path.sep).join('/');
  } else {
    let rel = path.relative(path.dirname(newFrom), targetForEmit).split(path.sep).join('/');
    if (!rel.startsWith('.')) rel = './' + rel;
    out = rel;
  }

  // 扩展名存在性：保留原样；目录 index 引用不带文件名
  if (!pointedAtDir) {
    const realExt = path.extname(targetForEmit); // 实际文件扩展名
    const outExt = path.extname(out);
    if (hadExt || KEEP_EXT.has(realExt)) {
      if (!outExt) out += realExt; // 需要带扩展名但 out 没有
    } else if (outExt) {
      out = out.slice(0, -outExt.length); // 原本不带扩展名 -> 去掉
    }
  } else {
    const outExt = path.extname(out);
    if (outExt) out = out.slice(0, -outExt.length);
  }
  return out === spec ? null : out;
}

// import/require/动态import/new URL/vi.mock 五类 specifier
const PATTERNS = [
  /(\bfrom\s*['"])([^'"]+)(['"])/g,
  /(\bimport\s*\(\s*['"])([^'"]+)(['"]\s*\))/g,
  /(\bimport\s+['"])([^'"]+)(['"])/g,
  /(\brequire\s*\(\s*['"])([^'"]+)(['"]\s*\))/g,
  /(\bnew\s+URL\s*\(\s*['"])([^'"]+)(['"]\s*,\s*import\.meta\.url)/g,
  /(\bvi\.(?:mock|doMock|unmock|importActual|importMock)\s*\(\s*['"])([^'"]+)(['"])/g,
];

function rewriteContent(content, fromFileAbs) {
  let count = 0;
  let next = content;
  for (const re of PATTERNS) {
    next = next.replace(re, (m, p1, spec, p3) => {
      const r = rewriteSpec(spec, fromFileAbs);
      if (r == null) return m;
      count++;
      return p1 + r + p3;
    });
  }
  return { next, count };
}

// ---------- 计算 writes / deletes ----------
const writes = new Map(); // 新 abs -> 内容
const deletes = []; // 旧 abs
let rewriteFiles = 0;
let rewriteHits = 0;

for (const abs of origFiles) {
  const ext = path.extname(abs);
  const moved = moveMap.has(abs);
  if (!TEXT_EXT.has(ext) && !moved) continue;

  const raw = fs.readFileSync(abs, 'utf-8');
  let content = raw;
  if (TEXT_EXT.has(ext)) {
    const { next, count } = rewriteContent(raw, abs);
    content = next;
    if (count > 0) {
      rewriteFiles++;
      rewriteHits += count;
    }
  }
  const dest = moveMap.get(abs) ?? abs;
  if (moved) {
    writes.set(dest, content);
    deletes.push(abs);
  } else if (content !== raw) {
    writes.set(dest, content);
  }
}

// ---------- 基线补丁：file-size.json ----------
const baselineRel = 'scripts/baselines/file-size.json';
const baselineAbs = toAbs(baselineRel);
let baselinePatched = false;
if (fs.existsSync(baselineAbs)) {
  const cur = writes.get(path.resolve(baselineAbs)) ?? fs.readFileSync(baselineAbs, 'utf-8');
  const patched = cur.replace('"src/store/git.ts"', '"src/domains/git/state/git.ts"');
  if (patched !== cur) {
    writes.set(path.resolve(baselineAbs), patched);
    baselinePatched = true;
  }
}

// ---------- 域入口 index.ts ----------
const indexRel = `${DOMAIN}/index.ts`;
const indexAbs = path.resolve(toAbs(indexRel));
const indexContent = `export * from './state/git';\n`;
const createIndex = !origFiles.has(indexAbs);
if (createIndex) writes.set(indexAbs, indexContent);

// ---------- 残留扫描（基于内存最终态）----------
const RESIDUAL = [
  /['"]@\/store\/git(['"/]|-pull-request-helpers)/,
  /['"]@\/store\/github-auth['"]/,
  /['"]@\/utils\/git\//,
  /['"]@\/composables\/useSourceControl/,
  /['"]@\/composables\/useGitRepositoryStatusBootstrap/,
  /['"]@\/services\/github-author['"]/,
];
const finalByPath = new Map();
for (const abs of origFiles) {
  if (deletes.includes(abs)) continue;
  finalByPath.set(abs, fs.readFileSync(abs, 'utf-8'));
}
for (const [abs, content] of writes) finalByPath.set(abs, content);
const residuals = [];
for (const [abs, content] of finalByPath) {
  if (!TEXT_EXT.has(path.extname(abs))) continue;
  for (const re of RESIDUAL) {
    if (re.test(content)) {
      residuals.push(`${toRel(abs)}  ⟂  ${re}`);
      break;
    }
  }
}

// ---------- 报告 ----------
console.log(`\n=== migrate-git-domain (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
console.log(`ROOT: ${ROOT}`);
console.log(`\n搬迁文件 ${moveMap.size} 个：`);
for (const [from, to] of moveMap) console.log(`  ${toRel(from)}  ->  ${toRel(to)}`);
console.log(`\n改写：${rewriteFiles} 个文件 / ${rewriteHits} 处 specifier`);
console.log(`基线补丁 file-size.json: ${baselinePatched ? '已更新 src/store/git.ts -> src/domains/git/state/git.ts' : '无变化(需人工确认)'}`);
console.log(`域入口 ${indexRel}: ${createIndex ? '将创建' : '已存在,跳过'}`);
console.log(`总写入 ${writes.size} 个文件，删除 ${deletes.length} 个旧文件`);
if (residuals.length) {
  console.log(`\n⚠ 残留旧引用 ${residuals.length} 处：`);
  residuals.forEach((r) => console.log('   ' + r));
} else {
  console.log('\n✓ 无残留旧引用');
}

// ---------- 落盘 ----------
if (APPLY) {
  for (const [abs, content] of writes) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  for (const abs of deletes) {
    if (writes.has(abs)) continue; // 同路径已覆盖
    fs.rmSync(abs, { force: true });
  }
  // 清理可能变空的旧目录
  for (const { from } of MOVE_DIRS) {
    const d = toAbs(from);
    if (fs.existsSync(d) && fs.readdirSync(d).length === 0) fs.rmdirSync(d);
  }
  console.log('\n✅ 已落盘。请运行: pnpm guard && pnpm test && pnpm build');
} else {
  console.log('\n(dry-run；加 --apply 落盘)');
}