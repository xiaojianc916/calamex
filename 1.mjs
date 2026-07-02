#!/usr/bin/env node
// 接线 tree-sitter 语言无关高亮引擎：
//   (1) 覆写 codemirror-tree-sitter-highlight.ts —— 语言无关引擎（增量解析 + capture→装饰）
//   (2) 编辑 codemirror-language.ts —— 还原 shell 加载器 + 给解析/加载出口套上 tree-sitter 高亮
//   (3) 编辑 codemirror-shiki-highlight.ts —— 把 Shiki 的关闭判定改为“凡 tree-sitter 覆盖的语言就关 Shiki”
// 支持 --dry 预览。锚点唯一性断言，改不动就报错，不猜。

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');
const EDITOR = resolve(ROOT, 'src/services/editor');
const ENGINE_FILE = resolve(EDITOR, 'codemirror-tree-sitter-highlight.ts');
const LANG_FILE = resolve(EDITOR, 'codemirror-language.ts');
const SHIKI_FILE = resolve(EDITOR, 'codemirror-shiki-highlight.ts');

function replaceOnce(source, oldStr, newStr, label) {
  const idx = source.indexOf(oldStr);
  if (idx === -1) throw new Error('找不到锚点: ' + label);
  if (source.indexOf(oldStr, idx + oldStr.length) !== -1) throw new Error('锚点不唯一: ' + label);
  return source.slice(0, idx) + newStr + source.slice(idx + oldStr.length);
}

