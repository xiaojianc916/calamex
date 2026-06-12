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

const countRegexMatches = (pattern) => {
  const globalPattern = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
  return [...source.matchAll(globalPattern)].length;
};

const replaceRegexOnce = (pattern, replacement, label) => {
  if (source.includes(replacement)) {
    return;
  }

  const count = countRegexMatches(pattern);
  if (count !== 1) {
    fail(`${label}: expected 1 match, got ${count}`);
  }

  source = source.replace(pattern, replacement);
};

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

// 1. 降低滚动时同步高亮窗口，避免几百/几千行文件滚动时主线程被 Shiki tokenize 抢占。
replaceRegexOnce(
  /const MAX_SYNC_HIGHLIGHT_SLICE_LENGTH = \d[\d_]*;/,
  'const MAX_SYNC_HIGHLIGHT_SLICE_LENGTH = 20_000;',
  'tune max sync highlight slice length',
);

replaceRegexOnce(
  /const HIGHLIGHT_OVERSCAN_LINES = \d[\d_]*;/,
  'const HIGHLIGHT_OVERSCAN_LINES = 48;',
  'tune highlight overscan lines',
);

replaceRegexOnce(
  /const SYNC_HIGHLIGHT_LEAD_IN_LINES = \d[\d_]*;/,
  'const SYNC_HIGHLIGHT_LEAD_IN_LINES = 80;',
  'tune sync highlight lead-in lines',
);

// 2. 关键修复：滚动触发的 viewportChanged 不再在当前 CodeMirror update 里同步 tokenize。
//    先用缓存同步渲染，让虚拟滚动 DOM 首帧出来；缺失的高亮下一帧再补。
insertAfterOnce(
  `      if (action === 'recompute') {
`,
  `        if (update.viewportChanged && !languageChanged && !recomputeRequested) {
          // 滚动必须优先保证 CodeMirror 的虚拟 DOM 首帧补齐。
          // 旧逻辑会在 viewportChanged 的当前 update 内同步 Shiki tokenize，
          // 几百行文件快速滚动时容易堵住渲染线程，表现为大片空白/延迟加载。
          // 这里先用按行缓存立即重建已有装饰；新滚入区域的高亮延后一帧补齐。
          this.renderViewportFromCache(update.view);
          this.schedulePostPaintRecompute(update.view);
          return;
        }

`,
  'defer viewport highlight recompute',
);

writeFileSync(absolutePath, source, 'utf8');

console.log('Applied round11 editor scroll optimization.');
console.log('');
console.log('Touched:');
console.log(` - ${filePath}`);
console.log('');
console.log('Why:');
console.log(' - Stops Shiki syntax highlighting from synchronously tokenizing during scroll.');
console.log(' - Lets CodeMirror virtual scrolling paint text/rows first, then fills missing highlights after paint.');
console.log(' - Reduces sync highlight window size to avoid blocking the UI thread.');
console.log('');
console.log('Next:');
console.log('  pnpm lint');
console.log('  pnpm typecheck');
console.log('  pnpm test');
console.log('');
console.log('Rollback:');
console.log(`  git checkout -- ${filePath}`);