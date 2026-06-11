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
  isShikiLanguageLoaded,
  tokenizeWithShikiSync,
  tokenizeWithShikiWorker,
} from '@/services/editor/shiki-highlighter';
import {
  type IShikiThemedToken,
  resolveShikiLanguageId,
  SHIKI_BACKGROUND,
  SHIKI_FOREGROUND,
} from '@/services/editor/shiki-shared';

/** 编辑器与代码渲染统一使用的等宽字体，按要求以 Consolas 为首选。 */
export const EDITOR_FONT_FAMILY =
  "Consolas, 'Cascadia Mono', 'SF Mono', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace";

// 单次 tokenize 切片的字节上限：默认从文档开头切到可见区下沿，超大文件超过此上限时
// 退化为仅切可见区窗口；窗口切片仍超限（极端长行，如压缩成一行的文件）则放弃高亮，
// 避免 Worker 任务过重。注意这是“切片”上限而非“整文档”上限。
const MAX_HIGHLIGHT_SLICE_LENGTH = 200_000;

// 同步着色的切片字节上限：语法已在主线程加载、且切片不超过此值时，直接在主线程
// tokenize 并即时着色，消除滚动时“新行先露白、等 Worker 回包才补色”的闪烁；超过则
// 仍交给 Worker 异步处理，避免阻塞 UI 线程。取值远小于 Worker 切片上限，保证单帧
// 同步 tokenize 的耗时可控（典型超大文件退化窗口切片远小于此值，故仍可同步着色）。
const MAX_SYNC_HIGHLIGHT_SLICE_LENGTH = 50_000;

// 可见区上下额外着色的行数：平滑滚动时的着色衔接缓冲，并作为超大文件窗口退化时的缓冲。
// 取较大值以覆盖快速滚动单帧的跨度，减少滚动越界触发重算的频率，降低闪烁概率。
const HIGHLIGHT_OVERSCAN_LINES = 120;

// 输入停顿后过多久触发一次重算（毫秒）；过小会让连续输入仍频繁重算，过大高亮滞后明显。
const HIGHLIGHT_RECOMPUTE_DEBOUNCE_MS = 90;

// 视口滚动触发的重算使用 rAF 合帧：一帧内多次 viewportChanged 只提交一次 Worker 任务。
// 不做大块 debounce，避免快速滚动后可见区高亮明显滞后。
const HIGHLIGHT_VIEWPORT_FRAME_FALLBACK_MS = 16;

// Shiki token 样式种类远少于 token 数量。缓存 Decoration.mark 可避免滚动/重算时
// 为同一 style 字符串反复分配短生命周期对象；设置上限避免异常主题造成无界增长。
const MAX_TOKEN_DECORATION_CACHE_SIZE = 512;

const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;

const tokenDecorationCache = new Map<string, Decoration>();

// 当前语言（app 语言 id）由外部通过 effect 注入。
const setShikiLanguageEffect = StateEffect.define<string>();
// Worker 异步 tokenize 完成后借此 effect 应用 decorations。
const shikiWorkerResultEffect = StateEffect.define<TShikiWorkerHighlightResult>();
// 防抖超时触发的重算信号。
const shikiRecomputeEffect = StateEffect.define<null>();

/** 供外部在语言切换时派发，通知高亮插件更新语言。 */
export const setShikiLanguage = (language: string): StateEffect<string> =>
  setShikiLanguageEffect.of(language);

export type TShikiHighlightUpdateAction = 'recompute' | 'remap' | 'skip';

type TShikiHighlightSlice = {
  code: string;
  startLine: number;
  endLine: number;
};

type TShikiWorkerHighlightResult = {
  requestId: number;
  docVersion: number;
  language: string;
  startLine: number;
  endLine: number;
  tokens: IShikiThemedToken[][] | null;
};

