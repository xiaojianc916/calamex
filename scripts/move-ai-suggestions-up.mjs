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

if (!source.includes('.ai-suggestion-empty')) {
  fail('[guard] AiAssistantSuggestionEmpty.vue 结构异常，请贴当前文件内容。');
}

const pattern = /padding:\s*clamp\(\s*64px\s*,\s*20vh\s*,\s*200px\s*\)\s+16px\s+0;/;

if (!pattern.test(source)) {
  const alreadyPattern = /padding:\s*clamp\(\s*28px\s*,\s*11vh\s*,\s*112px\s*\)\s+16px\s+0;/;

  if (alreadyPattern.test(source)) {
    console.log('✅ AI suggestions already moved up');
    process.exit(0);
  }

  fail('[guard] 找不到原来的建议区 padding，请贴 AiAssistantSuggestionEmpty.vue 当前样式。');
}

source = source.replace(
  pattern,
  'padding: clamp(28px, 11vh, 112px) 16px 0;',
);

fs.writeFileSync(file, source);

console.log('✅ Moved AI suggestions upward');
console.log(`📝 Updated: ${path.relative(repoRoot, file)}`);