// ────────────────────────────────────────────────────────────
// (1) 语言无关引擎（注意：内部不用反引号/模板占位，方便这里整体嵌入）
// ────────────────────────────────────────────────────────────
const ENGINE_SOURCE = `// @generated-by scaffold-tree-sitter-engine.mjs —— 语言无关 tree-sitter 高亮引擎。
// 语法 wasm 走注册表、每语言自带 highlights.scm、capture→主题类映射（参照 Zed 架构，独立 TS 实现）。
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { StateEffect, StateField } from '@codemirror/state';
import type { Extension, Text } from '@codemirror/state';
import { Edit, Language, Parser, Query } from 'web-tree-sitter';
import type { Point, Tree } from 'web-tree-sitter';
import treeSitterWasmUrl from 'web-tree-sitter/web-tree-sitter.wasm?url';
import { logger } from '@/utils/platform/logger';
import {
  TREE_SITTER_LANGUAGES,
  resolveTreeSitterLanguageId,
} from './tree-sitter/language-registry.generated';

const TS_HIGHLIGHT_DEBOUNCE_MS = 24;
const MAX_TS_SOURCE_LENGTH = 2_000_000;

// —— UTF-8 字节工具（tree-sitter 的 point/index 以字节计） ——
const encoder = new TextEncoder();
const utf8Len = (str: string): number => encoder.encode(str).length;

const codePointUtf8 = (cp: number): number =>
  cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;

const byteColumnToChar = (lineText: string, byteColumn: number): number => {
  let bytes = 0;
  let i = 0;
  while (i < lineText.length) {
    if (bytes >= byteColumn) return i;
    const cp = lineText.codePointAt(i) ?? 0;
    bytes += codePointUtf8(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return lineText.length;
};

const pointAt = (doc: string, charIndex: number): Point => {
  let row = 0;
  let lineStart = 0;
  for (let i = 0; i < charIndex; i++) {
    if (doc.charCodeAt(i) === 10) {
      row++;
      lineStart = i + 1;
    }
  }
  return { row, column: utf8Len(doc.slice(lineStart, charIndex)) };
};

const computeSourceEdit = (oldDoc: string, newDoc: string): Edit => {
  const oldLen = oldDoc.length;
  const newLen = newDoc.length;
  let start = 0;
  const maxStart = Math.min(oldLen, newLen);
  while (start < maxStart && oldDoc.charCodeAt(start) === newDoc.charCodeAt(start)) start++;
  let oldEnd = oldLen;
  let newEnd = newLen;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldDoc.charCodeAt(oldEnd - 1) === newDoc.charCodeAt(newEnd - 1)
  ) {
    oldEnd--;
    newEnd--;
  }
  const startByte = utf8Len(oldDoc.slice(0, start));
  return new Edit({
    startIndex: startByte,
    oldEndIndex: startByte + utf8Len(oldDoc.slice(start, oldEnd)),
    newEndIndex: startByte + utf8Len(newDoc.slice(start, newEnd)),
    startPosition: pointAt(oldDoc, start),
    oldEndPosition: pointAt(oldDoc, oldEnd),
    newEndPosition: pointAt(newDoc, newEnd),
  });
};

const posForPoint = (doc: Text, point: Point): number => {
  const line = doc.line(Math.min(point.row + 1, doc.lines));
  return line.from + byteColumnToChar(line.text, point.column);
};

// —— capture 名 → 主题类（点分从右往左回退 + 若干直命中，覆盖 nvim 标准 capture） ——
const DOTTED_CLASS: Record<string, string> = {
  'string.escape': 'escape',
  'string.regexp': 'string',
  'string.special': 'string',
  'variable.parameter': 'parameter',
  'variable.member': 'property',
  'variable.builtin': 'variable',
  'function.builtin': 'function',
  'function.method': 'function',
  'function.call': 'function',
  'type.builtin': 'type',
  'constant.builtin': 'constant',
  'keyword.function': 'keyword',
  'keyword.return': 'keyword',
  'keyword.operator': 'operator',
  'punctuation.bracket': 'punctuation',
  'punctuation.delimiter': 'punctuation',
};
const BASE_CLASS: Record<string, string> = {
  comment: 'comment',
  string: 'string',
  character: 'string',
  escape: 'escape',
  number: 'number',
  boolean: 'constant',
  constant: 'constant',
  constructor: 'function',
  variable: 'variable',
  parameter: 'parameter',
  property: 'property',
  module: 'variable',
  type: 'type',
  attribute: 'attribute',
  function: 'function',
  keyword: 'keyword',
  operator: 'operator',
  tag: 'tag',
  label: 'label',
  punctuation: 'punctuation',
};

const classForCapture = (name: string): string | null => {
  const dotted = DOTTED_CLASS[name];
  if (dotted) return dotted;
  let n = name;
  while (n) {
    const base = BASE_CLASS[n];
    if (base) return base;
    const dot = n.lastIndexOf('.');
    if (dot < 0) break;
    n = n.slice(0, dot);
  }
  return null;
};

// —— 语言 bundle 缓存（每语言只加载一次 Language + 编译一次 Query） ——
type LanguageBundle = { language: Language; query: Query };
let corePromise: Promise<void> | null = null;
const bundleCache = new Map<string, Promise<LanguageBundle | null>>();

const ensureCore = (): Promise<void> => {
  if (!corePromise) corePromise = Parser.init({ locateFile: () => treeSitterWasmUrl });
  return corePromise;
};

const ensureLanguageBundle = (languageId: string): Promise<LanguageBundle | null> => {
  const cached = bundleCache.get(languageId);
  if (cached) return cached;
  const entry = TREE_SITTER_LANGUAGES[languageId];
  const promise = (async (): Promise<LanguageBundle | null> => {
    if (!entry) return null;
    await ensureCore();
    const language = await Language.load(entry.wasmUrl);
    try {
      return { language, query: new Query(language, entry.scm) };
    } catch (error) {
      logger.warn('[tree-sitter] highlights.scm 编译失败，跳过 ' + languageId, error);
      return null;
    }
  })();
  bundleCache.set(languageId, promise);
  return promise;
};

// —— 装饰状态字段（单例，靠 effect 整体替换） ——
const setTreeSitterDecorations = StateEffect.define<DecorationSet>();
const treeSitterField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (deco, tr) => {
    let next = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setTreeSitterDecorations)) next = effect.value;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const buildDecorations = (view: EditorView, tree: Tree, query: Query): DecorationSet => {
  const doc = view.state.doc;
  const ranges: Array<{ from: number; to: number; cls: string }> = [];
  for (const capture of query.captures(tree.rootNode)) {
    const cls = classForCapture(capture.name);
    if (!cls) continue;
    const from = posForPoint(doc, capture.node.startPosition);
    const to = posForPoint(doc, capture.node.endPosition);
    if (to <= from) continue;
    ranges.push({ from, to, cls });
  }
  ranges.sort((a, b) => a.from - b.from || b.to - b.from - (a.to - a.from));
  return Decoration.set(
    ranges.map((r) => Decoration.mark({ class: 'cm-tsh-' + r.cls }).range(r.from, r.to)),
    true,
  );
};

const treeSitterHighlighter = (languageId: string) =>
  ViewPlugin.fromClass(
    class {
      private parser: Parser | null = null;
      private query: Query | null = null;
      private tree: Tree | null = null;
      private lastSrc: string | null = null;
      private timer: number | null = null;
      private disposed = false;

      constructor(private readonly view: EditorView) {
        void this.init();
      }

      private async init(): Promise<void> {
        const bundle = await ensureLanguageBundle(languageId);
        if (this.disposed || !bundle) return;
        const parser = new Parser();
        parser.setLanguage(bundle.language);
        this.parser = parser;
        this.query = bundle.query;
        this.reparse();
      }

      update(update: ViewUpdate): void {
        if (update.docChanged && this.parser) this.schedule();
      }

      private schedule(): void {
        if (this.timer !== null) return;
        this.timer = window.setTimeout(() => {
          this.timer = null;
          if (!this.disposed) this.reparse();
        }, TS_HIGHLIGHT_DEBOUNCE_MS);
      }

      private reparse(): void {
        if (!this.parser || !this.query) return;
        const src = this.view.state.doc.toString();
        if (src.length > MAX_TS_SOURCE_LENGTH) return;
        let tree: Tree | null;
        if (this.tree && this.lastSrc !== null) {
          this.tree.edit(computeSourceEdit(this.lastSrc, src));
          tree = this.parser.parse(src, this.tree);
        } else {
          tree = this.parser.parse(src);
        }
        if (!tree) return;
        if (this.tree && this.tree !== tree) this.tree.delete();
        this.tree = tree;
        this.lastSrc = src;
        this.view.dispatch({ effects: setTreeSitterDecorations.of(buildDecorations(this.view, tree, this.query)) });
      }

      destroy(): void {
        this.disposed = true;
        if (this.timer !== null) window.clearTimeout(this.timer);
        if (this.tree) this.tree.delete();
        this.tree = null;
      }
    },
  );

const treeSitterHighlightTheme = EditorView.baseTheme({
  '.cm-tsh-comment': { color: '#6e7781', fontStyle: 'italic' },
  '.cm-tsh-string': { color: '#0a3069' },
  '.cm-tsh-escape': { color: '#0550ae' },
  '.cm-tsh-number': { color: '#0550ae' },
  '.cm-tsh-constant': { color: '#0550ae' },
  '.cm-tsh-variable': { color: '#953800' },
  '.cm-tsh-parameter': { color: '#953800' },
  '.cm-tsh-property': { color: '#0550ae' },
  '.cm-tsh-type': { color: '#953800' },
  '.cm-tsh-attribute': { color: '#0550ae' },
  '.cm-tsh-function': { color: '#8250df' },
  '.cm-tsh-keyword': { color: '#cf222e' },
  '.cm-tsh-operator': { color: '#0550ae' },
  '.cm-tsh-tag': { color: '#116329' },
  '.cm-tsh-label': { color: '#0550ae' },
  '.cm-tsh-punctuation': { color: '#24292f' },
});

export const isTreeSitterHighlightLanguage = (language: string): boolean =>
  resolveTreeSitterLanguageId(language) !== null;

export const treeSitterHighlightExtension = (languageId: string): Extension => [
  treeSitterField,
  treeSitterHighlighter(languageId),
  treeSitterHighlightTheme,
];

export const withTreeSitterHighlight = (language: string, base: Extension): Extension => {
  const id = resolveTreeSitterLanguageId(language);
  if (!id) return base;
  return [base, treeSitterHighlightExtension(id)];
};
`;

