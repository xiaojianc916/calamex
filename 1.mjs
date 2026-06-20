// fix-legacy-batch.mjs —— 批量把 4 处"有原生替代"的旧写法换成现代写法
// 用法:
//   node fix-legacy-batch.mjs --check   只检查能否精确命中锚点,不写盘
//   node fix-legacy-batch.mjs           正式应用
// 设计:每处用唯一锚点字符串精确替换;已应用则跳过(幂等);锚点缺失即中止。
// 不改 lsp-bridge.ts 的 `var`(declare global 必须用 var)。
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.env.REPO_ROOT ?? process.cwd();
const checkOnly = process.argv.includes('--check');

/** 每条:file / find(唯一锚点) / replace。已应用判定 = 含 replace 且不含 find。 */
const EDITS = [
  {
    file: 'agent-sidecar/src/tools/mcp/client.ts',
    find: 'if (Object.prototype.hasOwnProperty.call(result, config.name)) {',
    replace: 'if (Object.hasOwn(result, config.name)) {',
  },
  {
    file: 'src/components/business/ai/chat/normalize-math.ts',
    find: 'if (source.indexOf(command) !== -1) return true;',
    replace: 'if (source.includes(command)) return true;',
  },
  {
    file: 'src/components/business/ai/chat/normalize-math.ts',
    find: '// 先用原生 indexOf 快速排除绝大多数无盒子命令的分片，避免重建与多余分配。',
    replace: '// 先用原生 includes 快速排除绝大多数无盒子命令的分片，避免重建与多余分配。',
  },
  {
    file: 'src/copilotkit/agent/sidecar-agent.ts',
    find: `    // Structured clone for messages and state so the new instance is fully
    // isolated. Falls back to JSON clone if structuredClone is unavailable.
    const cloneDeep = <T>(v: T): T => {
      if (typeof structuredClone === 'function') {
        try {
          return structuredClone(v);
        } catch {
          // fallthrough
        }
      }
      return JSON.parse(JSON.stringify(v)) as T;
    };`,
    replace: `    // Structured clone for messages and state so the new instance is fully
    // isolated (Node >= 26 / modern WebView guarantee structuredClone).
    const cloneDeep = <T>(v: T): T => structuredClone(v);`,
  },
  {
    file: 'src/store/plugins/debouncedPersistStorage.ts',
    find: 'const cloned = JSON.parse(JSON.stringify(value)) as T;',
    replace: 'const cloned = structuredClone(value);',
  },
];

const count = (haystack, needle) => haystack.split(needle).length - 1;

let pending = 0;
let applied = 0;
let aborted = false;
const fileCache = new Map();   // path -> 最新文本
const fileDirty = new Set();

for (const [i, edit] of EDITS.entries()) {
  const abs = join(ROOT, edit.file);
  let text = fileCache.get(abs);
  if (text === undefined) {
    try { text = await readFile(abs, 'utf8'); }
    catch { console.error(`✗ [${i + 1}] 读不到文件: ${edit.file}`); aborted = true; continue; }
    fileCache.set(abs, text);
  }

  const hasFind = text.includes(edit.find);
  const hasReplace = text.includes(edit.replace);

  if (!hasFind && hasReplace) {
    console.log(`• [${i + 1}] 已是现代写法,跳过: ${edit.file}`);
    applied++;
    continue;
  }
  if (!hasFind) {
    console.error(`✗ [${i + 1}] 锚点未找到(文件可能已变动): ${edit.file}\n     找: ${edit.find.split('\n')[0]}`);
    aborted = true;
    continue;
  }
  const n = count(text, edit.find);
  if (n !== 1) {
    console.error(`✗ [${i + 1}] 锚点命中 ${n} 次(期望 1),为安全起见中止: ${edit.file}`);
    aborted = true;
    continue;
  }

  fileCache.set(abs, text.replace(edit.find, edit.replace));
  fileDirty.add(abs);
  pending++;
  console.log(`✓ [${i + 1}] 可替换: ${edit.file}  ←  ${edit.replace.split('\n').slice(-1)[0].trim()}`);
}

if (aborted) {
  console.error('\n✗ 存在无法精确命中的改动,已全部中止,未写任何文件。请把上面 ✗ 行贴回。');
  process.exit(1);
}

if (checkOnly) {
  console.log(`\n[检查模式] 待应用 ${pending} 处,已是现代写法 ${applied} 处。未写盘。去掉 --check 即应用。`);
  process.exit(0);
}

if (pending === 0) {
  console.log('\n✓ 4 处均已是现代写法,无需改动。');
  process.exit(0);
}

for (const abs of fileDirty) {
  await writeFile(abs, fileCache.get(abs), 'utf8');
}
console.log(`\n✓ 已应用 ${pending} 处。请运行: pnpm lint && pnpm typecheck && pnpm test`);