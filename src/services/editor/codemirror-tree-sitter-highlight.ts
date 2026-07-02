import { type Extension, StateEffect, StateField, type Text } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { Language, Parser, Query } from 'web-tree-sitter';
import treeSitterWasmUrl from 'web-tree-sitter/web-tree-sitter.wasm?url';
import { computeBashSourceEdit, type Point, type Tree } from './tree-sitter/bash-runtime';
import {
  resolveTreeSitterLanguageId,
  TREE_SITTER_LANGUAGES,
} from './tree-sitter/language-registry.generated';

/**
 * 语言无关的 tree-sitter 实时高亮（参照 Zed：一棵 CST + 一次 .scm 查询遍历 + capture 映射颜色）。
 * 结构（缩进/折叠）仍由 Lezer 负责；颜色统一由本引擎出，Shiki 在编辑器缓冲区让位。
 */
const TS_HIGHLIGHT_DEBOUNCE_MS = 24;
const MAX_TS_SOURCE_LENGTH = 2_000_000; // 超大文件跳过，避免主线程长任务

// capture 名 -> CSS class；点分名右向左回退（function.method -> function）。
const CAPTURE_CLASS: Readonly<Record<string, string>> = {
  comment: 'cm-tsh-comment',
  string: 'cm-tsh-string',
  character: 'cm-tsh-string',
  'string.escape': 'cm-tsh-escape',
  escape: 'cm-tsh-escape',
  number: 'cm-tsh-number',
  float: 'cm-tsh-number',
  boolean: 'cm-tsh-constant',
  constant: 'cm-tsh-constant',
  function: 'cm-tsh-function',
  method: 'cm-tsh-function',
  constructor: 'cm-tsh-function',
  keyword: 'cm-tsh-keyword',
  conditional: 'cm-tsh-keyword',
  repeat: 'cm-tsh-keyword',
  type: 'cm-tsh-type',
  namespace: 'cm-tsh-type',
  attribute: 'cm-tsh-attribute',
  tag: 'cm-tsh-tag',
  label: 'cm-tsh-label',
};

function classForCapture(name: string): string | undefined {
  let key = name;
  for (;;) {
    const cls = CAPTURE_CLASS[key];
    if (cls) return cls;
    const dot = key.lastIndexOf('.');
    if (dot === -1) return undefined;
    key = key.slice(0, dot);
  }
}

const markCache = new Map<string, Decoration>();
function markFor(cls: string): Decoration {
  const hit = markCache.get(cls);
  if (hit) return hit;
  const mark = Decoration.mark({ class: cls });
  markCache.set(cls, mark);
  return mark;
}

// tree-sitter Point.column 以 UTF-8 字节计，需按行换算为 CodeMirror 的 UTF-16 字符列。
function byteColumnToChar(lineText: string, byteColumn: number): number {
  if (byteColumn <= 0) return 0;
  let bytes = 0;
  for (let index = 0; index < lineText.length; index += 1) {
    if (bytes >= byteColumn) return index;
    const code = lineText.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < lineText.length) {
      const next = lineText.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return lineText.length;
}

function posForPoint(doc: Text, point: Point): number {
  const lineNo = Math.min(Math.max(point.row, 0) + 1, doc.lines);
  const line = doc.line(lineNo);
  return Math.min(line.from + byteColumnToChar(line.text, point.column), doc.length);
}

// 每语言的 Parser / Query 单例缓存（tree-sitter 查询是为逐键解析设计的，编译一次即可复用）。
let corePromise: Promise<void> | null = null;
const languagePromises = new Map<string, Promise<Language>>();
const parserPromises = new Map<string, Promise<Parser>>();
const queryCache = new Map<string, Query>();

function ensureCore(): Promise<void> {
  if (!corePromise) {
    corePromise = Parser.init({ locateFile: () => treeSitterWasmUrl });
  }
  return corePromise;
}

function ensureLanguage(langId: string): Promise<Language> {
  let promise = languagePromises.get(langId);
  if (!promise) {
    const entry = TREE_SITTER_LANGUAGES[langId];
    promise = (async () => {
      await ensureCore();
      return Language.load(entry.wasmUrl);
    })();
    languagePromises.set(langId, promise);
  }
  return promise;
}

function ensureParser(langId: string): Promise<Parser> {
  let promise = parserPromises.get(langId);
  if (!promise) {
    promise = (async () => {
      const language = await ensureLanguage(langId);
      const parser = new Parser();
      parser.setLanguage(language);
      if (!queryCache.has(langId)) {
        queryCache.set(langId, new Query(language, TREE_SITTER_LANGUAGES[langId].scm));
      }
      return parser;
    })();
    parserPromises.set(langId, promise);
  }
  return promise;
}

const setTreeSitterDecorations = StateEffect.define<DecorationSet>();
const treeSitterDecorationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setTreeSitterDecorations)) next = effect.value;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