// ────────────────────────────────────────────────────────────
// (2) codemirror-language.ts 的三处编辑
// ────────────────────────────────────────────────────────────
function patchLanguageFile(src) {
  let out = src;

  // a. logger 之后加引入
  out = replaceOnce(
    out,
    "import { logger } from '@/utils/platform/logger';",
    "import { logger } from '@/utils/platform/logger';\nimport { withTreeSitterHighlight } from './codemirror-tree-sitter-highlight';",
    'logger import',
  );

  // b. 还原 shell 加载器（撤掉 Promise.all，回到纯 Lezer 结构加载；颜色交给统一引擎）
  out = replaceOnce(
    out,
    "  shell: () =>\n" +
      "    Promise.all([\n" +
      "      import('./codemirror-bash-language'),\n" +
      "      import('./codemirror-tree-sitter-highlight'),\n" +
      "    ]).then(([lang, highlight]) => [\n" +
      "      lang.bashLanguageExtensions(),\n" +
      "      highlight.bashTreeSitterHighlightExtension(),\n" +
      "    ]),",
    "  shell: () =>\n    import('./codemirror-bash-language').then((m) => m.bashLanguageExtensions()),",
    'shell loader revert',
  );

  // c. 同步出口套上 tree-sitter 高亮
  out = replaceOnce(
    out,
    "export const resolveCodeMirrorLanguageExtension = (language: string): Extension => {\n" +
      "  return resolveCodeMirrorLanguageSupport(language) ?? [];\n" +
      "};",
    "export const resolveCodeMirrorLanguageExtension = (language: string): Extension => {\n" +
      "  const support = resolveCodeMirrorLanguageSupport(language) ?? [];\n" +
      "  return withTreeSitterHighlight(language, support);\n" +
      "};",
    'resolveCodeMirrorLanguageExtension',
  );

  // d. 异步出口套上 tree-sitter 高亮
  out = replaceOnce(
    out,
    "export const loadCodeMirrorLanguageExtension = async (language: string): Promise<Extension> => {\n" +
      "  return (await loadCodeMirrorLanguageSupport(language)) ?? [];\n" +
      "};",
    "export const loadCodeMirrorLanguageExtension = async (language: string): Promise<Extension> => {\n" +
      "  const support = (await loadCodeMirrorLanguageSupport(language)) ?? [];\n" +
      "  return withTreeSitterHighlight(language, support);\n" +
      "};",
    'loadCodeMirrorLanguageExtension',
  );

  return out;
}

