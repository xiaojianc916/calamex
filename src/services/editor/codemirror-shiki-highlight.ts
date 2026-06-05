import { type Extension, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import {
  ensureShikiLanguage,
  type IShikiThemedToken,
  isShikiLanguageLoaded,
  resolveShikiLanguageId,
  SHIKI_BACKGROUND,
  SHIKI_FOREGROUND,
  tokenizeWithShikiSync,
} from '@/services/editor/shiki-highlighter';

/** 编辑器与代码渲染统一使用的等宽字体，按要求以 Consolas 为首选。 */
export const EDITOR_FONT_FAMILY =
  "Consolas, 'Cascadia Mono', 'SF Mono', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace";

// 单次 tokenize 切片的字节上限：默认从文档开头切到可见区下沿，超大文件超过此上限时
// 退化为仅切可见区窗口；窗口切片仍超限（极端长行，如压缩成一行的文件）则放弃高亮，
// 避免主线程出现长任务。注意这是“切片”上限而非“整文档”上限。
const MAX_HIGHLIGHT_SLICE_LENGTH = 200_000;

// 可见区上下额外着色的行数：平滑向下滚动时的着色衔接，并作为超大文件窗口退化时的缓冲。
const HIGHLIGHT_OVERSCAN_LINES = 40;

// 输入停顿后过多久触发一次重算（毫秒）；过小会让连续输入仍频繁重算，过大高亮滞后明显。
const HIGHLIGHT_RECOMPUTE_DEBOUNCE_MS = 90;

const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;

// 当前语言（app 语言 id）由外部通过 effect 注入。
const setShikiLanguageEffect = StateEffect.define<string>();
// 语法异步加载完成后借此 effect 触发一次重新高亮。
const shikiReadyEffect = StateEffect.define<null>();
// 防抖超时触发的重算信号。
const shikiRecomputeEffect = StateEffect.define<null>();

/** 供外部在语言切换时派发，通知高亮插件更新语言。 */
export const setShikiLanguage = (language: string): StateEffect<string> =>
  setShikiLanguageEffect.of(language);

export type TShikiHighlightUpdateAction = 'recompute' | 'remap' | 'skip';

/**
 * 纯函数：根据一次 ViewUpdate 的特征决定高亮插件应执行的动作。
 * - recompute：语言切换、收到重算请求、或仅视口变化（滚动）时，重新 tokenize 当前可见区域。
 * - remap：仅文档变化时，按编辑位移映射现有 decorations，随后防抖重算。
 * - skip：其余情况（如纯选区变化）保持现有 decorations。
 *
 * 注意优先级：文档变化优先于视口变化——编辑往往同时触发两者，此时先做廉价的位移映射，
 * 再由防抖重算按最新视口补齐，避免每次按键都整屏重算。
 */
export const resolveShikiHighlightUpdateAction = (input: {
  languageChanged: boolean;
  recomputeRequested: boolean;
  docChanged: boolean;
  viewportChanged?: boolean;
}): TShikiHighlightUpdateAction => {
  if (input.languageChanged || input.recomputeRequested) {
    return 'recompute';
  }
  if (input.docChanged) {
    return 'remap';
  }
  if (input.viewportChanged) {
    return 'recompute';
  }
  return 'skip';
};

/**
 * 纯函数：计算需要 tokenize 的行范围 [startLine, endLine]（1-based，含端点）。
 * - endLine：可见区下沿 + overscan，并夹取到文档末行；视口下方内容不影响可见区配色，无需 tokenize。
 * - startLine：
 *   - fromDocumentStart=true：固定为第 1 行，使 Shiki 语法状态从真实边界续算，
 *     保证 heredoc/多行字符串/块注释等跨行结构在可见区配色正确（默认路径）。
 *   - fromDocumentStart=false：可见区上沿 - overscan（夹取到第 1 行）的窗口，
 *     仅在从头切片超出体积上限的超大文件时退化使用。
 */
export const computeShikiHighlightRange = (input: {
  firstVisibleLine: number;
  lastVisibleLine: number;
  totalLines: number;
  overscanLines: number;
  fromDocumentStart: boolean;
}): { startLine: number; endLine: number } => {
  const endLine = Math.min(input.totalLines, input.lastVisibleLine + input.overscanLines);
  const startLine = input.fromDocumentStart
    ? 1
    : Math.max(1, input.firstVisibleLine - input.overscanLines);
  return { startLine, endLine };
};

const shikiLanguageField = StateField.define<string>({
  create: () => 'text',
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setShikiLanguageEffect)) {
        return effect.value;
      }
    }
    return value;
  },
});

