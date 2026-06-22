// reuse-clamp.mjs
// color.ts 删除本地 clamp01，复用 utils/core/math.ts 的 clamp。行为一致，零 UX。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src/utils/core/color.ts';
if (!existsSync(FILE)) {
  console.error(`未找到 ${FILE}，请在仓库根目录运行。`);
  process.exit(1);
}

let src = readFileSync(FILE, 'utf8');
if (src.includes("from './math'")) {
  console.log('跳过：color.ts 已复用 math.clamp（幂等）。');
  process.exit(0);
}

const replaceOnce = (input, oldStr, newStr, label) => {
  const count = input.split(oldStr).length - 1;
  if (count !== 1) {
    console.error(`[${label}] 锚点匹配 ${count} 次（期望 1），中止。`);
    process.exit(1);
  }
  return input.replace(oldStr, newStr);
};

src = replaceOnce(
  src,
  "import { parse, sRGB } from '@texel/color';\n",
  "import { parse, sRGB } from '@texel/color';\nimport { clamp } from './math';\n",
  'color import',
);
src = replaceOnce(
  src,
  `const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

const toByte = (value: number): number => Math.round(clamp01(value) * 255);`,
  `const toByte = (value: number): number => Math.round(clamp(value, 0, 1) * 255);`,
  'color toByte',
);

writeFileSync(FILE, src, 'utf8');
console.log('OK：color.ts 已复用 math.clamp。请运行：pnpm lint && pnpm typecheck && pnpm test');