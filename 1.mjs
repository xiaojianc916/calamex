#!/usr/bin/env node
// fix-catalog-indent.mjs —— §5.3：用仓库自己的 Prettier 配置归一缩进/风格，纯格式化、语义不变。
// 用仓库 prettier 配置 → 自动沿用其 endOfLine，不会引入换行符噪声。
// 仓库根目录运行：node fix-catalog-indent.mjs
import { readFile, writeFile } from 'node:fs/promises';
import prettier from 'prettier';

const target = 'scripts/generate-shell-command-catalog.ts';
const src = await readFile(target, 'utf8');
const config = (await prettier.resolveConfig(target)) ?? {};
const out = await prettier.format(src, { ...config, parser: 'typescript' });

if (out !== src) {
  await writeFile(target, out, 'utf8');
  console.log('✅ 已按仓库 Prettier 配置归一 generate-shell-command-catalog.ts。');
} else {
  console.log('ℹ️ 无变化（已符合配置）。');
}
