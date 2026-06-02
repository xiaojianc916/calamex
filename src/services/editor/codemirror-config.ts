import { closeBrackets } from '@codemirror/autocomplete';
import { codeFolding, foldGutter, indentUnit } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  lineNumbers,
} from '@codemirror/view';
import { indentationMarkers } from '@replit/codemirror-indentation-markers';
import type { IEditorSettings } from '@/types/settings';

export const resolveCodeMirrorIndentUnit = (editorSettings: IEditorSettings): string => {
  const tabSize = Math.max(1, editorSettings.tabSize);
  return editorSettings.indentation === 'tabs' ? '\t' : ' '.repeat(tabSize);
};

/** 折叠槽的展开/折叠标记：用简洁的 chevron，展开时旋转 90°，保持克制现代。 */
const buildFoldMarker = (open: boolean): HTMLElement => {
  const marker = document.createElement('span');
  marker.className = 'cm-fold-marker';
  marker.setAttribute('aria-hidden', 'true');
  marker.innerHTML =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
  marker.style.transform = open ? 'rotate(90deg)' : 'none';
  return marker;
};

/** 折叠后的占位标记：用三个 flex 居中的圆点替代默认 “…” 文本，与字体度量无关，精确居中。 */
const buildFoldPlaceholder = (_view: EditorView, onclick: (event: Event) => void): HTMLElement => {
  const pill = document.createElement('span');
  pill.className = 'cm-fold-pill';
  pill.title = '展开折叠的代码';
  pill.setAttribute('aria-label', '展开折叠的代码');
  pill.onclick = onclick;
  for (let i = 0; i < 3; i += 1) {
    const dot = document.createElement('span');
    dot.className = 'cm-fold-pill-dot';
    pill.appendChild(dot);
  }
  return pill;
};

export interface ICodeMirrorSettingsOptions {
  activeLine?: boolean;
  autoClosingPairs?: boolean;
  editable?: boolean;
  foldGutter?: boolean;
  lineNumbers?: boolean;
  readOnly?: boolean;
}

export const buildCodeMirrorSettingsExtensions = (
  editorSettings: IEditorSettings,
  options: ICodeMirrorSettingsOptions = {},
): Extension[] => {
  const tabSize = Math.max(1, editorSettings.tabSize);
  const readOnly = options.readOnly ?? false;
  const editable = options.editable ?? !readOnly;
  const showLineNumbers = options.lineNumbers ?? editorSettings.lineNumbers;
  const showActiveLine = options.activeLine ?? true;
  const showFoldGutter = options.foldGutter ?? true;
  const enableAutoClosingPairs = options.autoClosingPairs ?? editorSettings.autoClosingPairs;
  const wrapLines = editorSettings.wordWrap === 'viewport';

  return [
    EditorState.tabSize.of(tabSize),
    indentUnit.of(resolveCodeMirrorIndentUnit(editorSettings)),
    wrapLines ? EditorView.lineWrapping : [],
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(editable),
    showLineNumbers ? lineNumbers() : [],
    showActiveLine ? highlightActiveLine() : [],
    // highlightActiveLineGutter 是“高亮当前行”在行号槽中的对应部分，应跟随 activeLine 设置。
    showActiveLine ? highlightActiveLineGutter() : [],
    // 缩进参考线：在每级缩进处渲染竖线；highlightActiveBlock 让光标所在作用域的竖线高亮。
    editorSettings.indentGuides ? indentationMarkers({ highlightActiveBlock: true }) : [],
    showFoldGutter
      ? [
          codeFolding({ placeholderDOM: buildFoldPlaceholder }),
          foldGutter({ markerDOM: buildFoldMarker }),
        ]
      : [],
    enableAutoClosingPairs ? closeBrackets() : [],
  ];
};
