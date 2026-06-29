// fix-ghes-api-base.mjs
// 修复 src/services/github-author.ts 中 GitHub Enterprise (GHES) API base 拼接错误。
// 用法：
//   node fix-ghes-api-base.mjs          # dry-run，仅打印将要做的改动
//   node fix-ghes-api-base.mjs --apply  # 实际写盘
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const apply = process.argv.includes('--apply');
const root = dirname(fileURLToPath(import.meta.url));
const target = resolve(root, 'src/services/github-author.ts');

// 精确匹配现有错误分支：非 github.com 时用了 `https://api.${host}`（GHES 无 api. 子域）。
const BEFORE = "    parsed.host === 'github.com' ? 'https://api.github.com' : `https://api.${parsed.host}`;";
const AFTER =
  "    parsed.host === 'github.com'\n" +
  "      ? 'https://api.github.com'\n" +
  "      : `https://${parsed.host}/api/v3`;";

const src = await readFile(target, 'utf8');

if (src.includes('`https://${parsed.host}/api/v3`')) {
  console.log('✓ 已是修复后状态，无需改动。');
  process.exit(0);
}
if (!src.includes(BEFORE)) {
  console.error('✗ 未找到预期的目标行，源码可能已变动。请人工核对，未做任何修改。');
  process.exit(1);
}

const next = src.replace(BEFORE, AFTER);
console.log('--- src/services/github-author.ts ---');
console.log('- ' + BEFORE.trim());
console.log('+ ' + '`https://${parsed.host}/api/v3` (GHES 正确 API base)');

if (!apply) {
  console.log('\n(dry-run) 加 --apply 实际写盘。');
  process.exit(0);
}
await writeFile(target, next, 'utf8');
console.log('\n✓ 已写盘。建议跑：pnpm vue-tsc --noEmit && pnpm biome check src/services/github-author.ts');