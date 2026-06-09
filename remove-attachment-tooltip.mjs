import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src/components/business/ai/chat/AiPromptInput.vue';
const raw = readFileSync(FILE, 'utf8');
const usedCRLF = raw.includes('\r\n');
let src = usedCRLF ? raw.replace(/\r\n/g, '\n') : raw;

// 1) 去掉附件按钮外层的 Tooltip 包裹，把按钮提升回原位置
const tooltipBlockRe = /[ \t]*<TooltipProvider>\n[\s\S]*?<\/TooltipProvider>/g;
const blocks = src.match(tooltipBlockRe) ?? [];
if (blocks.length !== 1) {
  console.error(`✗ 找到 ${blocks.length} 个 Tooltip 包裹块（应为 1），已中止。`);
  process.exit(1);
}
const block = blocks[0];
const btnMatch = block.match(/[ \t]*<InputGroupButton[\s\S]*?<\/InputGroupButton>/);
if (!btnMatch) {
  console.error('✗ Tooltip 内未找到附件按钮，已中止。');
  process.exit(1);
}
// 整体去掉 6 个缩进空格（3 层 Tooltip 嵌套）
const dedentedBtn = btnMatch[0]
  .split('\n')
  .map((line) => line.replace(/^ {6}/, ''))
  .join('\n');
src = src.replace(block, dedentedBtn);

// 2) 移除不再使用的 tooltip 组件 import
const importLine = `import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';\n`;
if (src.split(importLine).length - 1 !== 1) {
  console.error('✗ 未唯一匹配 tooltip import，已中止。');
  process.exit(1);
}
src = src.replace(importLine, '');

// 3) 移除不再使用的 .ai-composer-tooltip 样式
const cssBlock =
  `\n\n.ai-composer-tooltip {\n` +
  `  border-radius: 6px;\n` +
  `  background: var(--text-primary);\n` +
  `  color: var(--panel-bg);\n` +
  `  padding: 7px 10px;\n` +
  `  font-size: 13px;\n` +
  `  line-height: 1.2;\n` +
  `}`;
if (src.split(cssBlock).length - 1 !== 1) {
  console.error('✗ 未唯一匹配 .ai-composer-tooltip 样式，已中止。');
  process.exit(1);
}
src = src.replace(cssBlock, '');

writeFileSync(FILE, usedCRLF ? src.replace(/\n/g, '\r\n') : src, 'utf8');
console.log('✓ 已删除附件图标的 tooltip（含不再使用的 import 与样式）');