import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

const file = path.join(
  repoRoot,
  'src/components/business/ai/shell/AiAssistantSuggestionEmpty.vue',
);

const fail = (message) => {
  throw new Error(message);
};

if (!fs.existsSync(file)) {
  fail(`[missing] ${path.relative(repoRoot, file)}`);
}

let source = fs.readFileSync(file, 'utf8');

const blockPattern = /\.ai-suggestion-empty\s*\{[\s\S]*?\n\}/;

const blockMatch = source.match(blockPattern);

if (!blockMatch) {
  fail('[guard] 找不到 .ai-suggestion-empty 样式块，请贴 AiAssistantSuggestionEmpty.vue 当前样式。');
}

const originalBlock = blockMatch[0];

let nextBlock = originalBlock;

// 顶部 padding 统一压到 0，避免 padding 和 transform 双重影响不稳定。
if (/^\s*padding\s*:[^;]+;/m.test(nextBlock)) {
  nextBlock = nextBlock.replace(/^\s*padding\s*:[^;]+;/m, '  padding: 0 16px 0;');
} else {
  nextBlock = nextBlock.replace(
    /\.ai-suggestion-empty\s*\{/,
    `.ai-suggestion-empty {
  padding: 0 16px 0;`,
  );
}

// 整体大幅上移。比上一版更明显。
const transformLine = '  transform: translateY(clamp(-220px, -20vh, -128px));';

if (/^\s*transform\s*:[^;]+;/m.test(nextBlock)) {
  nextBlock = nextBlock.replace(/^\s*transform\s*:[^;]+;/m, transformLine);
} else {
  nextBlock = nextBlock.replace(
    /\.ai-suggestion-empty\s*\{/,
    `.ai-suggestion-empty {
${transformLine}`,
  );
}

// 避免 transform 后占位还影响布局太多：给底部补一点负 margin，减少空白感。
const marginLine = '  margin-bottom: clamp(-220px, -20vh, -128px);';

if (/^\s*margin-bottom\s*:[^;]+;/m.test(nextBlock)) {
  nextBlock = nextBlock.replace(/^\s*margin-bottom\s*:[^;]+;/m, marginLine);
} else {
  nextBlock = nextBlock.replace(
    transformLine,
    `${transformLine}
${marginLine}`,
  );
}

source = source.replace(originalBlock, nextBlock);

fs.writeFileSync(file, source);

console.log('✅ Moved AI suggestions much further upward');
console.log(`📝 Updated: ${path.relative(repoRoot, file)}`);