// ────────────────────────────────────────────────────────────
// (3) codemirror-shiki-highlight.ts 的两处编辑
// ────────────────────────────────────────────────────────────
function patchShikiFile(src) {
  let out = src;

  out = replaceOnce(
    out,
    "import {\n" +
      "  type IShikiThemedToken,\n" +
      "  resolveShikiLanguageId,\n" +
      "  SHIKI_BACKGROUND,\n" +
      "  SHIKI_FOREGROUND,\n" +
      "} from '@/services/editor/shiki-shared';",
    "import {\n" +
      "  type IShikiThemedToken,\n" +
      "  resolveShikiLanguageId,\n" +
      "  SHIKI_BACKGROUND,\n" +
      "  SHIKI_FOREGROUND,\n" +
      "} from '@/services/editor/shiki-shared';\n" +
      "import { isTreeSitterHighlightLanguage } from '@/services/editor/codemirror-tree-sitter-highlight';",
    'shiki-shared import',
  );

  out = replaceOnce(
    out,
    "const isEditorTreeSitterLanguage = (language: string): boolean =>\n" +
      "  resolveShikiLanguageId(language) === 'bash';",
    "const isEditorTreeSitterLanguage = (language: string): boolean =>\n" +
      "  isTreeSitterHighlightLanguage(language);",
    'shiki tree-sitter guard',
  );

  return out;
}

// ────────────────────────────────────────────────────────────
// 落地
// ────────────────────────────────────────────────────────────
function main() {
  const langSrc = readFileSync(LANG_FILE, 'utf8');
  const shikiSrc = readFileSync(SHIKI_FILE, 'utf8');

  const nextLang = patchLanguageFile(langSrc);
  const nextShiki = patchShikiFile(shikiSrc);

  if (DRY) {
    console.log('[dry] 覆写引擎:', ENGINE_FILE, '(', ENGINE_SOURCE.length, 'chars )');
    console.log('[dry] 编辑:', LANG_FILE, '→', nextLang.length - langSrc.length, 'Δchars');
    console.log('[dry] 编辑:', SHIKI_FILE, '→', nextShiki.length - shikiSrc.length, 'Δchars');
    console.log('锚点全部命中且唯一。去掉 --dry 即落地。');
    return;
  }

  writeFileSync(ENGINE_FILE, ENGINE_SOURCE, 'utf8');
  writeFileSync(LANG_FILE, nextLang, 'utf8');
  writeFileSync(SHIKI_FILE, nextShiki, 'utf8');
  console.log('✔ 引擎已覆写，两处接线已完成。');
}

main();