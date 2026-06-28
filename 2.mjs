// fix-fuzzy-score-precompute.mjs
//
// 用途：把 src/utils/core/fuzzy-score.ts 中"位置无关"的边界奖励 boundaryBonusAt
//       从 O(n·m) 内层循环里提到循环外一次性预算成 Float64Array，内层改为数组读取。
// 性质：纯提取式重构，匹配分数逐位不变，单测必过；不影响任何用户可见行为。
// 用法：node fix-fuzzy-score-precompute.mjs [仓库根目录]
//       默认在当前工作目录（即 D:\com.xiaojianc\my_desktop_app）执行。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(process.argv[2] ?? process.cwd());
const target = join(repoRoot, 'src', 'utils', 'core', 'fuzzy-score.ts');

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

if (!existsSync(target)) fail(`找不到目标文件：${target}（请确认仓库根目录参数）`);

let src = readFileSync(target, 'utf8');

// —— 幂等：已打过补丁就直接退出，不重复修改 —— //
if (src.includes('const boundaryBonus = new Float64Array(n)')) {
  console.log('• 已是优化后版本，跳过（幂等）。');
  process.exit(0);
}

// —— 锚点定义（必须精确存在，否则中止，绝不乱改） —— //
const anchorDecl = '  const n = text.length;\n  const m = query.length;\n';
const anchorMaxCall = 'Math.max(BONUS_CONSECUTIVE, boundaryBonusAt(text, i - 1))';
const anchorPlainCall = 'bonus = boundaryBonusAt(text, i - 1);';

for (const [name, anchor] of [
  ['n/m 声明', anchorDecl],
  ['连续命中分支调用', anchorMaxCall],
  ['首段命中分支调用', anchorPlainCall],
]) {
  const count = src.split(anchor).length - 1;
  if (count !== 1) fail(`锚点「${name}」预期出现 1 次，实际 ${count} 次；文件结构可能已变化，已中止以免误改。`);
}

// —— 1) 在 n/m 声明后插入一次性预算（边界奖励只依赖 text 与位置，与 DP 状态无关） —— //
const precompute =
  anchorDecl +
  '\n' +
  '  // 边界奖励仅取决于 text 与位置，与查询进度 j 无关：循环前一次性预算 O(n)，\n' +
  '  // 避免在 O(n*m) 内层循环里对同一位置反复 classifyChar（行为不变）。\n' +
  '  const boundaryBonus = new Float64Array(n);\n' +
  '  for (let i = 0; i < n; i += 1) {\n' +
  '    boundaryBonus[i] = boundaryBonusAt(text, i);\n' +
  '  }\n';
src = src.replace(anchorDecl, precompute);

// —— 2) 内层两处调用改为数组读取 —— //
src = src.replace(anchorMaxCall, 'Math.max(BONUS_CONSECUTIVE, boundaryBonus[i - 1])');
src = src.replace(anchorPlainCall, 'bonus = boundaryBonus[i - 1];');

writeFileSync(target, src, 'utf8');
console.log('✓ 已优化 src/utils/core/fuzzy-score.ts（边界奖励预算化，行为不变）。');
console.log('  建议随后执行： pnpm vitest run src/utils/core/fuzzy-score.spec.ts');