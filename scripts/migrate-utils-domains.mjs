#!/usr/bin/env node
// scripts/migrate-utils-domains.mjs
// 一次性把扁平的 src/utils 重构为「按域分层」结构。
// 用法：在仓库根目录、干净工作树上执行：node scripts/migrate-utils-domains.mjs
// 完成后：pnpm lint && pnpm typecheck && pnpm test 验证；出错 git reset --hard 回退。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const REPO_ROOT = process.cwd();
const UTILS_DIR = join(REPO_ROOT, 'src', 'utils');

// ── 域映射：文件名主干(stem) → 目标域 ───────────────────────────────
const DOMAIN_MAP = {
  // core —— 语言级通用原语
  'async-lifecycle': 'core', 'cancelable-task': 'core', 'disposable': 'core',
  color: 'core', date: 'core', hash: 'core', id: 'core',
  'fuzzy-score': 'core', templates: 'core',
  // platform —— 宿主/运行环境
  browser: 'platform', clipboard: 'platform', 'desktop-runtime': 'platform',
  'dom-lifecycle': 'platform', logger: 'platform',
  'runtime-diagnostics': 'platform', 'runtime-scope': 'platform', 'startup-profiler': 'platform',
  // window —— 应用/系统窗口
  'app-window': 'window', 'app-tooltip': 'window', 'window-close': 'window',
  'window-constants': 'window', 'window-resize-events': 'window',
  // error —— 错误处理与呈现
  error: 'error', 'error-dialog': 'error', 'error-presentation': 'error',
  'error-presenter': 'error', 'error-toast': 'error', 'bootstrap-fatal-error': 'error',
  // editor —— 编辑器/文档
  'editor-doc-diff': 'editor', 'editor-language': 'editor', 'editor-scrollbar-activity': 'editor',
  'document-metrics': 'editor', 'document-persistence': 'editor',
  // file —— 文件/路径/预览
  path: 'file', workspace: 'file', 'file-assets': 'file', 'file-icons': 'file',
  'ssh-file-preview': 'file', 'text-preview': 'file',
  // terminal —— 终端/shell
  'terminal-output-buffer': 'terminal', 'terminal-run': 'terminal', 'shell-completion': 'terminal',
  'startup-shell': 'terminal', shfmt: 'terminal',
  // git
  'git-graph': 'git', 'github-auth-header': 'git',
  // run —— 运行报告
  'structured-run-report': 'run', 'hidden-write-backlog': 'run',
};

const stemOf = (file) => file.replace(/\.(ts|tsx)$/, '').replace(/\.(spec|worker)$/, '');

// 1) 收集 src/utils 下当前“扁平”文件(仅一层)
const flatFiles = readdirSync(UTILS_DIR)
  .filter((name) => statSync(join(UTILS_DIR, name)).isFile())
  .filter((name) => /\.(ts|tsx)$/.test(name));

if (flatFiles.length === 0) {
  console.log('src/utils 下没有扁平文件，可能已迁移；不做任何改动。');
  process.exit(0);
}

// 2) 校验：每个文件都要有明确域归属，缺失即中止(绝不静默漏搬)
const unknown = [...new Set(flatFiles.map(stemOf))].filter((s) => !DOMAIN_MAP[s]);
if (unknown.length) {
  console.error('以下文件没有域映射，请先补全 DOMAIN_MAP 再运行：\n  ' + unknown.join('\n  '));
  process.exit(1);
}

// 3) git mv 到 src/utils/<域>/(保留历史)
console.log(`准备迁移 ${flatFiles.length} 个文件：`);
for (const name of flatFiles) {
  const domain = DOMAIN_MAP[stemOf(name)];
  mkdirSync(join(UTILS_DIR, domain), { recursive: true });
  const from = `src/utils/${name}`;
  const to = `src/utils/${domain}/${name}`;
  console.log(`  ${from}  ->  ${to}`);
  execFileSync('git', ['mv', from, to], { cwd: REPO_ROOT, stdio: 'inherit' });
}

// 4) 全仓单遍改写引用：utils/<stem> → utils/<域>/<stem>（覆盖 @/utils/… 与 /src/utils/…）
const alt = Object.keys(DOMAIN_MAP)
  .sort((a, b) => b.length - a.length) // 长主干优先，避免 error 命中 error-dialog
  .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
const rewriteRe = new RegExp(`(?<=utils/)(${alt})(?![\\w-])`, 'g');
const rewrite = (text) => text.replace(rewriteRe, (_m, stem) => `${DOMAIN_MAP[stem]}/${stem}`);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'target', 'coverage', '.turbo']);
const REWRITE_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|vue)$/;
const targets = ['vite.config.ts', 'vitest.config.ts', 'vitest.workspace.ts']
  .map((f) => join(REPO_ROOT, f))
  .filter(existsSync);
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
    } else if (REWRITE_EXT.test(e.name)) {
      targets.push(join(dir, e.name));
    }
  }
};
['src', 'scripts'].map((d) => join(REPO_ROOT, d)).filter(existsSync).forEach(walk);

let changed = 0;
for (const file of targets) {
  const before = readFileSync(file, 'utf8');
  const after = rewrite(before);
  if (after !== before) {
    writeFileSync(file, after);
    changed++;
    console.log(`  改写引用: ${relative(REPO_ROOT, file).split(sep).join('/')}`);
  }
}

console.log(`\n完成：迁移 ${flatFiles.length} 个文件，改写 ${changed} 处文件引用。`);
console.log('下一步：pnpm lint && pnpm typecheck && pnpm test');