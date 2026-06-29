#!/usr/bin/env node
// 修复 biome lint/suspicious/noAssignInExpressions：把赋值表达式改为函数自增返回。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PLUGIN = resolve(process.cwd(), 'src/services/editor/codemirror-shiki-highlight.ts');
if (!existsSync(PLUGIN)) {
  console.error('✗ 请在 calamex 仓库根目录运行。未找到 codemirror-shiki-highlight.ts');
  process.exit(1);
}

const patch = (label, oldStr, newStr, sentinel) => {
  let src = readFileSync(PLUGIN, 'utf8');
  if (src.includes(sentinel)) { console.log('· 跳过(已应用): ' + label); return; }
  const i = src.indexOf(oldStr);
  if (i === -1) throw new Error('锚点未找到: ' + label);
  if (src.indexOf(oldStr, i + oldStr.length) !== -1) throw new Error('锚点不唯一: ' + label);
  writeFileSync(PLUGIN, src.slice(0, i) + newStr + src.slice(i + oldStr.length));
  console.log('✓ 修复: ' + label);
};

patch(
  'F1 新增 nextShikiSessionKey 自增函数',
  'let shikiSessionKeySeq = 0;',
  `let shikiSessionKeySeq = 0;

const nextShikiSessionKey = (): number => {
  shikiSessionKeySeq += 1;
  return shikiSessionKeySeq;
};`,
  'const nextShikiSessionKey = (): number =>',
);

patch(
  'F2 字段改用函数取值（去掉表达式内赋值）',
  '    private readonly shikiSessionKey = (shikiSessionKeySeq += 1);',
  '    private readonly shikiSessionKey = nextShikiSessionKey();',
  'private readonly shikiSessionKey = nextShikiSessionKey();',
);

console.log('\\n✅ lint 修复完成。重新 git commit 即可。');