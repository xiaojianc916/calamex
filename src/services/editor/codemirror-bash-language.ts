import { foldService, indentService } from '@codemirror/language';
import { EditorState, type Extension, StateEffect, StateField } from '@codemirror/state';
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { logger } from '@/utils/platform/logger';
import {
  byteOffsetToCharIndex,
  ensureBashParser,
  type Node,
  type Tree,
  toBytePoint,
  utf8ByteLengthOfRange,
} from './tree-sitter/bash-runtime';

/**
 * 基于 tree-sitter-bash 的 CodeMirror 语言服务(折叠 / 缩进 / 结构选区)。
 *
 * 编辑器高亮由 Shiki 负责;本模块只提供"语言服务层",替代旧的 StreamLanguage(shell)。
 * 语法树由 ViewPlugin 在文档变化后(防抖)异步解析并写入 bashAnalysisField:折叠从预计算
 * 的"行 -> 折叠终点"表同步读取(热路径零额外解析);缩进与结构选区在触发时(换行 / Mod-i)
 * 按需查询语法树。因解析在事务之后异步完成,语法树相对当前文档最多滞后一次编辑,属预期
 * 行为(与 Shiki 高亮的异步刷新一致);所有映射回文档的位置都对文档长度做了夹取。
 */

interface IBashAnalysis {
  tree: Tree;
  foldEndByRow: ReadonlyMap<number, number>;
}

// 可折叠的 bash 节点类型:函数体、复合语句、子 shell、循环体、条件/分支、case 分支、heredoc。
const BASH_FOLDABLE_NODE_TYPES: readonly string[] = [
  'function_definition',
  'compound_statement',
  'subshell',
  'do_group',
  'if_statement',
  'case_statement',
  'case_item',
  'heredoc_body',
];

// 计算缩进层级的"块体"节点类型:仅取由成对定界符包围、无分支歧义的块,使缩进对
// {}/()/do..done 精确;if/case 的分支体回退到 CodeMirror 默认(沿用上一行缩进),不产生
// 回退。分支关键字(else/elif/fi/esac)的语法级对齐需后续引入 indent 查询再补。
const BASH_INDENT_BODY_TYPES: readonly string[] = ['compound_statement', 'subshell', 'do_group'];

interface IFoldSourceNode {
  startPosition: { row: number };
  endPosition: { row: number };
  endIndex: number;
}

interface IFoldSourceRoot {
  descendantsOfType: (type: string) => IFoldSourceNode[];
}

/**
 * 纯函数:由语法树根节点构建"起始行 -> 最远折叠字符位置"表。
 * 同一起始行存在多个可折叠节点时取最外层(折叠终点最大者);单行节点不折叠。
 */
export const computeBashFoldByRow = (
  rootNode: IFoldSourceRoot,
  source: string,
): Map<number, number> => {
  const foldEndByRow = new Map<number, number>();
  for (const type of BASH_FOLDABLE_NODE_TYPES) {
    for (const node of rootNode.descendantsOfType(type)) {
      const startRow = node.startPosition.row;
      if (node.endPosition.row <= startRow) {
        continue;
      }
      const endChar = byteOffsetToCharIndex(source, node.endIndex);
      const existing = foldEndByRow.get(startRow);
      if (existing === undefined || endChar > existing) {
        foldEndByRow.set(startRow, endChar);
      }
    }
  }
  return foldEndByRow;
};

interface IClimbNode {
  startIndex: number;
  endIndex: number;
  parent: IClimbNode | null;
}

/**
 * 纯函数:沿父链找到"恰好包含且严格大于"[fromByte, toByte] 的最近节点(字节坐标)。
 * 到根仍不满足"严格大于"则返回 null。
 */
export const resolveEnclosingByteRange = (
  startNode: IClimbNode | null,
  fromByte: number,
  toByte: number,
): { startByte: number; endByte: number } | null => {
  let node = startNode;
  while (node) {
    if (
      node.startIndex <= fromByte &&
      node.endIndex >= toByte &&
      (node.startIndex < fromByte || node.endIndex > toByte)
    ) {
      return { startByte: node.startIndex, endByte: node.endIndex };
    }
    node = node.parent;
  }
  return null;
};

const setBashAnalysis = StateEffect.define<IBashAnalysis | null>();

