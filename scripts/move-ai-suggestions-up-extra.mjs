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

const paddingCandidates = [
  'padding: clamp(64px, 20vh, 200px) 16px 0;',
  'padding: clamp(28px, 11vh, 112px) 16px 0;',
  'padding: clamp(0px, 6vh, 56px) 16px 0;',
  'padding: 0 16px 0;',
];

const currentPadding = paddingCandidates.find((candidate) => source.includes(candidate));

if (!currentPadding) {
  fail('[guard] 找不到建议区 padding，请贴 AiAssistantSuggestionEmpty.vue 当前样式。');
}

source = source.replace(currentPadding, 'padding: 0 16px 0;');

const existingTransformPattern =
  /  transform:\s*translateY\(clamp\(-?\d+px,\s*-?\d+vh,\s*-?\d+px\)\);/;

if (existingTransformPattern.test(source)) {
  source = source.replace(
    existingTransformPattern,
    '  transform: translateY(clamp(-180px, -16vh, -96px));',
  );
} else {
  const anchor = `  min-width: 0;
  gap:`;

  if (!source.includes(anchor)) {
    fail('[guard] 找不到建议区插入位置，请贴 AiAssistantSuggestionEmpty.vue 当前样式。');
  }

  source = source.replace(
    anchor,
    `  min-width: 0;
  transform: translateY(clamp(-180px, -16vh, -96px));
  gap:`,
  );
}

fs.writeFileSync(file, source);

console.log('✅ Moved AI suggestions much further upward');
console.log(`📝 Updated: ${path.relative(repoRoot, file)}`);