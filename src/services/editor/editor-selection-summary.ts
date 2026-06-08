import type { SelectionRange } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/**
 * 选区摘要的纯计算逻辑（从 CodeMirrorScriptEditor.vue 抽出，便于单测与复用）。
 *
 * 这些函数不依赖编辑器组件的可变状态，仅接受 view / range / 行号等入参，
 * 因此可对长行截断、多行窗口取舍、视口聚焦行选择等边界独立做单测。
 */

// 多行选区上下各保留的上下文行数（窗口 = contextLines * 2 + 1）。
export const SELECTION_SUMMARY_CONTEXT_LINES = 60;
// 单行选区超过该字符数视为“长行”，改用可见区附近的字符窗口截断。
export const SELECTION_SUMMARY_LONG_LINE_THRESHOLD = 4_000;
// 长行截断时，可见区锚点前后各保留的字符数。
export const SELECTION_SUMMARY_LONG_LINE_CONTEXT_CHARS = 100;

export type TSelectionSummaryText = { text: string; truncated: boolean };

export const withDefaultSelectionTruncation = (result: TSelectionSummaryText): string =>
  result.truncated ? `${result.text}\n[已截断]` : result.text;

export const resolveSelectionLineWindow = (input: {
  startLine: number;
  endLine: number;
  currentLine: number;
  contextLines: number;
}): { startLine: number; endLine: number; truncated: boolean } => {
  const totalLines = input.endLine - input.startLine + 1;
  const maxLines = input.contextLines * 2 + 1;
  if (totalLines <= maxLines) {
    return { startLine: input.startLine, endLine: input.endLine, truncated: false };
  }

  const currentLine = Math.min(Math.max(input.currentLine, input.startLine), input.endLine);
  const linesBefore = currentLine - input.startLine;
  const linesAfter = input.endLine - currentLine;
  let before = Math.min(input.contextLines, linesBefore);
  let after = Math.min(input.contextLines, linesAfter);

  const spareBefore = input.contextLines - before;
  if (spareBefore > 0) {
    after = Math.min(linesAfter, after + spareBefore);
  }

  const spareAfter = input.contextLines - after;
  if (spareAfter > 0) {
    before = Math.min(linesBefore, before + spareAfter);
  }

  return {
    startLine: currentLine - before,
    endLine: currentLine + after,
    truncated: true,
  };
};

export const resolveSelectionViewportFocusLine = (
  view: EditorView,
  startLine: number,
  endLine: number,
  fallbackLine: number,
): number => {
  let bestStartLine: number | null = null;
  let bestEndLine: number | null = null;
  let bestVisibleLineCount = 0;

  for (const visibleRange of view.visibleRanges) {
    const visibleStartLine = view.state.doc.lineAt(visibleRange.from).number;
    const visibleEndLine = view.state.doc.lineAt(
      Math.max(visibleRange.from, visibleRange.to - 1),
    ).number;
    const intersectionStartLine = Math.max(startLine, visibleStartLine);
    const intersectionEndLine = Math.min(endLine, visibleEndLine);
    const visibleLineCount = intersectionEndLine - intersectionStartLine + 1;

    if (visibleLineCount > bestVisibleLineCount) {
      bestStartLine = intersectionStartLine;
      bestEndLine = intersectionEndLine;
      bestVisibleLineCount = visibleLineCount;
    }
  }

  if (bestStartLine !== null && bestEndLine !== null) {
    return Math.floor((bestStartLine + bestEndLine) / 2);
  }

  return fallbackLine;
};

export const resolveSingleLineSelectionSummaryText = (
  view: EditorView,
  range: SelectionRange,
): TSelectionSummaryText => {
  if (range.to - range.from <= SELECTION_SUMMARY_LONG_LINE_THRESHOLD) {
    return { text: view.state.doc.sliceString(range.from, range.to), truncated: false };
  }

  let visibleFrom: number | null = null;
  let visibleTo: number | null = null;
  for (const visibleRange of view.visibleRanges) {
    const from = Math.max(range.from, visibleRange.from);
    const to = Math.min(range.to, visibleRange.to);
    if (from < to && (visibleFrom === null || to - from > visibleTo - visibleFrom)) {
      visibleFrom = from;
      visibleTo = to;
    }
  }

  const fallbackPosition = Math.min(Math.max(range.head, range.from), range.to);
  const anchorFrom = visibleFrom ?? fallbackPosition;
  const anchorTo = visibleTo ?? fallbackPosition;
  const from = Math.max(range.from, anchorFrom - SELECTION_SUMMARY_LONG_LINE_CONTEXT_CHARS);
  const to = Math.min(range.to, anchorTo + SELECTION_SUMMARY_LONG_LINE_CONTEXT_CHARS);
  return {
    text: view.state.doc.sliceString(from, to),
    truncated: from > range.from || to < range.to,
  };
};

export const resolveMultiLineSelectionSummaryText = (
  view: EditorView,
  range: SelectionRange,
  startLine: number,
  endLine: number,
): TSelectionSummaryText => {
  const fallbackLine = view.state.doc.lineAt(
    Math.min(Math.max(range.head, range.from), range.to),
  ).number;
  const currentLine = resolveSelectionViewportFocusLine(view, startLine, endLine, fallbackLine);
  const window = resolveSelectionLineWindow({
    startLine,
    endLine,
    currentLine,
    contextLines: SELECTION_SUMMARY_CONTEXT_LINES,
  });

  const lines: string[] = [];
  for (let lineNumber = window.startLine; lineNumber <= window.endLine; lineNumber += 1) {
    const line = view.state.doc.line(lineNumber);
    const from = lineNumber === startLine ? Math.max(line.from, range.from) : line.from;
    const to = lineNumber === endLine ? Math.min(line.to, range.to) : line.to;
    lines.push(view.state.doc.sliceString(from, to));
  }

  return { text: lines.join('\n'), truncated: window.truncated };
};
