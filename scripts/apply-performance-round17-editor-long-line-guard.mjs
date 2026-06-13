#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const filePath = 'src/services/editor/codemirror-shiki-highlight.ts';
const absolutePath = resolve(root, filePath);

const fail = (message) => {
  throw new Error(`[${filePath}] ${message}`);
};

let source = readFileSync(absolutePath, 'utf8');

const insertAfterOnce = (anchor, insertion, label) => {
  if (source.includes(insertion.trim())) {
    return;
  }

  const count = source.split(anchor).length - 1;
  if (count !== 1) {
    fail(`${label}: expected 1 anchor match, got ${count}`);
  }

  source = source.replace(anchor, `${anchor}${insertion}`);
};

const replaceOnce = (oldText, newText, label) => {
  if (source.includes(newText.trim())) {
    return;
  }

  const count = source.split(oldText).length - 1;
  if (count !== 1) {
    fail(`${label}: expected 1 match, got ${count}`);
  }

  source = source.replace(oldText, newText);
};

// 1. 超长行保护阈值。
//    VS Code / Monaco 这类专业编辑器也会对超长行做 tokenization guard。
//    这里不是关闭文件高亮，只是跳过极端超长单行的 Decoration 构建，避免一行拖垮滚动/布局。
const preferredAnchor = `const MAX_LINE_TOKEN_CACHE_LINES = 20_000;
`;
const fallbackAnchor = `const MAX_LINE_TOKEN_CACHE_LINES = 6_000;
`;

if (source.includes(preferredAnchor)) {
  insertAfterOnce(
    preferredAnchor,
    `
// 超长单行保护：正常代码不受影响；minified/bundle/base64/压缩 JSON 等极端长行
// 不为该行构建大量 Decoration，避免 RangeSetBuilder 与布局测量被单行拖垮。
const MAX_DECORATED_LINE_LENGTH = 20_000;
const MAX_DECORATED_LINE_TOKEN_COUNT = 2_000;
`,
    'add long line decoration guard constants after 20k cache',
  );
} else if (source.includes(fallbackAnchor)) {
  insertAfterOnce(
    fallbackAnchor,
    `
// 超长单行保护：正常代码不受影响；minified/bundle/base64/压缩 JSON 等极端长行
// 不为该行构建大量 Decoration，避免 RangeSetBuilder 与布局测量被单行拖垮。
const MAX_DECORATED_LINE_LENGTH = 20_000;
const MAX_DECORATED_LINE_TOKEN_COUNT = 2_000;
`,
    'add long line decoration guard constants after 6k cache',
  );
} else if (!source.includes('const MAX_DECORATED_LINE_LENGTH = 20_000;')) {
  fail('找不到 MAX_LINE_TOKEN_CACHE_LINES 常量锚点');
}

// 2. 在 DecorationSet 构建处跳过极端超长行。
//    注意：这里不影响 token cache，也不影响文件内容；只是避免为一行创建海量 Decoration。
replaceOnce(
  `    const docLine = doc.line(lineNumber);
    let position = docLine.from;`,
  `    const docLine = doc.line(lineNumber);

    if (
      docLine.length > MAX_DECORATED_LINE_LENGTH ||
      lineTokens.length > MAX_DECORATED_LINE_TOKEN_COUNT
    ) {
      continue;
    }

    let position = docLine.from;`,
  'skip decoration building for pathological long lines',
);

writeFileSync(absolutePath, source, 'utf8');

console.log('Applied round17 editor long-line guard optimization.');
console.log('');
console.log('Touched:');
console.log(` - ${filePath}`);
console.log('');
console.log('Why:');
console.log(' - Protects scrolling/layout from pathological minified or compressed single-line files.');
console.log(' - Keeps normal code highlighting unchanged.');
console.log(' - Skips only Decoration construction for extreme long lines, not the whole file.');
console.log(' - Matches professional editor behavior: max tokenization/decoration budget per line.');
console.log('');
console.log('Next:');
console.log('  pnpm lint');
console.log('  pnpm typecheck');
console.log('  pnpm test src/services/editor/codemirror-shiki-highlight.spec.ts');
console.log('');
console.log('Experience check:');
console.log('  pnpm dev');
console.log('  Open normal large code files and minified/bundle-like files.');
console.log('');
console.log('Rollback:');
console.log(`  git checkout -- ${filePath}`);