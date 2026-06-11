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

// 单次 tokenize 切片的字节上限：Worker 回退路径默认从文档开头切到可见区下沿，超过
// 此上限时退化为仅切可见区窗口；窗口切片仍超限（极端长行，如压缩成一行的文件）
// 则放弃高亮，避免 Worker 任务过重。注意这是“切片”上限而非“整文档”上限。
const MAX_HIGHLIGHT_SLICE_LENGTH = 200_000;

// 同步着色的切片字节上限：语法已在主线程加载、且可见区窗口切片不超过此值时，
// 直接在主线程 tokenize 并即时着色。取值远小于 Worker 切片上限，保证单帧同步
// tokenize 的耗时可控（可见区窗口仅几百行，典型远小于此值）。超过则回退到 Worker。
const MAX_SYNC_HIGHLIGHT_SLICE_LENGTH = 50_000;

// 可见区下方额外着色的行数：平滑滚动时的下方衔接缓冲。取较大值以覆盖快速滚动
// 单帧的跨度，减少滚动越界触发重算的频率，降低闪烁概率。
const HIGHLIGHT_OVERSCAN_LINES = 120;

// 同步着色时可见区上方的 lead-in 行数：不从文档开头切片时，从可见区上沿向上多取
// 这些行作为语法状态的“启动上下文”，使块注释/heredoc/多行字符串等跨行结构在
// 可见区配色尽量正确。取较大值以覆盖绝大多数现实代码的跨行跨度；极端超长跨行
// 结构（距视口上千行的块注释）是专业编辑器靠“每行状态缓存”解决的罕见场景，
// 此处以“零闪烁”为优先权衡，从文档开头的完全正确着色由 Worker 回退路径提供。
const SYNC_HIGHLIGHT_LEAD_IN_LINES = 200;

// 输入停顿后过多久触发一次重算（毫秒）；过小会让连续输入仍频繁重算，过大高亮滞后明显。
const HIGHLIGHT_RECOMPUTE_DEBOUNCE_MS = 90;

// Shiki token 样式种类远少于 token 数量。缓存 Decoration.mark 可避免滚动/重算时
// 为同一 style 字符串反复分配短生命周期对象；设置上限避免异常主题造成无界增长。
const MAX_TOKEN_DECORATION_CACHE_SIZE = 512;

// 按行 token 缓存的行数上限：滚动浏览过的行的 token 会被缓存以便回滚时零重算；
// 超大文件全程滚动可能缓存大量行，设上限并按最旧插入淘汰，避免内存无界增长。
// 被淘汰的行若再次进入视口会重新 tokenize（仍是有界的可见区切片，成本可控）。
const MAX_LINE_TOKEN_CACHE_LINES = 6_000;

const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;

const tokenDecorationCache = new Map<string, Decoration>();

// 当前语言（app 语言 id）由外部通过 effect 注入。
const setShikiLanguageEffect = StateEffect.define<string>();
// Worker 异步 tokenize 完成后借此 effect 应用 decorations。
const shikiWorkerResultEffect = StateEffect.define<TShikiWorkerHighlightResult>();
// 防抖超时 / 语法预热完成触发的重算信号。
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
 * - endLine：可见区下沿 + overscanLines，并夹取到文档末行；视口下方内容不影响可见区配色。
 * - startLine：
 *   - fromDocumentStart=true：固定为第 1 行，使 Shiki 语法状态从真实边界续算（完全正确）。
 *   - fromDocumentStart=false：可见区上沿 - leadInLines（夹取到第 1 行）的窗口。
 * leadInLines 未传时默认等于 overscanLines（向后兼容旧调用点）；同步路径传入较大的 lead-in
 * 以获取足够的语法启动上下文，而下方 overscan 可以较小，两者非对称。
 */