// 持有当前 bash 语法分析结果;替换时释放上一棵树,避免 wasm 内存泄漏。
export const bashAnalysisField = StateField.define<IBashAnalysis | null>({
  create: () => null,
  update(current, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setBashAnalysis)) {
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

const BASH_PARSE_DEBOUNCE_MS = 60;

// 文档变化后(防抖)异步解析 bash 语法树并写回 bashAnalysisField。
const bashParsePlugin = ViewPlugin.fromClass(
  class {
    private generation = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private destroyed = false;

    constructor(view: EditorView) {
      this.runParse(view, view.state.doc.toString());
    }

    update(update: ViewUpdate): void {
      if (!update.docChanged) {
        return;
      }
      if (this.timer !== null) {
        clearTimeout(this.timer);
      }
      const { view } = update;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.runParse(view, view.state.doc.toString());
      }, BASH_PARSE_DEBOUNCE_MS);
    }

    destroy(): void {
      this.destroyed = true;
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    }

    private runParse(view: EditorView, source: string): void {
      this.generation += 1;
      const generation = this.generation;
      void ensureBashParser()
        .then((parser) => {
          if (this.destroyed || generation !== this.generation) {
            return;
          }
          let tree: Tree | null = null;
          try {
            tree = parser.parse(source);
          } catch (error) {
            logger.error({ event: 'codemirror.bash.parse_failed', err: error });
            return;
          }
          if (!tree) {
            return;
          }
          if (this.destroyed || generation !== this.generation) {
            tree.delete();
            return;
          }
          const foldEndByRow = computeBashFoldByRow(tree.rootNode, source);
          view.dispatch({ effects: setBashAnalysis.of({ tree, foldEndByRow }) });
        })
        .catch((error) => {
          logger.error({ event: 'codemirror.bash.parser_init_failed', err: error });
        });
    }
  },
);

const bashFoldService = foldService.of((state, lineStart, lineEnd) => {
  const analysis = state.field(bashAnalysisField, false);
  if (!analysis) {
    return null;
  }
  const row = state.doc.lineAt(lineStart).number - 1;
  const endChar = analysis.foldEndByRow.get(row);
  if (endChar === undefined) {
    return null;
  }
  const to = Math.min(endChar, state.doc.length);
  return to > lineEnd ? { from: lineEnd, to } : null;
});

const bashIndentService = indentService.of((context, pos) => {
  const analysis = context.state.field(bashAnalysisField, false);
  if (!analysis) {
    return null;
  }
  const row = context.state.doc.lineAt(pos).number - 1;
  let depth = 0;
  for (const type of BASH_INDENT_BODY_TYPES) {
    for (const node of analysis.tree.rootNode.descendantsOfType(type) as Node[]) {
      // 仅当该行严格位于块体的起止行之间才 +1:天然排除开头行与闭合定界符所在行,
      // 故 }/)/done 自动与开启者对齐,无需对闭合 token 特判。
      if (node.startPosition.row < row && node.endPosition.row > row) {
        depth += 1;
      }
    }
  }
  // 无法确定时返回 null,回退到 CodeMirror 默认(沿用上一行缩进),不改变既有体验。
  return depth > 0 ? depth * context.unit : null;
});

/** 供结构化选区使用:基于 bash 语法树返回"恰好包含且严格大于"[from, to] 的最近父节点范围。 */
export const expandRangeWithBashTree = (
  state: EditorState,
  from: number,
  to: number,
): { from: number; to: number } | null => {
  const analysis = state.field(bashAnalysisField, false);
  if (!analysis) {
    return null;
  }
  const source = state.doc.toString();
  const fromByte = utf8ByteLengthOfRange(source, 0, from);
  const toByte = utf8ByteLengthOfRange(source, 0, to);
  const point = toBytePoint(source, from);
  const startNode =
    analysis.tree.rootNode.namedDescendantForPosition(point) ??
    analysis.tree.rootNode.descendantForPosition(point) ??
    null;
  const range = resolveEnclosingByteRange(startNode, fromByte, toByte);
  if (!range) {
    return null;
  }
  return {
    from: byteOffsetToCharIndex(source, range.startByte),
    to: byteOffsetToCharIndex(source, range.endByte),
  };
};

/** shell 的 CodeMirror 语言服务扩展集合(折叠/缩进/结构选区 + # 行注释 token)。 */
export const bashLanguageExtensions = (): Extension => [
  bashAnalysisField,
  bashParsePlugin,
  bashFoldService,
  bashIndentService,
  EditorState.languageData.of(() => [{ commentTokens: { line: '#' } }]),
];