const tokenInlineStyle = (token: IShikiThemedToken): string => {
  const declarations: string[] = [];
  if (token.color) {
    declarations.push(`color:${token.color}`);
  }
  if (token.bgColor) {
    declarations.push(`background-color:${token.bgColor}`);
  }
  const fontStyle = token.fontStyle ?? 0;
  if (fontStyle > 0) {
    if ((fontStyle & FONT_STYLE_ITALIC) !== 0) {
      declarations.push('font-style:italic');
    }
    if ((fontStyle & FONT_STYLE_BOLD) !== 0) {
      declarations.push('font-weight:600');
    }
    if ((fontStyle & FONT_STYLE_UNDERLINE) !== 0) {
      declarations.push('text-decoration:underline');
    }
  }
  return declarations.join(';');
};

// 仅 tokenize 当前可见行所需的切片，单次成本与可见行数相关而非文档总长，
// 避免大文件编辑/滚动时主线程出现长任务。默认从文档首行起切片以保证跨行结构
// 在可见区配色正确（见 computeShikiHighlightRange）。返回所用行范围供调用方做复用判定。
const buildShikiDecorations = (
  view: EditorView,
  language: string,
): { decorations: DecorationSet; startLine: number; endLine: number } | null => {
  const { doc } = view.state;
  if (doc.length === 0) {
    return null;
  }

  const { visibleRanges } = view;
  if (visibleRanges.length === 0) {
    return null;
  }

  const firstVisibleLine = doc.lineAt(visibleRanges[0].from).number;
  const lastVisibleLine = doc.lineAt(visibleRanges[visibleRanges.length - 1].to).number;

  // 先尝试从文档开头切片：语法状态从真实边界续算，跨多行结构在可见区配色正确。
  let range = computeShikiHighlightRange({
    firstVisibleLine,
    lastVisibleLine,
    totalLines: doc.lines,
    overscanLines: HIGHLIGHT_OVERSCAN_LINES,
    fromDocumentStart: true,
  });
  let sliceFrom = doc.line(range.startLine).from;
  let sliceTo = doc.line(range.endLine).to;

  // 从头切片过大（超大文件）时退化为可见区窗口，控制单次 tokenize 成本。
  if (sliceTo - sliceFrom > MAX_HIGHLIGHT_SLICE_LENGTH) {
    range = computeShikiHighlightRange({
      firstVisibleLine,
      lastVisibleLine,
      totalLines: doc.lines,
      overscanLines: HIGHLIGHT_OVERSCAN_LINES,
      fromDocumentStart: false,
    });
    sliceFrom = doc.line(range.startLine).from;
    sliceTo = doc.line(range.endLine).to;
    // 窗口切片仍超限（极端长行）时放弃高亮，避免主线程长任务。
    if (sliceTo - sliceFrom > MAX_HIGHLIGHT_SLICE_LENGTH) {
      return null;
    }
  }

  const code = doc.sliceString(sliceFrom, sliceTo);
  const lines = tokenizeWithShikiSync(code, language);
  if (!lines) {
    return null;
  }

  const builder = new RangeSetBuilder<Decoration>();
  const lineCount = Math.min(lines.length, range.endLine - range.startLine + 1);
  for (let index = 0; index < lineCount; index += 1) {
    const lineTokens = lines[index];
    if (!lineTokens || lineTokens.length === 0) {
      continue;
    }
    const docLine = doc.line(range.startLine + index);
    let position = docLine.from;
    for (const token of lineTokens) {
      const length = token.content.length;
      if (length === 0) {
        continue;
      }
      const from = position;
      const to = Math.min(position + length, docLine.to);
      position = to;
      if (from >= to) {
        continue;
      }
      const style = tokenInlineStyle(token);
      if (style) {
        builder.add(from, to, Decoration.mark({ attributes: { style } }));
      }
    }
  }
  return { decorations: builder.finish(), startLine: range.startLine, endLine: range.endLine };
};

const shikiHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private destroyed = false;
    private recomputeTimer: number | null = null;
    // 已成功高亮的语言与行范围；用于滚动时判断当前可见区是否已被覆盖，覆盖则跳过重算。
    private highlightedLanguage: string | null = null;
    private highlightedStartLine: number | null = null;
    private highlightedEndLine: number | null = null;

    constructor(view: EditorView) {
      this.decorations = Decoration.none;
      this.recompute(view, { allowReuse: false });
    }

    update(update: ViewUpdate): void {
      const languageChanged =
        update.startState.field(shikiLanguageField, false) !==
        update.state.field(shikiLanguageField, false);
      const recomputeRequested = update.transactions.some((tr) =>
        tr.effects.some((effect) => effect.is(shikiReadyEffect) || effect.is(shikiRecomputeEffect)),
      );

      const action = resolveShikiHighlightUpdateAction({
        languageChanged,
        recomputeRequested,
        docChanged: update.docChanged,
        viewportChanged: update.viewportChanged,
      });

      if (action === 'recompute') {
        this.cancelScheduledRecompute();
        // 语言切换 / 防抖重算请求需强制重建；仅滚动则允许复用已覆盖范围。
        const allowReuse = !languageChanged && !recomputeRequested;
        this.recompute(update.view, { allowReuse });
        return;
      }

      if (action === 'remap') {
        // 仅按编辑位移映射已有高亮，避免每次按键重新 tokenize；位移后缓存的行号已失效，
        // 先作废缓存，再由防抖重算按最新视口重建。
        this.decorations = this.decorations.map(update.changes);
        this.invalidateHighlightedRange();
        this.scheduleRecompute(update.view);
      }
    }

    destroy(): void {
      this.destroyed = true;
      this.cancelScheduledRecompute();
    }

    private invalidateHighlightedRange(): void {
      this.highlightedLanguage = null;
      this.highlightedStartLine = null;
      this.highlightedEndLine = null;
    }

    private cancelScheduledRecompute(): void {
      if (this.recomputeTimer !== null) {
        window.clearTimeout(this.recomputeTimer);
        this.recomputeTimer = null;
      }
    }

    private scheduleRecompute(view: EditorView): void {
      this.cancelScheduledRecompute();
      this.recomputeTimer = window.setTimeout(() => {
        this.recomputeTimer = null;
        if (this.destroyed) {
          return;
        }
        try {
          // 派发重算 effect，让插件在下一次 update 中对当前视口做一次 tokenize。
          view.dispatch({ effects: shikiRecomputeEffect.of(null) });
        } catch {
          // view 已销毁，忽略。
        }
      }, HIGHLIGHT_RECOMPUTE_DEBOUNCE_MS);
    }

    private recompute(view: EditorView, options: { allowReuse: boolean }): void {
      const language = view.state.field(shikiLanguageField, false) ?? 'text';
      if (!resolveShikiLanguageId(language)) {
        this.decorations = Decoration.none;
        this.invalidateHighlightedRange();
        return;
      }
      if (!isShikiLanguageLoaded(language)) {
        this.requestLanguage(view, language);
        this.decorations = Decoration.none;
        this.invalidateHighlightedRange();
        return;
      }

      // 复用：语言未变且已高亮范围已覆盖当前可见区时，滚动无需重新 tokenize（零开销且不会露白）。
      if (options.allowReuse && this.isVisibleRangeHighlighted(view, language)) {
        return;
      }

      const built = buildShikiDecorations(view, language);
      if (!built) {
        this.decorations = Decoration.none;
        this.invalidateHighlightedRange();
        return;
      }
      this.decorations = built.decorations;
      this.highlightedLanguage = language;
      this.highlightedStartLine = built.startLine;
      this.highlightedEndLine = built.endLine;
    }

    private isVisibleRangeHighlighted(view: EditorView, language: string): boolean {
      if (
        this.highlightedLanguage !== language ||
        this.highlightedStartLine === null ||
        this.highlightedEndLine === null
      ) {
        return false;
      }
      const { visibleRanges } = view;
      if (visibleRanges.length === 0) {
        return false;
      }
      const { doc } = view.state;
      const firstVisibleLine = doc.lineAt(visibleRanges[0].from).number;
      const lastVisibleLine = doc.lineAt(visibleRanges[visibleRanges.length - 1].to).number;
      return (
        firstVisibleLine >= this.highlightedStartLine && lastVisibleLine <= this.highlightedEndLine
      );
    }

    private requestLanguage(view: EditorView, language: string): void {
      void ensureShikiLanguage(language).then((shikiId) => {
        if (!shikiId || this.destroyed) {
          return;
        }
        // 加载期间语言可能又变了，过期请求直接丢弃。
        if ((view.state.field(shikiLanguageField, false) ?? 'text') !== language) {
          return;
        }
        try {
          view.dispatch({ effects: shikiReadyEffect.of(null) });
        } catch {
          // view 已销毁，忽略。
        }
      });
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);

