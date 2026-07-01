import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';

import { bashAnalysisField } from './codemirror-bash-language';
import type { Node, Tree } from './tree-sitter/bash-runtime';

/**
 * 参照 Zed：一棵 CST + 一次深度优先遍历，capture 分类 → CSS class（主题与语言解耦）。
 * 本模块不做任何解析——直接消费 codemirror-bash-language 里已增量维护的 bashAnalysisField，
 * 因此相对 Shiki 补丁层是近零成本。
 */
const HIGHLIGHT_OVERSCAN_ROWS = 48;

// 节点类型 → 标准 capture 分类 → CSS class（对齐 Zed/neovim 的 capture 命名习惯）
const LEAF_TYPE_CLASS: Record<string, string> = {
  comment: 'cm-ts-comment',
  string_content: 'cm-ts-string',
  raw_string: 'cm-ts-string',
  ansi_c_string: 'cm-ts-string',
  '"': 'cm-ts-string',
  "'": 'cm-ts-string',
  heredoc_body: 'cm-ts-string',
  heredoc_start: 'cm-ts-string',
  heredoc_end: 'cm-ts-string',
  variable_name: 'cm-ts-variable',
  special_variable_name: 'cm-ts-variable',
  number: 'cm-ts-number',
  test_operator: 'cm-ts-operator',
  if: 'cm-ts-keyword',
  // biome-ignore lint/suspicious/noThenProperty: bash tree-sitter 关键字节点名，必须保留字面量 then
  then: 'cm-ts-keyword',
  else: 'cm-ts-keyword',
  elif: 'cm-ts-keyword',
  fi: 'cm-ts-keyword',
  for: 'cm-ts-keyword',
  while: 'cm-ts-keyword',
  until: 'cm-ts-keyword',
  do: 'cm-ts-keyword',
  done: 'cm-ts-keyword',
  case: 'cm-ts-keyword',
  esac: 'cm-ts-keyword',
  in: 'cm-ts-keyword',
  function: 'cm-ts-keyword',
  select: 'cm-ts-keyword',
};

// 整块着色、不再下钻的容器节点
const CONTAINER_TYPE_CLASS: Record<string, string> = {
  command_name: 'cm-ts-function',
};

const markCache = new Map<string, Decoration>();
function markFor(className: string): Decoration {
  const cached = markCache.get(className);
  if (cached) return cached;
  const mark = Decoration.mark({ class: className });
  markCache.set(className, mark);
  return mark;
}

// tree-sitter Point.column 以 UTF-8 字节计；CodeMirror 以 UTF-16 char 计，需按行换算。
function byteColumnToChar(lineText: string, byteColumn: number): number {
  if (byteColumn <= 0) return 0;
  let bytes = 0;
  for (let i = 0; i < lineText.length; i += 1) {
    if (bytes >= byteColumn) return i;
    const code = lineText.codePointAt(i) ?? 0;
    if (code > 0xffff) i += 1; // 代理对
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return lineText.length;
}

function getChildren(node: Node): Node[] {
  if (Array.isArray(node.children)) return node.children;
  const out: Node[] = [];
  const count = node.childCount ?? 0;
  for (let i = 0; i < count; i += 1) {
    const child = node.child(i);
    if (child) out.push(child);
  }
  return out;
}

function buildBashDecorations(view: EditorView, tree: Tree | null): DecorationSet {
  if (!tree) return Decoration.none;
  const { doc } = view.state;
  const { from, to } = view.viewport;
  const minRow = Math.max(0, doc.lineAt(from).number - 1 - HIGHLIGHT_OVERSCAN_ROWS);
  const maxRow = Math.min(doc.lines - 1, doc.lineAt(to).number - 1 + HIGHLIGHT_OVERSCAN_ROWS);

  const ranges: Array<{ from: number; to: number; deco: Decoration }> = [];

  const pushRange = (node: Node, className: string): void => {
    const startRow = node.startPosition.row;
    const endRow = node.endPosition.row;
    if (endRow < minRow || startRow > maxRow) return;
    const fromLine = doc.line(Math.min(startRow + 1, doc.lines));
    const toLine = doc.line(Math.min(endRow + 1, doc.lines));
    const fromPos = Math.min(
      fromLine.from + byteColumnToChar(fromLine.text, node.startPosition.column),
      doc.length,
    );
    const toPos = Math.min(
      toLine.from + byteColumnToChar(toLine.text, node.endPosition.column),
      doc.length,
    );
    if (toPos > fromPos) ranges.push({ from: fromPos, to: toPos, deco: markFor(className) });
  };

  // 单次深度优先遍历，按可见区间剪枝（对齐 Zed 的 range 化查询）
  const stack: Node[] = [tree.rootNode];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.endPosition.row < minRow || node.startPosition.row > maxRow) continue;

    const container = CONTAINER_TYPE_CLASS[node.type];
    if (container) {
      pushRange(node, container);
      continue; // 整块着色，不再下钻
    }
    const children = getChildren(node);
    if (children.length === 0) {
      const leaf = LEAF_TYPE_CLASS[node.type];
      if (leaf) pushRange(node, leaf);
      continue;
    }
    for (const child of children) stack.push(child);
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(
    ranges.map((r) => r.deco.range(r.from, r.to)),
    true,
  );
}

class BashTreeSitterHighlighter {
  decorations: DecorationSet = Decoration.none;
  private lastTree: Tree | null = null;

  constructor(view: EditorView) {
    const analysis = view.state.field(bashAnalysisField, false);
    this.lastTree = analysis?.tree ?? null;
    this.decorations = buildBashDecorations(view, this.lastTree);
  }

  update(update: ViewUpdate): void {
    const analysis = update.state.field(bashAnalysisField, false);
    const tree = analysis?.tree ?? null;
    const treeChanged = tree !== this.lastTree;

    if (update.docChanged) {
      // 树还没跟上时，先把旧装饰按编辑映射过去，避免闪烁（Zed 也保留短暂旧高亮）
      this.decorations = this.decorations.map(update.changes);
    }
    if (treeChanged || update.viewportChanged || update.docChanged) {
      this.decorations = buildBashDecorations(update.view, tree);
      this.lastTree = tree;
    }
  }
}

const bashTreeSitterHighlightPlugin = ViewPlugin.fromClass(BashTreeSitterHighlighter, {
  decorations: (plugin) => plugin.decorations,
});

// 主题只按 capture class 着色，与语言解耦（github-light，与 Shiki 主题保持一致观感）
const bashTreeSitterHighlightTheme = EditorView.baseTheme({
  '.cm-ts-comment': { color: '#6e7781', fontStyle: 'italic' },
  '.cm-ts-string': { color: '#0a3069' },
  '.cm-ts-keyword': { color: '#cf222e' },
  '.cm-ts-function': { color: '#8250df' },
  '.cm-ts-variable': { color: '#953800' },
  '.cm-ts-number': { color: '#0550ae' },
  '.cm-ts-operator': { color: '#0550ae' },
});

export function bashTreeSitterHighlightExtension() {
  return [bashTreeSitterHighlightPlugin, bashTreeSitterHighlightTheme];
}
