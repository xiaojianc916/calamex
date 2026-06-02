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

// 超过该长度不做整文档高亮，避免大文件卡顿。
const MAX_HIGHLIGHT_LENGTH = 300_000;

// 输入停顿后过多久触发一次全量重算（毫秒）；过小会让连续输入仍频繁重算，过大高亮滞后明显。
const HIGHLIGHT_RECOMPUTE_DEBOUNCE_MS = 90;

const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;

// 当前语言（app 语言 id）由外部通过 effect 注入。
const setShikiLanguageEffect = StateEffect.define<string>();
// 语法异步加载完成后借此 effect 触发一次重新高亮。
const shikiReadyEffect = StateEffect.define<null>();
// 防抖超时触发的全量重算信号。
const shikiRecomputeEffect = StateEffect.define<null>();

/** 供外部在语言切换时派发，通知高亮插件更新语言。 */
export const setShikiLanguage = (language: string): StateEffect<string> =>
  setShikiLanguageEffect.of(language);

export type TShikiHighlightUpdateAction = 'recompute' | 'remap' | 'skip';

/**
 * 纯函数：根据一次 ViewUpdate 的特征决定高亮插件应执行的动作。
 * - recompute：语言切换或收到重算请求时，立即全量 tokenize。
 * - remap：仅文档变化时，按编辑位移映射现有 decorations，随后防抖重算。
 * - skip：其余情况（如纯选区变化）保持现有 decorations。
 */
export const resolveShikiHighlightUpdateAction = (input: {
  languageChanged: boolean;
  recomputeRequested: boolean;
  docChanged: boolean;
}): TShikiHighlightUpdateAction => {
  if (input.languageChanged || input.recomputeRequested) {
    return 'recompute';
  }
  if (input.docChanged) {
    return 'remap';
  }
  return 'skip';
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

const buildShikiDecorations = (view: EditorView, language: string): DecorationSet => {
  const { doc } = view.state;
  if (doc.length === 0 || doc.length > MAX_HIGHLIGHT_LENGTH) {
    return Decoration.none;
  }

  const lines = tokenizeWithShikiSync(doc.toString(), language);
  if (!lines) {
    return Decoration.none;
  }

  const builder = new RangeSetBuilder<Decoration>();
  const lineCount = Math.min(lines.length, doc.lines);
  for (let index = 0; index < lineCount; index += 1) {
    const lineTokens = lines[index];
    if (!lineTokens || lineTokens.length === 0) {
      continue;
    }
    const docLine = doc.line(index + 1);
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
  return builder.finish();
};

const shikiHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private destroyed = false;
    private recomputeTimer: number | null = null;

    constructor(view: EditorView) {
      this.decorations = this.compute(view);
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
      });

      if (action === 'recompute') {
        this.cancelScheduledRecompute();
        this.decorations = this.compute(update.view);
        return;
      }

      if (action === 'remap') {
        // 仅按编辑位移映射已有高亮，避免每次按键对整篇文档重新 tokenize。
        this.decorations = this.decorations.map(update.changes);
        this.scheduleRecompute(update.view);
      }
    }

    destroy(): void {
      this.destroyed = true;
      this.cancelScheduledRecompute();
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
          // 派发重算 effect，让插件在下一次 update 中做一次全量 tokenize。
          view.dispatch({ effects: shikiRecomputeEffect.of(null) });
        } catch {
          // view 已销毁，忽略。
        }
      }, HIGHLIGHT_RECOMPUTE_DEBOUNCE_MS);
    }

    private compute(view: EditorView): DecorationSet {
      const language = view.state.field(shikiLanguageField, false) ?? 'text';
      if (!resolveShikiLanguageId(language)) {
        return Decoration.none;
      }
      if (!isShikiLanguageLoaded(language)) {
        this.requestLanguage(view, language);
        return Decoration.none;
      }
      return buildShikiDecorations(view, language);
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
    },
    '.cm-content': {
      fontFamily: EDITOR_FONT_FAMILY,
      caretColor: '#24292e',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: '#24292e',
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