/** github-light 风格的编辑器 chrome 主题（背景/光标/选区/行号 + Consolas 字体）。 */
export const shikiEditorChromeTheme = EditorView.theme(
  {
    '&': {
      color: SHIKI_FOREGROUND,
      backgroundColor: SHIKI_BACKGROUND,
    },
    '.cm-scroller': {
      fontFamily: EDITOR_FONT_FAMILY,
      fontSize: '13px',
      lineHeight: '1.6',
    },
    '.cm-content': {
      fontFamily: EDITOR_FONT_FAMILY,
      caretColor: '#24292e',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: '#24292e',
      borderLeftWidth: '1.5px',
    },
    // 选区交给浏览器原生绘制（已移除 drawSelection）：只覆盖每行真实字符，
    // 行尾之后的空白不再刷蓝，多行/全选呈参差右边缘，跟 VS Code 一致。
    '.cm-content ::selection': {
      backgroundColor: '#add6ff80',
    },
    '.cm-gutters': {
      backgroundColor: SHIKI_BACKGROUND,
      color: '#6e7781',
      border: 'none',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(0, 0, 0, 0.04)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'rgba(0, 0, 0, 0.06)',
    },
    // 折叠槽：低饱和 chevron，hover 才加深，保持克制。
    '.cm-foldGutter .cm-gutterElement': {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '16px',
      padding: '0',
      color: '#c4c9cf',
      cursor: 'pointer',
    },
    '.cm-foldGutter .cm-gutterElement:hover': {
      color: '#57606a',
    },
    '.cm-fold-marker': {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      transition: 'transform 150ms ease',
    },
    // 折叠后的占位标记：placeholderDOM 渲染的圆点药丸，flex 居中（与字体度量无关）。
    '.cm-fold-pill': {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '3px',
      height: '0.95em',
      margin: '0 4px',
      padding: '0 7px',
      verticalAlign: 'middle',
      backgroundColor: 'rgba(175, 184, 193, 0.2)',
      borderRadius: '6px',
      cursor: 'pointer',
      transition: 'background-color 120ms ease',
    },
    '.cm-fold-pill:hover': {
      backgroundColor: 'rgba(175, 184, 193, 0.34)',
    },
    // 固定 4px 正圆：flex-shrink:0 锁死三点尺寸恒等，偶数边长+整数 gap 避免亚像素发虚。
    '.cm-fold-pill-dot': {
      flexShrink: 0,
      width: '3px',
      height: '3px',
      borderRadius: '50%',
      backgroundColor: '#a8b1b9', // 由 #6e7781 调淡
    },
    '.cm-fold-pill:hover .cm-fold-pill-dot': {
      backgroundColor: '#8c949c', // hover 也相应调淡
    },
  },
  { dark: false },
);

/**
 * Shiki 语法高亮扩展（不含 chrome 主题，便于调用方控制主题叠加顺序）。
 * @param initialLanguage 初始 app 语言 id。
 */
export const shikiHighlightExtension = (initialLanguage = 'text'): Extension => [
  shikiLanguageField.init(() => initialLanguage),
  shikiHighlightPlugin,
];
