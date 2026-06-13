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

const candidates = [
  'padding: clamp(64px, 20vh, 200px) 16px 0;',
  'padding: clamp(28px, 11vh, 112px) 16px 0;',
  'padding: clamp(0px, 6vh, 56px) 16px 0;',
  'padding: 0 16px 0;',
];

const current = candidates.find((candidate) => source.includes(candidate));

if (!current) {
  fail('[guard] 找不到建议区 padding，请贴 AiAssistantSuggestionEmpty.vue 当前样式。');
}

if (current === 'padding: 0 16px 0;') {
  console.log('✅ AI suggestions already at max upward position');
  process.exit(0);
}

source = source.replace(current, 'padding: 0 16px 0;');

fs.writeFileSync(file, source);

console.log('✅ Moved AI suggestions to max upward position');
console.log(`📝 Updated: ${path.relative(repoRoot, file)}`);