class TreeSitterHighlighter {
  private parser: Parser | null = null;
  private tree: Tree | null = null;
  private source: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly view: EditorView,
    private readonly langId: string,
  ) {
    this.source = view.state.doc.toString();
    void this.init();
  }

  private async init(): Promise<void> {
    try {
      const parser = await ensureParser(this.langId);
      if (this.disposed) return;
      this.parser = parser;
      this.reparse(true);
      this.publish();
    } catch {
      // 语法加载失败：保持无色，不影响编辑
    }
  }

  private reparse(full: boolean): void {
    if (!this.parser || this.source.length > MAX_TS_SOURCE_LENGTH) {
      this.tree = null;
      return;
    }
    const previous = this.tree;
    this.tree = this.parser.parse(this.source, full ? undefined : (previous ?? undefined));
    if (previous && previous !== this.tree) previous.delete();
  }

  update(update: ViewUpdate): void {
    if (!update.docChanged) return;
    const next = update.state.doc.toString();
    if (this.parser && this.tree && next.length <= MAX_TS_SOURCE_LENGTH) {
      this.tree.edit(computeBashSourceEdit(this.source, next));
      this.source = next;
      this.reparse(false);
    } else {
      this.source = next;
      this.reparse(true);
    }
    this.schedulePublish();
  }

  private schedulePublish(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.publish();
    }, TS_HIGHLIGHT_DEBOUNCE_MS);
  }

  private publish(): void {
    if (this.disposed) return;
    this.view.dispatch({ effects: setTreeSitterDecorations.of(this.build()) });
  }

  private build(): DecorationSet {
    const query = queryCache.get(this.langId);
    if (!query || !this.tree) return Decoration.none;
    const doc = this.view.state.doc;
    const items: Array<{ from: number; to: number; span: number; deco: Decoration }> = [];
    for (const capture of query.captures(this.tree.rootNode)) {
      const cls = classForCapture(capture.name);
      if (!cls) continue;
      const from = posForPoint(doc, capture.node.startPosition);
      const to = posForPoint(doc, capture.node.endPosition);
      if (to > from) items.push({ from, to, span: to - from, deco: markFor(cls) });
    }
    // 同起点时大范围在前，使更具体（更小）的 capture 嵌套在内层生效（对齐 tree-sitter 高亮语义）。
    items.sort((a, b) => a.from - b.from || b.span - a.span);
    return Decoration.set(
      items.map((item) => item.deco.range(item.from, item.to)),
      true,
    );
  }

  destroy(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.tree) {
      this.tree.delete();
      this.tree = null;
    }
  }
}

const treeSitterHighlightTheme = EditorView.baseTheme({
  // 取值对齐 GitHub Light Default（primer）；仅对 github-light 实际着色的类别上色，
  // 普通变量/参数/操作符/标点保持默认前景色，注释不用斜体——与 Shiki 那条线视觉一致。
  '.cm-tsh-comment': { color: '#6e7781' },
  '.cm-tsh-string': { color: '#0a3069' },
  '.cm-tsh-escape': { color: '#0550ae' },
  '.cm-tsh-number': { color: '#0550ae' },
  '.cm-tsh-constant': { color: '#0550ae' },
  '.cm-tsh-function': { color: '#8250df' },
  '.cm-tsh-keyword': { color: '#cf222e' },
  '.cm-tsh-type': { color: '#953800' },
  '.cm-tsh-attribute': { color: '#0550ae' },
  '.cm-tsh-tag': { color: '#116329' },
  '.cm-tsh-label': { color: '#0550ae' },
});

function treeSitterHighlightExtension(languageId: string): Extension {
  return [
    treeSitterDecorationField,
    ViewPlugin.define((view) => new TreeSitterHighlighter(view, languageId)),
    treeSitterHighlightTheme,
  ];
}

/** 若某语言已被 tree-sitter 覆盖，则在其扩展后追加高亮引擎；否则原样返回。 */
export function withTreeSitterHighlight(languageId: string, base: Extension): Extension {
  if (!Object.hasOwn(TREE_SITTER_LANGUAGES, languageId)) return base;
  return [base, treeSitterHighlightExtension(languageId)];
}

/** Shiki 编辑器高亮据此对被 tree-sitter 覆盖的语言让位。 */
export function isTreeSitterHighlightLanguage(language: string): boolean {
  return resolveTreeSitterLanguageId(language) !== null;
}