export const computeShikiHighlightRange = (input: {
  firstVisibleLine: number;
  lastVisibleLine: number;
  totalLines: number;
  overscanLines: number;
  fromDocumentStart: boolean;
  leadInLines?: number;
}): { startLine: number; endLine: number } => {
  const leadInLines = input.leadInLines ?? input.overscanLines;
  const endLine = Math.min(input.totalLines, input.lastVisibleLine + input.overscanLines);
  const startLine = input.fromDocumentStart
    ? 1
    : Math.max(1, input.firstVisibleLine - leadInLines);
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
 * 纯函数：在 [startLine, endLine] 中找出尚未命中按行缓存的最小包络范围。
 * - 全部命中缓存时返回 null（调用方据此跳过 tokenize，直接用缓存同步重建装饰，零开销）。
 * - 否则返回 [首个缺失行, 末个缺失行]，中间已缓存的行也含在内（包络范围，便于一次性补齐）。
 * isCached 以谓词形式传入，使本函数保持纯粹且易测（无需依赖具体缓存实现）。
 */
export const findUncachedLineRange = (input: {
  startLine: number;
  endLine: number;
  isCached: (lineNumber: number) => boolean;
}): { startLine: number; endLine: number } | null => {
  let firstMissing: number | null = null;
  let lastMissing: number | null = null;
  for (let line = input.startLine; line <= input.endLine; line += 1) {
    if (!input.isCached(line)) {
      if (firstMissing === null) {
        firstMissing = line;
      }
      lastMissing = line;
    }
  }
  if (firstMissing === null || lastMissing === null) {
    return null;
  }
  return { startLine: firstMissing, endLine: lastMissing };
};

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

/**
 * 截取需要 tokenize 的切片，单次成本与可见行数相关而非文档总长。
 * - fromDocumentStart=true（Worker 回退）：从文档首行切起，跨行结构完全正确；超过体积
 *   上限则退化为可见区窗口。
 * - fromDocumentStart=false（同步快路径）：仅切 [视口顶 - leadInLines .. 视口底 + overscan]
 *   的有界窗口，切片恒小，使主线程同步 tokenize 耗时可控。
 * 窗口切片仍超体积上限（极端长行）时返回 null，调用方据此放弃高亮。返回所用行范围供复用判定。
 */
const computeShikiHighlightSlice = (
  view: EditorView,
  options: { fromDocumentStart: boolean; leadInLines?: number },
): TShikiHighlightSlice | null => {
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

  const buildSlice = (
    fromDocumentStart: boolean,
  ): { range: { startLine: number; endLine: number }; sliceFrom: number; sliceTo: number } => {
    const range = computeShikiHighlightRange({
      firstVisibleLine,
      lastVisibleLine,
      totalLines: doc.lines,
      overscanLines: HIGHLIGHT_OVERSCAN_LINES,
      leadInLines: options.leadInLines ?? HIGHLIGHT_OVERSCAN_LINES,
      fromDocumentStart,
    });
    return {
      range,
      sliceFrom: doc.line(range.startLine).from,
      sliceTo: doc.line(range.endLine).to,
    };
  };

  let { range, sliceFrom, sliceTo } = buildSlice(options.fromDocumentStart);

  // 仅 fromDocumentStart 模式可能切片过大（超大文件），退化为可见区窗口；窗口模式本就有界。
  if (options.fromDocumentStart && sliceTo - sliceFrom > MAX_HIGHLIGHT_SLICE_LENGTH) {
    ({ range, sliceFrom, sliceTo } = buildSlice(false));
  }

  // 窗口切片仍超限（极端长行）时放弃高亮，避免任务过重。
  if (sliceTo - sliceFrom > MAX_HIGHLIGHT_SLICE_LENGTH) {
    return null;
  }

  return {
    code: doc.sliceString(sliceFrom, sliceTo),
    startLine: range.startLine,
    endLine: range.endLine,
  };
};

/**
 * 从按行 token 缓存构建 [startLine, endLine] 区间的装饰集合。
 * 仅渲染缓存命中的行；未命中的行不产生装饰（呈纯文本），由调用方在同步/Worker 路径补齐后
 * 重建。RangeSetBuilder 要求按位置升序添加：按行升序、行内 token 顺序累加可天然满足。
 */
const buildDecorationsFromLineCache = (
  view: EditorView,
  startLine: number,
  endLine: number,
  cache: Map<number, IShikiThemedToken[]>,
): DecorationSet => {
  const { doc } = view.state;
  const builder = new RangeSetBuilder<Decoration>();
  const lastLine = Math.min(endLine, doc.lines);
  for (let lineNumber = Math.max(1, startLine); lineNumber <= lastLine; lineNumber += 1) {
    const lineTokens = cache.get(lineNumber);
    if (!lineTokens || lineTokens.length === 0) {
      continue;
    }
    const docLine = doc.line(lineNumber);
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
    private nextRequestId = 1;
    private latestRequestId = 0;
    private docVersion = 0;
    private pendingRequest: TShikiHighlightRequestIdentity | null = null;
    // 已发起主线程预热的语言；避免每次 recompute 重复创建微任务，失败则复位以允许重试。
    private warmedLanguage: string | null = null;
    // 按行 token 缓存：key=文档行号(1-based)，value=该行 token。仅对 (cacheLanguage,
    // cacheDocVersion) 有效；语言或文档版本变化时整体作废。命中缓存的可见区可零 tokenize
    // 同步重建装饰，是“滚动零闪烁”的核心：来回滚动看过的行无需重算，新行一出现即着色。
    private lineTokenCache = new Map<number, IShikiThemedToken[]>();
    private cacheLanguage: string | null = null;
    private cacheDocVersion = -1;

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
        // 滚动（viewportChanged）此处同步重算，而非旧实现的 rAF 合帧：rAF 会让 CM 当帧先用
        // 旧装饰画出新滚出来的行（无色），下一帧才补色，造成每次滚动必现 1 帧露白闪烁。
        // 借助按行缓存，同步重算在命中缓存时仅重建装饰（极廉价），未命中也只同步 tokenize
        // 一个有界窗口，故可安全地在 update() 内同步完成，使新行首帧即着色。
        this.cancelScheduledRecompute();
        // 语言切换 / 防抖重算请求需强制重建；仅滚动则允许复用缓存与在途 Worker 请求。
        const allowReuse = !languageChanged && !recomputeRequested;
        this.recompute(update.view, { allowReuse });
        return;
      }

      if (action === 'remap') {
        // 仅按编辑位移映射已有高亮，避免按键时的白闪；docVersion 已自增，按行缓存将在下一次
        // recompute 的 ensureCacheContext 中整体作废（行号已随编辑位移失效）。
        this.decorations = this.decorations.map(update.changes);
        this.pendingRequest = null;
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
      this.pendingRequest = null;
      this.lineTokenCache.clear();
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
          // 派发重算 effect，让插件在下一次 update 中对当前视口重算。
          view.dispatch({ effects: shikiRecomputeEffect.of(null) });
        } catch {
          // view 已销毁，忽略。
        }
      }, HIGHLIGHT_RECOMPUTE_DEBOUNCE_MS);
    }

    // 主线程语法预热（幂等）：Worker 有独立 highlighter 实例，主线程 loadedLanguages 仅在显式
    // 预热后才会填充，而这是同步快路径可用的前提。借鉴 VS Code / Monaco——语法在初始化时加载，
    // 而非等到滚动时才异步拉取。预热完成后派发一次重算，使当前视口立即切到同步路径。
    private warmMainThreadLanguage(view: EditorView, language: string): void {
      if (this.warmedLanguage === language) {
        return;
      }
      this.warmedLanguage = language;
      void ensureShikiLanguage(language).then((shikiId) => {
        if (this.destroyed) {
          return;
        }
        if (!shikiId) {
          // 预热失败（不支持/加载出错）：复位以便后续重试，避免永久停留在 Worker 路径。
          if (this.warmedLanguage === language) {
            this.warmedLanguage = null;
          }
          return;
        }
        if (view.state.field(shikiLanguageField, false) !== language) {
          return;
        }
        try {
          view.dispatch({ effects: shikiRecomputeEffect.of(null) });
        } catch {
          // view 已销毁，忽略。
        }
      });
    }

    /** 语言或文档版本变化时整体作废按行缓存（行号/语法状态已失效）。 */
    private ensureCacheContext(language: string): void {
      if (this.cacheLanguage !== language || this.cacheDocVersion !== this.docVersion) {
        this.lineTokenCache.clear();
        this.cacheLanguage = language;
        this.cacheDocVersion = this.docVersion;
      }
    }

    /** 把一段切片的 token 按文档行号写入按行缓存，并按上限淘汰最旧行。 */
    private cacheSliceLines(sliceStartLine: number, lines: IShikiThemedToken[][]): void {
      for (let index = 0; index < lines.length; index += 1) {
        this.lineTokenCache.set(sliceStartLine + index, lines[index] ?? []);
      }
      while (this.lineTokenCache.size > MAX_LINE_TOKEN_CACHE_LINES) {
        const oldestKey = this.lineTokenCache.keys().next().value;
        if (oldestKey === undefined) {
          break;
        }
        this.lineTokenCache.delete(oldestKey);
      }
    }

    private getVisibleLineRange(view: EditorView): { first: number; last: number } | null {
      const { visibleRanges } = view;
      if (visibleRanges.length === 0) {
        return null;
      }
      const { doc } = view.state;
      return {
        first: doc.lineAt(visibleRanges[0].from).number,
        last: doc.lineAt(visibleRanges[visibleRanges.length - 1].to).number,
      };
    }

    /** 按当前视口 + overscan 从按行缓存重建装饰（同步、零 tokenize）。 */
    private renderViewportFromCache(view: EditorView): void {
      const visible = this.getVisibleLineRange(view);
      if (!visible) {
        return;
      }
      const renderRange = computeShikiHighlightRange({
        firstVisibleLine: visible.first,
        lastVisibleLine: visible.last,
        totalLines: view.state.doc.lines,
        overscanLines: HIGHLIGHT_OVERSCAN_LINES,
        leadInLines: HIGHLIGHT_OVERSCAN_LINES,
        fromDocumentStart: false,
      });
      this.decorations = buildDecorationsFromLineCache(
        view,
        renderRange.startLine,
        renderRange.endLine,
        this.lineTokenCache,
      );
    }

    private recompute(view: EditorView, options: { allowReuse: boolean }): void {
      const language = view.state.field(shikiLanguageField, false) ?? 'text';
      if (!resolveShikiLanguageId(language)) {
        this.decorations = Decoration.none;
        this.lineTokenCache.clear();
        this.cacheLanguage = null;
        this.cacheDocVersion = -1;
        this.pendingRequest = null;
        return;
      }

      // 预热主线程语法，使后续滚动能走同步快路径。
      this.warmMainThreadLanguage(view, language);
      // 语言/文档版本变化时作废按行缓存。
      this.ensureCacheContext(language);

      const visible = this.getVisibleLineRange(view);
      if (!visible) {
        return;
      }

      const renderRange = computeShikiHighlightRange({
        firstVisibleLine: visible.first,
        lastVisibleLine: visible.last,
        totalLines: view.state.doc.lines,
        overscanLines: HIGHLIGHT_OVERSCAN_LINES,
        leadInLines: HIGHLIGHT_OVERSCAN_LINES,
        fromDocumentStart: false,
      });

      // 渲染范围已全部命中缓存：直接同步重建装饰，零 tokenize、零露白（含来回滚动）。
      const uncached = findUncachedLineRange({
        startLine: renderRange.startLine,
        endLine: renderRange.endLine,
        isCached: (lineNumber) => this.lineTokenCache.has(lineNumber),
      });
      if (uncached === null) {
        this.renderViewportFromCache(view);
        return;
      }

      // —— 同步快路径（主线程、可见区窗口、即时着色，零闪烁/零露白）——
      // 借鉴 CodeMirror 6 / VS Code：高亮采用主线程小增量同步解析。对“可见区窗口”（含
      // lead-in 上下文）同步 tokenize，切片有界且小，主线程耗时可控；结果按行入缓存，新行
      // 在当前 update 即着色，绝不晚一帧。
      if (isShikiLanguageLoaded(language)) {
        const syncSlice = computeShikiHighlightSlice(view, {
          fromDocumentStart: false,
          leadInLines: SYNC_HIGHLIGHT_LEAD_IN_LINES,
        });
        if (
          syncSlice &&
          shouldHighlightSynchronously({
            languageLoaded: true,
            sliceCodeLength: syncSlice.code.length,
            maxSyncSliceLength: MAX_SYNC_HIGHLIGHT_SLICE_LENGTH,
          })
        ) {
          const tokens = tokenizeWithShikiSync(syncSlice.code, language);
          if (tokens) {
            this.cacheSliceLines(syncSlice.startLine, tokens);
            // 作废仍在途的旧 Worker 请求，避免其回包覆盖本次同步结果。
            this.latestRequestId = this.nextRequestId;
            this.nextRequestId += 1;
            this.pendingRequest = null;
            this.renderViewportFromCache(view);
            return;
          }
        }
      }

      // —— Worker 回退 ——
      // 仅在首屏语法尚未预热完成、或极端长行切片过大无法同步时走此路。先用现有缓存（可能为
      // 部分命中）同步重建，已着色的行保持不变、不清空、不露白；再从文档开头切片交给 Worker，
      // 保证跨行结构配色正确，回包后入缓存重建。预热完成后的后续滚动都会走上面的同步快路径。
      this.renderViewportFromCache(view);

      const slice = computeShikiHighlightSlice(view, { fromDocumentStart: true });
      if (!slice) {
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

      // 回包结果按行入缓存（docVersion 已校验一致），再按当前视口重建装饰。
      this.ensureCacheContext(language);
      this.cacheSliceLines(result.startLine, result.tokens);
      this.renderViewportFromCache(view);
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
