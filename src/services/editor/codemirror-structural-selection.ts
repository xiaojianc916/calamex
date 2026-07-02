import { syntaxTree } from '@codemirror/language';
import { EditorSelection, type EditorState, StateEffect, StateField } from '@codemirror/state';
import type { Command } from '@codemirror/view';
import { expandRangeWithBashTree } from './codemirror-bash-language';
import { expandRangeWithTreeSitter } from './codemirror-tree-sitter-structure';

/**
 * 结构化选区(structural selection)。
 *
 * - 扩大选区:沿语法树(Lezer AST)向上选中“恰好包含且严格大于”当前选区的最近父节点。
 * - 缩小选区:沿“扩大”历史栈逐级回退到上一次更小的选区。
 *
 * 仅对拥有真实 syntaxTree 的 Lezer 语言(js/ts/vue/html/css/json/md/cpp/go/java/
 * python/rust/sql/xml 等)能做到语法级精确扩选。shell 由 tree-sitter-bash 提供 AST
 * (见 codemirror-bash-language),同样支持语法级扩选;其余 StreamLanguage 暂无 AST,
 * 扩选会直接跳到整篇文档,属预期降级。
 */

type TStructuralSelectionAction = 'expand' | 'shrink';

// 标注一次事务属于结构化扩/缩,使历史栈与“手动选区变化重置”逻辑可区分。
const structuralSelectionEffect = StateEffect.define<TStructuralSelectionAction>();

// 保存“扩大前”的选区快照栈,供缩小逐级回退;任何手动选区变化/编辑都会清空。
const structuralSelectionHistoryField = StateField.define<readonly EditorSelection[]>({
  create: () => [],
  update(stack, tr) {
    const action = tr.effects.find((effect) => effect.is(structuralSelectionEffect))?.value;
    if (action === 'expand') {
      return [...stack, tr.startState.selection];
    }
    if (action === 'shrink') {
      return stack.slice(0, -1);
    }
    // 其它任何选区变化或文档变化都视为手动操作,重置历史。
    if (tr.selection || tr.docChanged) {
      return stack.length === 0 ? stack : [];
    }
    return stack;
  },
});

// 沿语法树向上找到“恰好包含、且严格大于”当前选区的最近父节点。
const resolveExpandedSelection = (state: EditorState): EditorSelection => {
  const tree = syntaxTree(state);
  return EditorSelection.create(
    state.selection.ranges.map((range) => {
      // shell 走 bash 专用树；其余语言走通用 tree-sitter 结构树；两者都命中不了才回退 Lezer。
      const tsRange =
        expandRangeWithBashTree(state, range.from, range.to) ??
        expandRangeWithTreeSitter(state, range.from, range.to);
      if (tsRange) {
        return EditorSelection.range(tsRange.from, tsRange.to);
      }
      let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(range.from, 1);
      while (node) {
        if (
          node.from <= range.from &&
          node.to >= range.to &&
          (node.from < range.from || node.to > range.to)
        ) {
          return EditorSelection.range(node.from, node.to);
        }
        node = node.parent;
      }
      return range;
    }),
    state.selection.mainIndex,
  );
};

const expandStructuralSelection: Command = (view) => {
  const { state } = view;
  const selection = resolveExpandedSelection(state);
  if (selection.eq(state.selection)) return false;
  view.dispatch({
    selection,
    effects: structuralSelectionEffect.of('expand'),
    scrollIntoView: true,
    userEvent: 'select.structural.expand',
  });
  return true;
};

const shrinkStructuralSelection: Command = (view) => {
  const stack = view.state.field(structuralSelectionHistoryField, false);
  if (!stack || stack.length === 0) return false;
  const previous = stack[stack.length - 1];
  view.dispatch({
    selection: previous,
    effects: structuralSelectionEffect.of('shrink'),
    scrollIntoView: true,
    userEvent: 'select.structural.shrink',
  });
  return true;
};

export {
  expandStructuralSelection,
  shrinkStructuralSelection,
  structuralSelectionEffect,
  structuralSelectionHistoryField,
};