type TShikiHighlightRequestIdentity = {
  key: string;
  requestId: number;
  docVersion: number;
  language: string;
  startLine: number;
  endLine: number;
};

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
  workerResultReceived?: boolean;
  docChanged: boolean;
  viewportChanged?: boolean;
}): TShikiHighlightUpdateAction => {
  if (input.workerResultReceived) {
    return 'skip';
  }
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

export const isShikiHighlightRangeCovered = (input: {
  coveredStartLine: number | null;
  coveredEndLine: number | null;
  requestedStartLine: number;
  requestedEndLine: number;
}): boolean =>
  input.coveredStartLine !== null &&
  input.coveredEndLine !== null &&
  input.requestedStartLine >= input.coveredStartLine &&
  input.requestedEndLine <= input.coveredEndLine;

export const createShikiHighlightRequestKey = (input: {
  language: string;
  docVersion: number;
  startLine: number;
  endLine: number;
  codeLength: number;
}): string =>
  [input.language, input.docVersion, input.startLine, input.endLine, input.codeLength].join(':');

/**
 * 纯函数：判断本次重算是否走“主线程同步着色”快路径。
 * 仅当目标语法已在主线程加载、且切片体积不超过上限时返回 true：此时可在当前 update 内
 * 同步 tokenize 并立即着色，避免滚动暴露的新行先以无色渲染、等 Worker 回包才补色的闪烁。
 * 语法未加载或切片过大时返回 false，回退到 Worker 异步路径，避免阻塞 UI 线程。
 */
export const shouldHighlightSynchronously = (input: {
  languageLoaded: boolean;
  sliceCodeLength: number;
  maxSyncSliceLength: number;
}): boolean => input.languageLoaded && input.sliceCodeLength <= input.maxSyncSliceLength;

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

const tokenDecoration = (style: string): Decoration => {
  const cached = tokenDecorationCache.get(style);
  if (cached) {
    return cached;
  }

  const decoration = Decoration.mark({ attributes: { style } });
  if (tokenDecorationCache.size >= MAX_TOKEN_DECORATION_CACHE_SIZE) {
    const oldestKey = tokenDecorationCache.keys().next().value;
    if (oldestKey) {
      tokenDecorationCache.delete(oldestKey);
    }
  }
  tokenDecorationCache.set(style, decoration);
  return decoration;
};

// 仅截取当前可见行所需的切片，单次成本与可见行数相关而非文档总长，
// 避免大文件编辑/滚动时提交过重 Worker 任务。默认从文档首行起切片以保证跨行结构
// 在可见区配色正确（见 computeShikiHighlightRange）。返回所用行范围供调用方做复用判定。
const computeShikiHighlightSlice = (view: EditorView): TShikiHighlightSlice | null => {
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
    // 窗口切片仍超限（极端长行）时放弃高亮，避免 Worker 任务过重。
    if (sliceTo - sliceFrom > MAX_HIGHLIGHT_SLICE_LENGTH) {
      return null;
    }
  }

  return {
    code: doc.sliceString(sliceFrom, sliceTo),
    startLine: range.startLine,
    endLine: range.endLine,
  };
};

