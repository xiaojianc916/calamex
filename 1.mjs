// 12a-write-structure-engine.mjs — 通用 tree-sitter 折叠/缩进引擎（正确完整版，覆盖上一条脚本写岔的文件）
import { writeFileSync } from "node:fs"
import { join } from "node:path"

const PATH = join(process.cwd(), "src/services/editor/codemirror-tree-sitter-structure.ts")

const content = `import { foldService, indentService } from '@codemirror/language';
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { Node, Parser, Tree } from 'web-tree-sitter';
import { byteOffsetToCharIndex } from './tree-sitter/bash-runtime';
import { ensureTreeSitterParser } from './tree-sitter/core-runtime';
import { TREE_SITTER_LANGUAGES } from './tree-sitter/language-registry.generated';

/**
 * 通用（语言无关）tree-sitter 结构服务：折叠 + 缩进 + 行注释语言数据。
 *
 * 参照 Zed 的地基原则——语法树是结构信息的唯一来源；不再为每个语言维护
 * @codemirror/legacy-modes 下手写的正则/状态机词法器（那些只有token流，没有真正的语法树，
 * 折叠/缩进能力很弱），也不为每个语言手写折叠节点类型白名单（如早期 bash 那样）。
 *
 * 折叠规则通用化为：任意跨多行的节点都是折叠候选（根节点除外），同起始行取覆盖范围最大者。
 * 缩进规则通用化为：数一下当前行被多少个跨行祖先节点严格包含。这两条规则不依赖具体语言的
 * 节点类型命名，可直接套用在任意已编译好 wasm 的 tree-sitter 语言上。
 *
 * 与 codemirror-tree-sitter-highlight 各自维护独立的 Tree（避免跨 ViewPlugin 共享同一个
 * wasm Tree 对象带来的生命周期风险），但通过 core-runtime 共享同一个 Parser/Language 实例，
 * 不会重复加载/编译同一份语法。
 */

const STRUCTURE_PARSE_DEBOUNCE_MS = 60;
const MAX_STRUCTURE_SOURCE_LENGTH = 2_000_000;

interface IStructureAnalysis {
  tree: Tree;
  foldEndByRow: ReadonlyMap<number, number>;
}

/** 通用折叠表：任意跨行节点都是候选，根节点除外；同起始行取覆盖范围最大者。 */
function computeGenericFoldByRow(rootNode: Node, source: string): Map<number, number> {
  const foldEndByRow = new Map<number, number>();
  const stack: Node[] = [rootNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node !== rootNode && node.endPosition.row > node.startPosition.row) {
      const startRow = node.startPosition.row;
      const endChar = byteOffsetToCharIndex(source, node.endIndex);
      const existing = foldEndByRow.get(startRow);
      if (existing === undefined || endChar > existing) {
        foldEndByRow.set(startRow, endChar);
      }
    }
    const children = node.children;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child) stack.push(child);
    }
  }
  return foldEndByRow;
}

/** 通用缩进深度：数一下有多少个跨行祖先节点严格包含该行（扣除根节点自身那一层）。 */
function computeGenericIndentDepth(tree: Tree, row: number): number {
  let node: Node | null = tree.rootNode.descendantForPosition({ row, column: 0 });
  let depth = 0;
  while (node) {
    if (node.startPosition.row < row && node.endPosition.row > row) {
      depth += 1;
    }
    node = node.parent;
  }
  return Math.max(0, depth - 1);
}

const setStructureAnalysis = StateEffect.define<IStructureAnalysis | null>();

const structureAnalysisField = StateField.define<IStructureAnalysis | null>({
  create: () => null,
  update(current, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setStructureAnalysis)) {
        const next = effect.value;
        if (current && current.tree !== next?.tree) {
          current.tree.delete();
        }
        return next;
      }
    }
    return current;
  },
});

const structureFoldService = foldService.of((state, _lineStart, lineEnd) => {
  const analysis = state.field(structureAnalysisField, false);
  if (!analysis) return null;
  const row = state.doc.lineAt(lineEnd).number - 1;
  const endChar = analysis.foldEndByRow.get(row);
  if (endChar === undefined) return null;
  const to = Math.min(endChar, state.doc.length);
  return to > lineEnd ? { from: lineEnd, to } : null;
});

const structureIndentService = indentService.of((context, pos) => {
  const analysis = context.state.field(structureAnalysisField, false);
  if (!analysis) return null;
  const row = context.state.doc.lineAt(pos).number - 1;
  const depth = computeGenericIndentDepth(analysis.tree, row);
  return depth > 0 ? depth * context.unit : null;
});

const structureParsePlugin = (langId: string) =>
  ViewPlugin.fromClass(
    class {
      private generation = 0;
      private timer: ReturnType<typeof setTimeout> | null = null;
      private destroyed = false;

      constructor(private readonly view: EditorView) {
        this.runParse(view.state.doc.toString());
      }

      update(update: ViewUpdate): void {
        if (!update.docChanged) return;
        const next = update.state.doc.toString();
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          this.runParse(next);
        }, STRUCTURE_PARSE_DEBOUNCE_MS);
      }

      destroy(): void {
        this.destroyed = true;
        if (this.timer !== null) clearTimeout(this.timer);
      }

      private runParse(source: string): void {
        if (source.length > MAX_STRUCTURE_SOURCE_LENGTH) return;
        this.generation += 1;
        const generation = this.generation;
        const entry = TREE_SITTER_LANGUAGES[langId];
        void ensureTreeSitterParser(langId, entry.wasmUrl)
          .then((parser: Parser) => {
            if (this.destroyed || generation !== this.generation) return;
            let tree: Tree | null = null;
            try {
              tree = parser.parse(source);
            } catch {
              return;
            }
            if (!tree) return;
            if (this.destroyed || generation !== this.generation) {
              tree.delete();
              return;
            }
            const foldEndByRow = computeGenericFoldByRow(tree.rootNode, source);
            this.view.dispatch({ effects: setStructureAnalysis.of({ tree, foldEndByRow }) });
          })
          .catch(() => {
            // 语法加载失败：保持无结构信息，不影响编辑（与高亮引擎一致的降级策略）。
          });
      }
    },
  );

// 各语言的行注释前缀（供 toggle-line-comment 等命令使用）。diff 无注释语法，不登记。
const LINE_COMMENT_TOKENS: Readonly<Record<string, string>> = {
  dockerfile: '#',
  csharp: '//',
  dart: '//',
  kotlin: '//',
  lua: '--',
  powershell: '#',
  proto: '//',
  r: '#',
  ruby: '#',
  scala: '//',
  latex: '%',
  toml: '#',
  ini: ';',
};

/** 供 codemirror-language 的 CODEMIRROR_LANGUAGE_LOADERS 使用：替代 legacy-modes 手写词法器。 */
export function treeSitterStructureExtensions(langId: string): Extension {
  const extensions: Extension[] = [
    structureAnalysisField,
    structureParsePlugin(langId),
    structureFoldService,
    structureIndentService,
  ];
  const lineComment = LINE_COMMENT_TOKENS[langId];
  if (lineComment) {
    extensions.push(
      EditorState.languageData.of(() => [{ commentTokens: { line: lineComment } }]),
    );
  }
  return extensions;
}
`

writeFileSync(PATH, content, "utf8")
console.log("✅ codemirror-tree-sitter-structure.ts 已写入正确实现")