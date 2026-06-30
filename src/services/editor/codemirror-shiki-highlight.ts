import { type Extension, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import {
  applyShikiEdit,
  disposeShikiSession,
  tokenizeRangeWithShikiWorker,
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

// 可见区下方额外着色的行数：平滑滚动时的下方衔接缓冲。取较大值以覆盖快速滚动
// 单帧的跨度，减少滚动越界触发重算的频率，降低闪烁概率。
const HIGHLIGHT_OVERSCAN_LINES = 72;

// DecorationSet 只需要覆盖真实视口附近。
// token 预取/缓存范围可以大，但 RangeSetBuilder 不应为大量屏幕外行重复创建 Decoration。
const DECORATION_RENDER_MARGIN_LINES = 8;

// 装饰渲染范围的块对齐粒度（行）。renderViewportFromCache 把「视口 ± margin」的上下沿分别
// 向下/向上对齐到该块边界，使在同一块内滚动时渲染范围（及其缓存 key）保持不变 → 直接命中
// decorationCache 复用，免去逐帧 RangeSetBuilder 重建（上下滑动丝滑的关键）；仅跨块时重建
// 一次（覆盖 1~2 块）。取 64 在「每帧零重建」与「跨块单次重建体积」之间取得平衡。
const DECORATION_RENDER_CHUNK_LINES = 64;

// 输入停顿后过多久触发一次重算（毫秒）；过小会让连续输入仍频繁重算，过大高亮滑后明显。
const HIGHLIGHT_RECOMPUTE_DEBOUNCE_MS = 90;

// Shiki token 样式种类远少于 token 数量。缓存 Decoration.mark 可避免滚动/重算时
// 为同一 style 字符串反复分配短生命周期对象；设置上限避免异常主题造成无界增长。
const MAX_TOKEN_DECORATION_CACHE_SIZE = 512;

// 按行 token 缓存的行数上限：滚动浏览过的行的 token 会被缓存以便回滚时零重算；
// 超大文件全程滚动可能缓存大量行，设上限并按最旧插入淘汰，避免内存无界增长。
// 被淘汰的行若再次进入视口会重新 tokenize（仍是有界的可见区切片，成本可控）。
const MAX_LINE_TOKEN_CACHE_LINES = 20_000;

// 超长单行保护：正常代码不受影响；minified/bundle/base64/压缩 JSON 等极端长行
// 不为该行构建大量 Decoration，避免 RangeSetBuilder 与布局测量被单行拖垮。
const MAX_DECORATED_LINE_LENGTH = 20_000;
const MAX_DECORATED_LINE_TOKEN_COUNT = 2_000;

const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;

const tokenDecorationCache = new Map<string, Decoration>();

// 每个高亮插件实例分配一个稳定的 sessionKey，Worker 据此分别持有各自文档的整篇文本与
// 块级语法状态缓存（支持多个编辑器实例并存而互不串话）。
let shikiSessionKeySeq = 0;

const nextShikiSessionKey = (): number => {
  shikiSessionKeySeq += 1;
  return shikiSessionKeySeq;
};

// 当前语言（app 语言 id）由外部通过 effect 注入。
const setShikiLanguageEffect = StateEffect.define<string>();
// Worker 异步 tokenize 完成后借此 effect 应用 decorations。
const shikiWorkerResultEffect = StateEffect.define<TShikiWorkerHighlightResult>();
// 防抖超时 / post-paint 触发的重算信号。
const shikiRecomputeEffect = StateEffect.define<null>();

/** 供外部在语言切换时派发，通知高亮插件更新语言。 */
export const setShikiLanguage = (language: string): StateEffect<string> =>
  setShikiLanguageEffect.of(language);

export type TShikiHighlightUpdateAction = 'recompute' | 'remap' | 'skip';

type TShikiDocChangeRecomputeTiming = 'debounced' | 'post-paint';

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

type TQueuedShikiWorkerRequest = {
  view: EditorView;
  getFullCode: () => string;
  sessionKey: number;
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
 * 文档变更后的高亮重算时机。
 * - 用户输入继续防抖，避免每个按键都 tokenize。
 * - 保存/格式化/AI patch/载入文件这类程序化变更必须等当前帧先画出来，再重算高亮；
 *   否则同步 tokenize 会堵在 CodeMirror 当前 update 事务里，造成 Ctrl+S 全屏白屏卡顿。
 */
export const resolveShikiDocChangeRecomputeTiming = (input: {
  isUserTyping: boolean;
}): TShikiDocChangeRecomputeTiming => (input.isUserTyping ? 'debounced' : 'post-paint');

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
  // 可选：把下沿向上取整到该行数的整数倍（夹取到末行）。用于让「从文档首行起」的
  // tokenize 切片在滚动时按块稳定；不传 = 不量化（渲染/覆盖判定等调用点行为不变）。
  chunkLines?: number;
}): { startLine: number; endLine: number } => {
  const leadInLines = input.leadInLines ?? input.overscanLines;
  const rawEndLine = Math.min(input.totalLines, input.lastVisibleLine + input.overscanLines);
  const endLine =
    input.chunkLines && input.chunkLines > 0
      ? Math.min(input.totalLines, Math.ceil(rawEndLine / input.chunkLines) * input.chunkLines)
      : rawEndLine;
  const startLine = input.fromDocumentStart ? 1 : Math.max(1, input.firstVisibleLine - leadInLines);
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
 * 从按行 token 缓存构建 [startLine, endLine] 区间的装饰集合。
 * 仅渲染缓存命中的行；未命中的行不产生装饰（呈纯文本），由调用方在 Worker 路径补齐后
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

    if (
      docLine.length > MAX_DECORATED_LINE_LENGTH ||
      lineTokens.length > MAX_DECORATED_LINE_TOKEN_COUNT
    ) {
      continue;
    }

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
    private recomputeFrame: number | null = null;
    private readonly shikiSessionKey = nextShikiSessionKey();
    private nextRequestId = 1;
    private latestRequestId = 0;
    private docVersion = 0;
    private pendingRequest: TShikiHighlightRequestIdentity | null = null;
    private activeWorkerRequestId: number | null = null;
    private queuedWorkerRequest: TQueuedShikiWorkerRequest | null = null;
    // 按行 token 缓存：key=文档行号(1-based)，value=该行 token。仅对 (cacheLanguage,
    // cacheDocVersion) 有效；语言或文档版本变化时整体作废。命中缓存的可见区可零 tokenize
    // 同步重建装饰，是“滚动零闪烁”的核心：来回滚动看过的行无需重算，新行一出现即着色。
    private lineTokenCache = new Map<number, IShikiThemedToken[]>();
    private cacheLanguage: string | null = null;
    private cacheDocVersion = -1;
    private lineTokenCacheRevision = 0;
    private decorationCacheKey: string | null = null;
    private decorationCache: DecorationSet | null = null;

    constructor(view: EditorView) {
      this.decorations = Decoration.none;
      this.recompute(view, { allowReuse: false });
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) {
        this.docVersion += 1;
        this.sendShikiEdit(update);
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
        if (update.viewportChanged && !languageChanged && !recomputeRequested) {
          // 纯滚动：先用按行缓存同步重建装饰（命中缓存的行零闪烁、不清空），再让 CodeMirror
          // 虚拟滚动把新行文本画出来，下一帧（post-paint）对新进入视口的未缓存行补算高亮。
          this.renderViewportFromCache(update.view);
          // 仅当新视口确有未缓存行时才安排重算派发。滚回已着色区域（或小文件整篇已缓存）时，
          // 跳过这次 dispatch——否则每次滚动停下都会多派发一个空事务，触发全量 update 循环
          // （所有 ViewPlugin.update 与 updateListener 重跑），与浏览器滚动/绘制抢主线程。
          if (!this.viewportFullyCached(update.view)) {
            this.schedulePostPaintRecompute(update.view);
          }
          return;
        }

        // 语言切换 / 收到重算请求（防抖超时、post-paint）：对当前视口重算。
        this.cancelScheduledRecompute();
        // 语言切换 / 防抖重算请求需强制重建；其余允许复用缓存与在途 Worker 请求。
        const allowReuse = !languageChanged && !recomputeRequested;
        this.recompute(update.view, { allowReuse });
        return;
      }

      if (action === 'remap') {
        // 先只做位移映射，避免文档变更当场清空高亮装饰。docVersion 已自增，按行缓存会在
        // 下一次 recompute 的 ensureCacheContext 中整体作废（行号已随编辑位移失效）。
        this.decorations = this.decorations.map(update.changes);
        this.pendingRequest = null;
        const isUserTyping = update.transactions.some(
          (tr) => tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('move'),
        );
        const timing = resolveShikiDocChangeRecomputeTiming({ isUserTyping });
        if (timing === 'debounced') {
          this.scheduleRecompute(update.view);
        } else {
          // 保存/格式化/AI patch/载入文件等程序化变更不能在当前 CodeMirror update 事务里
          // 立即同步 tokenize。否则 Ctrl+S 会把 WebView 渲染线程堵到整窗白屏。先让当前帧
          // 完成绘制，再在下一轮任务派发重算 effect。
          this.schedulePostPaintRecompute(update.view);
        }
      }
    }

    destroy(): void {
      this.destroyed = true;
      this.cancelScheduledRecompute();
      disposeShikiSession(this.shikiSessionKey);
      this.pendingRequest = null;
      this.activeWorkerRequestId = null;
      this.queuedWorkerRequest = null;
      this.lineTokenCache.clear();
      this.decorationCacheKey = null;
      this.decorationCache = null;
    }

    private cancelScheduledRecompute(): void {
      if (this.recomputeTimer !== null) {
        window.clearTimeout(this.recomputeTimer);
        this.recomputeTimer = null;
      }
      if (this.recomputeFrame !== null) {
        window.cancelAnimationFrame(this.recomputeFrame);
        this.recomputeFrame = null;
      }
    }

    private dispatchRecompute(view: EditorView): void {
      if (this.destroyed) {
        return;
      }
      try {
        // 派发重算 effect，让插件在下一次 update 中对当前视口重算。
        view.dispatch({ effects: shikiRecomputeEffect.of(null) });
      } catch {
        // view 已销毁，忽略。
      }
    }

    private scheduleRecompute(view: EditorView): void {
      this.cancelScheduledRecompute();
      this.recomputeTimer = window.setTimeout(() => {
        this.recomputeTimer = null;
        this.dispatchRecompute(view);
      }, HIGHLIGHT_RECOMPUTE_DEBOUNCE_MS);
    }

    private schedulePostPaintRecompute(view: EditorView): void {
      this.cancelScheduledRecompute();
      this.recomputeFrame = window.requestAnimationFrame(() => {
        this.recomputeFrame = null;
        this.recomputeTimer = window.setTimeout(() => {
          this.recomputeTimer = null;
          this.dispatchRecompute(view);
        }, 0);
      });
    }

    /** 语言或文档版本变化时整体作废按行缓存（行号/语法状态已失效）。 */
    private ensureCacheContext(language: string): void {
      if (this.cacheLanguage !== language || this.cacheDocVersion !== this.docVersion) {
        this.lineTokenCache.clear();
        this.lineTokenCacheRevision += 1;
        this.decorationCacheKey = null;
        this.decorationCache = null;
        this.cacheLanguage = language;
        this.cacheDocVersion = this.docVersion;
      }
    }

    /** 把一段切片的 token 按文档行号写入按行缓存，并按上限淘汰最旧行。 */
    private cacheSliceLines(sliceStartLine: number, lines: IShikiThemedToken[][]): void {
      for (let index = 0; index < lines.length; index += 1) {
        this.lineTokenCache.set(sliceStartLine + index, lines[index] ?? []);
      }
      if (lines.length > 0) {
        this.lineTokenCacheRevision += 1;
        this.decorationCacheKey = null;
        this.decorationCache = null;
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

    /**
     * 当前视口（含 overscan）是否已全部命中按行缓存。用于纯滚动时判定能否跳过重算派发：
     * 返回 true 表示这次滚动可见区无需 tokenize，recompute 也只会同步重建装饰（空操作），
     * 故可安全跳过派发。缓存上下文（语言/文档版本）与当前不一致时一律返回 false，把作废与
     * 重算交给 recompute，避免用过期缓存误判而漏掉重算。判定范围与 recompute 内完全一致。
     */
    private viewportFullyCached(view: EditorView): boolean {
      const language = view.state.field(shikiLanguageField, false) ?? 'text';
      if (this.cacheLanguage !== language || this.cacheDocVersion !== this.docVersion) {
        return false;
      }
      const visible = this.getVisibleLineRange(view);
      if (!visible) {
        return false;
      }
      const range = computeShikiHighlightRange({
        firstVisibleLine: visible.first,
        lastVisibleLine: visible.last,
        totalLines: view.state.doc.lines,
        overscanLines: HIGHLIGHT_OVERSCAN_LINES,
        leadInLines: HIGHLIGHT_OVERSCAN_LINES,
        fromDocumentStart: false,
      });
      return (
        findUncachedLineRange({
          startLine: range.startLine,
          endLine: range.endLine,
          isCached: (lineNumber) => this.lineTokenCache.has(lineNumber),
        }) === null
      );
    }

    /** 按当前视口 + overscan 从按行缓存重建装饰（同步、零 tokenize）。 */
    private renderViewportFromCache(view: EditorView): void {
      const visible = this.getVisibleLineRange(view);
      if (!visible) {
        return;
      }
      const totalLines = view.state.doc.lines;
      const rawRange = computeShikiHighlightRange({
        firstVisibleLine: visible.first,
        lastVisibleLine: visible.last,
        totalLines,
        overscanLines: DECORATION_RENDER_MARGIN_LINES,
        leadInLines: DECORATION_RENDER_MARGIN_LINES,
        fromDocumentStart: false,
      });
      // 把渲染范围上下沿对齐到块边界：同一块内滚动时 renderRange 不变 → 下方 decorationCache
      // 直接命中复用，逐帧零重建装饰（上下滑动丝滑的关键）；仅跨块时重建一次。
      const renderBlock = DECORATION_RENDER_CHUNK_LINES;
      const renderRange = {
        startLine: Math.max(
          1,
          Math.floor((rawRange.startLine - 1) / renderBlock) * renderBlock + 1,
        ),
        endLine: Math.min(totalLines, Math.ceil(rawRange.endLine / renderBlock) * renderBlock),
      };
      const renderCacheKey = [
        this.cacheLanguage ?? '',
        this.cacheDocVersion,
        this.lineTokenCacheRevision,
        renderRange.startLine,
        renderRange.endLine,
      ].join(':');

      if (this.decorationCacheKey === renderCacheKey && this.decorationCache) {
        this.decorations = this.decorationCache;
        return;
      }

      const decorations = buildDecorationsFromLineCache(
        view,
        renderRange.startLine,
        renderRange.endLine,
        this.lineTokenCache,
      );
      this.decorationCacheKey = renderCacheKey;
      this.decorationCache = decorations;
      this.decorations = decorations;
    }

    /**
     * 文档变更后向 Worker 发送行级增量 delta：fromLine..oldEndLine（旧文档）被替换为
     * fromLine..newEndLine（新文档）的行文本；Worker 据此原地更新整篇文本并仅作废受影响块状态。
     */
    private sendShikiEdit(update: ViewUpdate): void {
      const language = update.state.field(shikiLanguageField, false) ?? 'text';
      if (!resolveShikiLanguageId(language)) {
        return;
      }
      const oldDoc = update.startState.doc;
      const newDoc = update.state.doc;
      let minFromA = Number.POSITIVE_INFINITY;
      let maxToA = -1;
      let maxToB = -1;
      update.changes.iterChanges((fromA, toA, _fromB, toB) => {
        if (fromA < minFromA) {
          minFromA = fromA;
        }
        if (toA > maxToA) {
          maxToA = toA;
        }
        if (toB > maxToB) {
          maxToB = toB;
        }
      });
      if (maxToA < 0) {
        return;
      }
      const fromLine = oldDoc.lineAt(minFromA).number;
      const oldEndLine = oldDoc.lineAt(maxToA).number;
      const newEndLine = newDoc.lineAt(maxToB).number;
      const deletedLineCount = oldEndLine - fromLine + 1;
      const insertedLines: string[] = [];
      for (let ln = fromLine; ln <= newEndLine; ln += 1) {
        insertedLines.push(newDoc.line(ln).text);
      }
      applyShikiEdit(
        this.shikiSessionKey,
        this.docVersion,
        fromLine,
        deletedLineCount,
        insertedLines,
      );
    }

    private recompute(view: EditorView, options: { allowReuse: boolean }): void {
      const language = view.state.field(shikiLanguageField, false) ?? 'text';
      if (!resolveShikiLanguageId(language)) {
        this.decorations = Decoration.none;
        this.lineTokenCache.clear();
        this.lineTokenCacheRevision += 1;
        this.decorationCacheKey = null;
        this.decorationCache = null;
        this.cacheLanguage = null;
        this.cacheDocVersion = -1;
        this.pendingRequest = null;
        return;
      }

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

      // —— Worker tokenize ——
      // 先用现有缓存（可能为部分命中）同步重建，已着色的行保持不变；再请求 Worker 对未命中的
      // 行范围 tokenize（Worker 持有整篇文档，按会话 + 行范围续算，无需主线程切片传整段代码）。
      this.renderViewportFromCache(view);

      const docVersion = this.docVersion;
      const requestKey = createShikiHighlightRequestKey({
        language,
        docVersion,
        startLine: uncached.startLine,
        endLine: uncached.endLine,
        codeLength: view.state.doc.length,
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
            requestedStartLine: uncached.startLine,
            requestedEndLine: uncached.endLine,
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
        startLine: uncached.startLine,
        endLine: uncached.endLine,
      };

      this.enqueueWorkerTokenize({
        view,
        getFullCode: () => view.state.doc.toString(),
        sessionKey: this.shikiSessionKey,
        requestId,
        docVersion,
        language,
        startLine: uncached.startLine,
        endLine: uncached.endLine,
      });
    }

    private enqueueWorkerTokenize(request: TQueuedShikiWorkerRequest): void {
      if (this.activeWorkerRequestId !== null) {
        this.queuedWorkerRequest = request;
        return;
      }

      this.runWorkerTokenize(request);
    }

    private runWorkerTokenize(request: TQueuedShikiWorkerRequest): void {
      this.activeWorkerRequestId = request.requestId;

      void tokenizeRangeWithShikiWorker(
        request.sessionKey,
        request.getFullCode,
        request.language,
        request.docVersion,
        request.startLine,
        request.endLine,
      )
        .then((tokens) => {
          if (this.destroyed) {
            return;
          }

          try {
            request.view.dispatch({
              effects: shikiWorkerResultEffect.of({
                requestId: request.requestId,
                docVersion: request.docVersion,
                language: request.language,
                startLine: request.startLine,
                endLine: request.endLine,
                tokens,
              }),
            });
          } catch {
            // view 已销毁，忽略。
          }
        })
        .finally(() => {
          if (this.pendingRequest?.requestId === request.requestId) {
            this.pendingRequest = null;
          }

          if (this.activeWorkerRequestId === request.requestId) {
            this.activeWorkerRequestId = null;
          }

          const queued = this.queuedWorkerRequest;
          this.queuedWorkerRequest = null;

          if (!queued || this.destroyed) {
            return;
          }

          const currentLanguage = queued.view.state.field(shikiLanguageField, false) ?? 'text';
          const isStillLatest =
            queued.requestId === this.latestRequestId &&
            queued.docVersion === this.docVersion &&
            queued.language === currentLanguage;

          if (!isStillLatest) {
            return;
          }

          this.runWorkerTokenize(queued);
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
      fontSize: '14px',
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
      // 行号 / gutter 文本禁止鼠标选中（macOS WKWebView 需 -webkit- 前缀，故双写）。
      userSelect: 'none',
      WebkitUserSelect: 'none',
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