const buildDecorationsFromTokenLines = (
  view: EditorView,
  startLine: number,
  endLine: number,
  lines: IShikiThemedToken[][],
): DecorationSet => {
  const { doc } = view.state;
  const builder = new RangeSetBuilder<Decoration>();
  const lineCount = Math.min(lines.length, endLine - startLine + 1, doc.lines - startLine + 1);
  for (let index = 0; index < lineCount; index += 1) {
    const lineTokens = lines[index];
    if (!lineTokens || lineTokens.length === 0) {
      continue;
    }
    const docLine = doc.line(startLine + index);
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
        builder.add(from, to, tokenDecoration(style));
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
    private viewportRecomputeTimer: number | null = null;
    private nextRequestId = 1;
    private latestRequestId = 0;
    private docVersion = 0;
    private pendingRequest: TShikiHighlightRequestIdentity | null = null;
    // 已成功高亮的语言与行范围；用于滚动时判断当前可见区是否已被覆盖，覆盖则跳过重算。
    private highlightedLanguage: string | null = null;
    private highlightedStartLine: number | null = null;
    private highlightedEndLine: number | null = null;

    constructor(view: EditorView) {
      this.decorations = Decoration.none;
      this.recompute(view, { allowReuse: false });
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) {
        this.docVersion += 1;
      }

      const workerResult = this.takeWorkerResult(update);
      if (workerResult) {
        this.applyWorkerResult(update.view, workerResult);
      }

      const languageChanged =
        update.startState.field(shikiLanguageField, false) !==
        update.state.field(shikiLanguageField, false);
      const recomputeRequested = update.transactions.some((tr) =>
        tr.effects.some((effect) => effect.is(shikiRecomputeEffect)),
      );

      const action = resolveShikiHighlightUpdateAction({
        languageChanged,
        recomputeRequested,
        workerResultReceived: Boolean(workerResult),
        docChanged: update.docChanged,
        viewportChanged: update.viewportChanged,
      });

      if (action === 'recompute') {
        if (!languageChanged && !recomputeRequested && update.viewportChanged) {
          // 仅滚动时按 animation frame 合并，避免滚动事件洪水反复打 Worker。
          this.scheduleViewportRecompute(update.view);
          return;
        }

        this.cancelScheduledRecompute();
        this.cancelScheduledViewportRecompute();
        // 语言切换 / 防抖重算请求需强制重建；仅滚动则允许复用已覆盖范围。
        const allowReuse = !languageChanged && !recomputeRequested;
        this.recompute(update.view, { allowReuse });
        return;
      }

      if (action === 'remap') {
        // 仅按编辑位移映射已有高亮，避免每次按键重新 tokenize；位移后缓存的行号已失效，
        // 先作废缓存，再重算按最新视口重建。
        this.decorations = this.decorations.map(update.changes);
        this.invalidateHighlightedRange();
        this.pendingRequest = null;
        this.cancelScheduledViewportRecompute();
        // 连续键入（input/delete/move）走防抖，避免每次按键都重 tokenize；而保存时格式化、
        // 载入文件、AI 补丁等“程序化整段替换”不带用户事件标记，其重排区间会丢色，若再等
        // 90ms 防抖才重算会出现一段明显的“未着色”白闪。这类变更立即重算，把空窗压到最小。
        const isUserTyping = update.transactions.some(
          (tr) => tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('move'),
        );
        if (isUserTyping) {
          this.scheduleRecompute(update.view);
        } else {
          this.cancelScheduledRecompute();
          this.recompute(update.view, { allowReuse: false });
        }
      }
    }

    destroy(): void {
      this.destroyed = true;
      this.cancelScheduledRecompute();
      this.cancelScheduledViewportRecompute();
      this.pendingRequest = null;
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

    private cancelScheduledViewportRecompute(): void {
      if (this.viewportRecomputeTimer === null) {
        return;
      }
      if (typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(this.viewportRecomputeTimer);
      } else {
        window.clearTimeout(this.viewportRecomputeTimer);
      }
      this.viewportRecomputeTimer = null;
    }

    private scheduleRecompute(view: EditorView): void {
      this.cancelScheduledRecompute();
      this.recomputeTimer = window.setTimeout(() => {
        this.recomputeTimer = null;
        if (this.destroyed) {
          return;
        }
        try {
          // 派发重算 effect，让插件在下一次 update 中对当前视口提交一次 Worker tokenize。
          view.dispatch({ effects: shikiRecomputeEffect.of(null) });
        } catch {
          // view 已销毁，忽略。
        }
      }, HIGHLIGHT_RECOMPUTE_DEBOUNCE_MS);
    }

    private scheduleViewportRecompute(view: EditorView): void {
      if (this.viewportRecomputeTimer !== null) {
        return;
      }
      const run = (): void => {
        this.viewportRecomputeTimer = null;
        if (this.destroyed) {
          return;
        }
        this.recompute(view, { allowReuse: true });
      };

      if (typeof window.requestAnimationFrame === 'function') {
        this.viewportRecomputeTimer = window.requestAnimationFrame(run);
        return;
      }

      this.viewportRecomputeTimer = window.setTimeout(run, HIGHLIGHT_VIEWPORT_FRAME_FALLBACK_MS);
    }

    private recompute(view: EditorView, options: { allowReuse: boolean }): void {
      const language = view.state.field(shikiLanguageField, false) ?? 'text';
      if (!resolveShikiLanguageId(language)) {
        this.decorations = Decoration.none;
        this.invalidateHighlightedRange();
        this.pendingRequest = null;
        return;
      }

      // 复用：语言未变且已高亮范围已覆盖当前可见区时，滚动无需重新 tokenize（零开销且不会露白）。
      if (options.allowReuse && this.isVisibleRangeHighlighted(view, language)) {
        return;
      }

      const slice = computeShikiHighlightSlice(view);
      if (!slice) {
        this.decorations = Decoration.none;
        this.invalidateHighlightedRange();
        this.pendingRequest = null;
        return;
      }

      const docVersion = this.docVersion;
      const requestKey = createShikiHighlightRequestKey({
        language,
        docVersion,
        startLine: slice.startLine,
        endLine: slice.endLine,
        codeLength: slice.code.length,
      });

      if (
        options.allowReuse &&
        this.pendingRequest &&
        this.pendingRequest.language === language &&
        this.pendingRequest.docVersion === docVersion &&
        (this.pendingRequest.key === requestKey ||
          isShikiHighlightRangeCovered({
            coveredStartLine: this.pendingRequest.startLine,
            coveredEndLine: this.pendingRequest.endLine,
            requestedStartLine: slice.startLine,
            requestedEndLine: slice.endLine,
          }))
      ) {
        return;
      }

      // 同步快路径：语法已在主线程加载且切片不大时，直接 tokenize 并即时着色，
      // 消除滚动暴露的新行“先露白、等 Worker 回包才补色”造成的闪烁/空白。
      const languageLoadedOnMainThread = isShikiLanguageLoaded(language);
      if (
        shouldHighlightSynchronously({
          languageLoaded: languageLoadedOnMainThread,
          sliceCodeLength: slice.code.length,
          maxSyncSliceLength: MAX_SYNC_HIGHLIGHT_SLICE_LENGTH,
        })
      ) {
        const tokens = tokenizeWithShikiSync(slice.code, language);
        if (tokens) {
          // 提升 latestRequestId 作废仍在途的旧 Worker 请求，避免其回包覆盖本次同步结果。
          this.latestRequestId = this.nextRequestId;
          this.nextRequestId += 1;
          this.pendingRequest = null;
          this.decorations = buildDecorationsFromTokenLines(
            view,
            slice.startLine,
            slice.endLine,
            tokens,
          );
          this.highlightedLanguage = language;
          this.highlightedStartLine = slice.startLine;
          this.highlightedEndLine = slice.endLine;
          return;
        }
      } else if (
        !languageLoadedOnMainThread &&
        slice.code.length <= MAX_SYNC_HIGHLIGHT_SLICE_LENGTH
      ) {
        // 主线程语法尚未就绪：后台预热（不阻塞本轮），使后续滚动可走同步快路径消除闪烁。
        // 本轮仍走下方 Worker 异步着色，保证首屏可用；旧装饰在途期间保留，避免露白。
        void ensureShikiLanguage(language);
      }

      const requestId = this.nextRequestId;
      this.nextRequestId += 1;
      this.latestRequestId = requestId;
      this.pendingRequest = {
        key: requestKey,
        requestId,
        docVersion,
        language,
        startLine: slice.startLine,
        endLine: slice.endLine,
      };

      void tokenizeWithShikiWorker(slice.code, language)
        .then((tokens) => {
          if (this.destroyed) {
            return;
          }
          try {
            view.dispatch({
              effects: shikiWorkerResultEffect.of({
                requestId,
                docVersion,
                language,
                startLine: slice.startLine,
                endLine: slice.endLine,
                tokens,
              }),
            });
          } catch {
            // view 已销毁，忽略。
          }
        })
        .finally(() => {
          if (this.pendingRequest?.requestId === requestId) {
            this.pendingRequest = null;
          }
        });
    }

    private takeWorkerResult(update: ViewUpdate): TShikiWorkerHighlightResult | null {
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (effect.is(shikiWorkerResultEffect)) {
            return effect.value;
          }
        }
      }
      return null;
    }

    private applyWorkerResult(view: EditorView, result: TShikiWorkerHighlightResult): void {
      const language = view.state.field(shikiLanguageField, false) ?? 'text';
      if (
        result.requestId !== this.latestRequestId ||
        result.docVersion !== this.docVersion ||
        result.language !== language ||
        !result.tokens
      ) {
        return;
      }

      this.decorations = buildDecorationsFromTokenLines(
        view,
        result.startLine,
        result.endLine,
        result.tokens,
      );
      this.highlightedLanguage = result.language;
      this.highlightedStartLine = result.startLine;
      this.highlightedEndLine = result.endLine;
    }

    private isVisibleRangeHighlighted(view: EditorView, language: string): boolean {
      if (this.highlightedLanguage !== language) {
        return false;
      }
      const { visibleRanges } = view;
      if (visibleRanges.length === 0) {
        return false;
      }
      const { doc } = view.state;
      const firstVisibleLine = doc.lineAt(visibleRanges[0].from).number;
      const lastVisibleLine = doc.lineAt(visibleRanges[visibleRanges.length - 1].to).number;
      return isShikiHighlightRangeCovered({
        coveredStartLine: this.highlightedStartLine,
        coveredEndLine: this.highlightedEndLine,
        requestedStartLine: firstVisibleLine,
        requestedEndLine: lastVisibleLine,
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
