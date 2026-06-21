// fix-git-logger.mjs
// 修复 src/store/git.ts 中 F13 consola.withTag 残留
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname ?? process.cwd());
const filePath = resolve(ROOT, 'src/store/git.ts');

const b = (...lines) => lines.join('\n');

const edits = [
  {
    label: 'F13-a: 删除 consola import',
    from: `import { consola } from 'consola';\n`,
    to: '',
  },
  {
    label: 'F13-b: gitLogger 改用 logger.child',
    from: b(
      `/** Git store 后台任务（commit 统计 / PR 预载）失败时的统一日志通道，替代散落的 console.warn。 */`,
      `const gitLogger = consola.withTag('git');`,
    ),
    to: b(
      `/** Git store 后台任务（commit 统计 / PR 预载）失败时的统一日志通道，替代散落的 console.warn。 */`,
      `const gitLogger = logger.child({ module: 'git' });`,
    ),
  },
  {
    label: 'F13-c: warn commit stats 结构化',
    from: `          gitLogger.warn('background commit stats load failed', error);`,
    to:   `          gitLogger.warn({ event: 'git.commit_stats.background_load_failed', err: error });`,
  },
  {
    label: 'F13-d: warn PR detail preload 结构化',
    from: `          gitLogger.warn('background PR detail preload failed', pullRequest.number, error);`,
    to:   `          gitLogger.warn({ event: 'git.pull_request.detail_preload_failed', err: error, pullRequestNumber: pullRequest.number });`,
  },
  {
    label: 'F13-e: warn PR background preload 结构化',
    from: `      gitLogger.warn('background PR preload failed', error);`,
    to:   `      gitLogger.warn({ event: 'git.pull_request.background_preload_failed', err: error });`,
  },
];

const dry = process.argv.includes('--dry-run');
let content = readFileSync(filePath, 'utf8');
let applied = [], skipped = [], missing = [];

for (const { label, from, to } of edits) {
  if (from === '' || content.includes(to.trim() || from)) {
    // 空 from（删除行） 或已含目标态
    if (from === '' ? !content.includes('consola') : content.includes(to)) {
      skipped.push(label); continue;
    }
  }
  if (!content.includes(from)) { missing.push(label); continue; }
  content = content.replace(from, to);
  applied.push(label);
}

console.log('\n=== fix-git-logger.mjs ===');
applied.forEach(l => console.log(`  ✅ ${l}`));
skipped.forEach(l => console.log(`  ⏭  ${l} (已是目标态)`));
missing.forEach(l => console.log(`  ❌ ${l} (锚点未找到)`));

if (!dry && applied.length > 0) {
  writeFileSync(filePath, content, 'utf8');
  console.log(`\n已写入 ${filePath}`);
}
if (missing.length > 0) process.exit(1);