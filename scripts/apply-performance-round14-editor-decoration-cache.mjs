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
  if (source.includes(replacement.trim())) {
    return;
  }

  const count = countRegexMatches(pattern);
  if (count !== 1) {
    fail(`${label}: expected 1 match, got ${count}`);
  }

  source = source.replace(pattern, replacement);
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

// 1. 提高按行 token cache 上限。
//    这不会影响功能，只是减少大文件来回滚动时的重新 tokenize 概率。
replaceRegexOnce(
  /const MAX_LINE_TOKEN_CACHE_LINES = \d[\d_]*;/,
  'const MAX_LINE_TOKEN_CACHE_LINES = 20_000;',
  'increase line token cache limit',
);

// 2. 给 ViewPlugin 增加 DecorationSet 渲染缓存状态。
//    lineTokenCacheRevision 只在 token cache 变更/失效时递增。
//    decorationCacheKey 命中时，renderViewportFromCache 不再重复 build RangeSet。
insertAfterOnce(
  `    private cacheDocVersion = -1;
`,
  `    private lineTokenCacheRevision = 0;
    private decorationCacheKey: string | null = null;
    private decorationCache: DecorationSet | null = null;
`,
  'add decoration cache fields',
);

// 3. destroy 时顺手释放缓存。
replaceOnce(
  `      this.pendingRequest = null;
      this.lineTokenCache.clear();`,
  `      this.pendingRequest = null;
      this.lineTokenCache.clear();
      this.decorationCacheKey = null;
      this.decorationCache = null;`,
  'clear decoration cache on destroy',
);

// 4. 语言 / 文档版本变化时，token cache 和 decoration cache 一起失效。
replaceOnce(
  `    private ensureCacheContext(language: string): void {
      if (this.cacheLanguage !== language || this.cacheDocVersion !== this.docVersion) {
        this.lineTokenCache.clear();
        this.cacheLanguage = language;
        this.cacheDocVersion = this.docVersion;
      }
    }`,
  `    private ensureCacheContext(language: string): void {
      if (this.cacheLanguage !== language || this.cacheDocVersion !== this.docVersion) {
        this.lineTokenCache.clear();
        this.lineTokenCacheRevision += 1;
        this.decorationCacheKey = null;
        this.decorationCache = null;
        this.cacheLanguage = language;
        this.cacheDocVersion = this.docVersion;
      }
    }`,
  'invalidate decoration cache with token cache context',
);

// 5. 写入新 token 后递增 revision，并让 DecorationSet 缓存失效。
//    注意：只要 token cache 内容变化，之前 build 出来的 DecorationSet 就不能复用。
replaceOnce(
  `    private cacheSliceLines(sliceStartLine: number, lines: IShikiThemedToken[][]): void {
      for (let index = 0; index < lines.length; index += 1) {
        this.lineTokenCache.set(sliceStartLine + index, lines[index] ?? []);
      }
      while (this.lineTokenCache.size > MAX_LINE_TOKEN_CACHE_LINES) {`,
  `    private cacheSliceLines(sliceStartLine: number, lines: IShikiThemedToken[][]): void {
      for (let index = 0; index < lines.length; index += 1) {
        this.lineTokenCache.set(sliceStartLine + index, lines[index] ?? []);
      }
      if (lines.length > 0) {
        this.lineTokenCacheRevision += 1;
        this.decorationCacheKey = null;
        this.decorationCache = null;
      }
      while (this.lineTokenCache.size > MAX_LINE_TOKEN_CACHE_LINES) {`,
  'invalidate decoration cache after caching token lines',
);

// 6. 如果不支持该语言而清空高亮，也清理 DecorationSet 缓存。
replaceOnce(
  `        this.decorations = Decoration.none;
        this.lineTokenCache.clear();
        this.cacheLanguage = null;
        this.cacheDocVersion = -1;
        this.pendingRequest = null;
        return;`,
  `        this.decorations = Decoration.none;
        this.lineTokenCache.clear();
        this.lineTokenCacheRevision += 1;
        this.decorationCacheKey = null;
        this.decorationCache = null;
        this.cacheLanguage = null;
        this.cacheDocVersion = -1;
        this.pendingRequest = null;
        return;`,
  'clear decoration cache for unsupported language',
);

// 7. 核心优化：renderViewportFromCache 命中相同范围 + 相同 token revision 时，直接复用 DecorationSet。
//    这避免“token 已缓存，但每次滚动仍重复 RangeSetBuilder”的浪费。
replaceOnce(
  `      this.decorations = buildDecorationsFromLineCache(
        view,
        renderRange.startLine,
        renderRange.endLine,
        this.lineTokenCache,
      );`,
  `      const renderCacheKey = [
        this.cacheLanguage ?? '',
        this.cacheDocVersion,
        this.lineTokenCacheRevision,
        renderRange.startLine,
        renderRange.endLine,
      ].join(':');

      if (this.decorationCacheKey === renderCacheKey && this.decorationCache) {
        this.decorations = this.decorationCache;
        return;
      }

      const decorations = buildDecorationsFromLineCache(
        view,
        renderRange.startLine,
        renderRange.endLine,
        this.lineTokenCache,
      );
      this.decorationCacheKey = renderCacheKey;
      this.decorationCache = decorations;
      this.decorations = decorations;`,
  'cache viewport decoration set',
);

writeFileSync(absolutePath, source, 'utf8');

console.log('Applied round14 editor DecorationSet cache optimization.');
console.log('');
console.log('Touched:');
console.log(` - ${filePath}`);
console.log('');
console.log('Why:');
console.log(' - Reuses DecorationSet when the rendered line range and token cache revision are unchanged.');
console.log(' - Avoids rebuilding CodeMirror RangeSet from cached Shiki tokens on repeated scroll updates.');
console.log(' - Increases line token cache to reduce re-tokenization when scrolling back through large files.');
console.log('');
console.log('Next:');
console.log('  pnpm lint');
console.log('  pnpm typecheck');
console.log('  pnpm test src/services/editor/codemirror-shiki-highlight.spec.ts');
console.log('');
console.log('Experience check:');
console.log('  pnpm dev');
console.log('  Open a large script and scroll slowly, then fast-scroll repeatedly.');
console.log('');
console.log('Rollback:');
console.log(`  git checkout -- ${filePath}`);