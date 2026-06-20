// fix-narrowing.mjs —— 用 run !== null 让 TS 正确收窄,去掉多余的 ! 非空断言
// 用法: node fix-narrowing.mjs --check  |  node fix-narrowing.mjs
// REPO_ROOT 指定仓库根(默认当前目录)。锚点唯一,幂等,缺失即中止。
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.env.REPO_ROOT ?? process.cwd();
const checkOnly = process.argv.includes('--check');

const EDIT = {
  file: 'src/composables/ai/useAiAgentRun.ts',
  find: 'runLifecycleTokens.get(runId) === token && Boolean(run) && !isTerminalRunStatus(run!.status)',
  replace: 'runLifecycleTokens.get(runId) === token && run !== null && !isTerminalRunStatus(run.status)',
};

const abs = join(ROOT, EDIT.file);
let text;
try { text = await readFile(abs, 'utf8'); }
catch { console.error(`✗ 读不到文件: ${EDIT.file}`); process.exit(1); }

const hasFind = text.includes(EDIT.find);
const hasReplace = text.includes(EDIT.replace);

if (!hasFind && hasReplace) {
  console.log(`• 已是收窄写法,无需改动: ${EDIT.file}`);
  process.exit(0);
}
if (!hasFind) {
  console.error(`✗ 锚点未找到(文件可能已变动),已中止: ${EDIT.file}`);
  process.exit(1);
}
const n = text.split(EDIT.find).length - 1;
if (n !== 1) {
  console.error(`✗ 锚点命中 ${n} 次(期望 1),为安全起见中止。`);
  process.exit(1);
}

if (checkOnly) {
  console.log(`[检查模式] 可替换 1 处: ${EDIT.file}。去掉 --check 即应用。未写盘。`);
  process.exit(0);
}

await writeFile(abs, text.replace(EDIT.find, EDIT.replace), 'utf8');
console.log(`✓ 已应用。请运行: pnpm typecheck && pnpm test`);
process.exit(0);