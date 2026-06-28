#!/usr/bin/env node
// scripts/migrate-tauri-services.mjs
// 将 src/services 下扁平的 Tauri IPC 绑定层迁入 src/services/tauri/ 领域目录,并全量重写 import。
//   node scripts/migrate-tauri-services.mjs          # dry-run：只打印移动与改写，不落盘
//   node scripts/migrate-tauri-services.mjs --apply  # 实际执行(git mv + 重写)
// 幂等：--apply 后再次运行为 no-op。
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const APPLY = process.argv.includes('--apply');
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url))); // 脚本位于 scripts/
const SRC = join(REPO_ROOT, 'src');
const SCAN_ROOTS = ['src'];                 // 需要时可加 'scripts' 等
const SCAN_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.vue', '.js', '.mjs']);
const toPosix = (p) => p.split(sep).join('/');

// 移动映射(repo 相对路径)
const MOVES = {
  'src/services/tauri.ts':                 'src/services/tauri/index.ts',
  'src/services/tauri.git.ts':             'src/services/tauri/git.ts',
  'src/services/tauri.terminal.ts':        'src/services/tauri/terminal.ts',
  'src/services/tauri.ssh.ts':             'src/services/tauri/ssh.ts',
  'src/services/tauri.ai.ts':              'src/services/tauri/ai.ts',
  'src/services/tauri.ai-edit.ts':         'src/services/tauri/ai-edit.ts',
  'src/services/tauri.sidecar.ts':         'src/services/tauri/sidecar.ts',
  'src/services/tauri.workspace.ts':       'src/services/tauri/workspace.ts',
  'src/services/tauri.github-auth.ts':     'src/services/tauri/github-auth.ts',
  'src/services/tauri.skills.ts':          'src/services/tauri/skills.ts',
  'src/services/tauri.ipc-define.ts':      'src/services/tauri/core/ipc-define.ts',
  'src/services/tauri.ipc-metrics.ts':     'src/services/tauri/core/ipc-metrics.ts',
  'src/services/tauri.ipc-runtime.ts':     'src/services/tauri/core/ipc-runtime.ts',
  'src/services/tauri.ipc-types.ts':       'src/services/tauri/core/ipc-types.ts',
  'src/services/tauri.spec.ts':            'src/services/tauri/index.spec.ts',
  'src/services/tauri.git.spec.ts':        'src/services/tauri/git.spec.ts',
  'src/services/tauri.ipc-runtime.spec.ts':'src/services/tauri/core/ipc-runtime.spec.ts',
};
const movesAbs = new Map(Object.entries(MOVES).map(([o, n]) => [join(REPO_ROOT, o), join(REPO_ROOT, n)]));

const walk = (absDir, out = []) => {
  for (const name of readdirSync(absDir)) {
    const abs = join(absDir, name);
    const st = statSync(abs);
    if (st.isDirectory()) { if (name !== 'node_modules') walk(abs, out); }
    else if (SCAN_EXT.has(name.slice(name.lastIndexOf('.')))) out.push(abs);
  }
  return out;
};

// 把说明符解析到「正在被移动的旧绝对路径」,否则返回 null(无需改写)
const resolveMovedTarget = (importerOldAbs, spec) => {
  let base;
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(importerOldAbs), spec);
  else return null;
  const cands = [base, base + '.ts', base + '.tsx', base + '.mts', base + '.cts', base + '.vue', join(base, 'index.ts')];
  for (const c of cands) if (movesAbs.has(c)) return c;
  return null;
};

const emitSpecifier = (importerNewAbs, newTargetAbs, wasAlias) => {
  const noExt = newTargetAbs.replace(/\.(ts|tsx|mts|cts|vue)$/, '');
  const isIndex = /(^|\/)index$/.test(toPosix(noExt));
  if (wasAlias) {
    let p = '@/' + toPosix(relative(SRC, noExt));
    if (isIndex) p = p.replace(/\/index$/, '');     // @/services/tauri 保持原样 → 该引用零改动
    return p;
  }
  let rel = toPosix(relative(dirname(importerNewAbs), noExt));
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
};

const IMPORT_RE = /(from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)(['"])([^'"]+)\2/g;

// 先按旧位置计算所有内容改写
const edits = new Map(); // oldAbs -> newContent
const changeLog = [];    // 用于 dry-run 打印
for (const root of SCAN_ROOTS) {
  for (const fileAbs of walk(join(REPO_ROOT, root))) {
    const importerNewAbs = movesAbs.get(fileAbs) ?? fileAbs;
    const src = readFileSync(fileAbs, 'utf8');
    const changes = [];
    const next = src.replace(IMPORT_RE, (whole, lead, q, spec) => {
      const movedOld = resolveMovedTarget(fileAbs, spec);
      if (!movedOld) return whole;
      const newSpec = emitSpecifier(importerNewAbs, movesAbs.get(movedOld), spec.startsWith('@/'));
      if (newSpec === spec) return whole;
      changes.push(`${spec}  →  ${newSpec}`);
      return `${lead}${q}${newSpec}${q}`;
    });
    if (changes.length) { edits.set(fileAbs, next); changeLog.push([fileAbs, changes]); }
  }
}

// 打印计划
console.log(`\n[migrate-tauri-services] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);
console.log(`\n# 文件移动 (${Object.keys(MOVES).length})`);
for (const [o, n] of Object.entries(MOVES)) console.log(`  ${existsSync(join(REPO_ROOT, o)) ? 'mv' : '·skip'}  ${o}  →  ${n}`);
console.log(`\n# import 改写 (${changeLog.length} 个文件)`);
for (const [abs, changes] of changeLog) { console.log(`  ${toPosix(relative(REPO_ROOT, abs))}`); for (const c of changes) console.log(`      ${c}`); }

if (!APPLY) { console.log('\nDRY-RUN 完成。确认无误后加 --apply 执行。\n'); process.exit(0); }

// 1) 物理移动(优先 git mv 保留历史)
for (const [oldRel, newRel] of Object.entries(MOVES)) {
  const oldAbs = join(REPO_ROOT, oldRel), newAbs = join(REPO_ROOT, newRel);
  if (!existsSync(oldAbs)) continue;
  mkdirSync(dirname(newAbs), { recursive: true });
  try { execSync(`git mv -f "${oldRel}" "${newRel}"`, { cwd: REPO_ROOT, stdio: 'pipe' }); }
  catch { renameSync(oldAbs, newAbs); }
}
// 2) 写回改写后的内容(移动过的文件写到新位置)
for (const [oldAbs, content] of edits) writeFileSync(movesAbs.get(oldAbs) ?? oldAbs, content);
console.log('\nAPPLY 完成。请运行：git add -A && pnpm fix && pnpm guard\n');