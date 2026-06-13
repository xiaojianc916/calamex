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

const findBlock = (text, marker) => {
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  const braceStart = text.indexOf('{', markerIndex);
  if (braceStart === -1) {
    return null;
  }

  let depth = 0;
  for (let index = braceStart; index < text.length; index += 1) {
    const char = text[index];

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return {
          start: markerIndex,
          end: index + 1,
          text: text.slice(markerIndex, index + 1),
        };
      }
    }
  }

  return null;
};

// 1. Decoration 渲染窗口 margin。
//    注意：这不是 token 预取范围。token cache 仍然可以大，Decoration 只给视口附近建。
//    专业编辑器的思路是：缓存可以前置，渲染对象必须跟着视口走，避免屏幕外装饰浪费。
insertAfterOnce(
  `const HIGHLIGHT_OVERSCAN_LINES = 72;
`,
  `
// DecorationSet 只需要覆盖真实视口附近。
// token 预取/缓存范围可以大，但 RangeSetBuilder 不应为大量屏幕外行重复创建 Decoration。
const DECORATION_RENDER_MARGIN_LINES = 8;
`,
  'add decoration render margin constant',
);

// 2. 只修改 renderViewportFromCache 内的 renderRange。
//    其他 tokenize / prefetch 逻辑继续使用 HIGHLIGHT_OVERSCAN_LINES，不削弱高亮缓存能力。
const methodMarker = `private renderViewportFromCache(view: EditorView): void`;
const methodBlock = findBlock(source, methodMarker);

if (!methodBlock) {
  fail('找不到 renderViewportFromCache 方法');
}

let nextMethod = methodBlock.text;

const oldRange = `      const renderRange = computeShikiHighlightRange({
        firstVisibleLine: visible.first,
        lastVisibleLine: visible.last,
        totalLines: view.state.doc.lines,
        overscanLines: HIGHLIGHT_OVERSCAN_LINES,
        leadInLines: HIGHLIGHT_OVERSCAN_LINES,
        fromDocumentStart: false,
      });`;

const newRange = `      const renderRange = computeShikiHighlightRange({
        firstVisibleLine: visible.first,
        lastVisibleLine: visible.last,
        totalLines: view.state.doc.lines,
        overscanLines: DECORATION_RENDER_MARGIN_LINES,
        leadInLines: DECORATION_RENDER_MARGIN_LINES,
        fromDocumentStart: false,
      });`;

if (!nextMethod.includes(newRange)) {
  const count = nextMethod.split(oldRange).length - 1;
  if (count !== 1) {
    fail(`renderViewportFromCache render range: expected 1 match, got ${count}`);
  }

  nextMethod = nextMethod.replace(oldRange, newRange);

  source =
    source.slice(0, methodBlock.start) +
    nextMethod +
    source.slice(methodBlock.end);
}

writeFileSync(absolutePath, source, 'utf8');

console.log('Applied round15 editor decoration window optimization.');
console.log('');
console.log('Touched:');
console.log(` - ${filePath}`);
console.log('');
console.log('Why:');
console.log(' - Keeps Shiki token prefetch/cache wide, but narrows CodeMirror DecorationSet construction to the visible window.');
console.log(' - Reduces RangeSetBuilder work during scroll without changing syntax highlighting behavior.');
console.log(' - Does not disable highlighting, does not change UI, and does not add dependencies.');
console.log('');
console.log('Next:');
console.log('  pnpm lint');
console.log('  pnpm typecheck');
console.log('  pnpm test src/services/editor/codemirror-shiki-highlight.spec.ts');
console.log('');
console.log('Experience check:');
console.log('  pnpm dev');
console.log('  Open a large script and scroll continuously up/down.');
console.log('');
console.log('Rollback:');
console.log(`  git checkout -- ${filePath}`);