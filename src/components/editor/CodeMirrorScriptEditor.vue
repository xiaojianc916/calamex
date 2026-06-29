<template>
  <div data-shell-resize-responder class="shell-editor-surface codemirror-editor-surface relative h-full min-h-0 w-full bg-(--editor-bg)"
    @contextmenu.prevent="handleContainerContextMenu">
    <div ref="containerRef" class="h-full min-h-0 w-full bg-(--editor-bg)"></div>
    <EditorContextMenu :open="contextMenuState.open" :x="contextMenuState.x" :y="contextMenuState.y"
      :groups="contextMenuGroups" :theme="props.theme" :submenu-direction="submenuDirection"
      @select="handleContextMenuItemSelect" />
  </div>
</template>

<script setup lang="ts">
import type {
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete';
import {
  acceptCompletion,
  autocompletion,
  completeAnyWord,
  snippet,
} from '@codemirror/autocomplete';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  selectParentSyntax,
  toggleLineComment,
  undo,
} from '@codemirror/commands';
import {
  bracketMatching,
  foldAll,
  foldKeymap,
  indentOnInput,
  unfoldAll,
} from '@codemirror/language';
import { type Diagnostic, lintGutter, setDiagnostics } from '@codemirror/lint';
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  highlightSelectionMatches,
  openSearchPanel,
  SearchQuery,
  search,
  searchKeymap,
  setSearchQuery,
} from '@codemirror/search';
import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  Prec,
  type SelectionRange,
} from '@codemirror/state';
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightSpecialChars,
  keymap,
  type Panel,
  rectangularSelection,
  showPanel,
  type ViewUpdate,
} from '@codemirror/view';
import { useEventListener, useResizeObserver } from '@vueuse/core';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import EditorContextMenu from '@/components/editor/EditorContextMenu.vue';
import type { IEditorContextMenuItem } from '@/components/editor/editor-context-menu.types';
import { useShellResizeFrameScheduler } from '@/composables/useShellResizeFrameScheduler';
import { buildCodeMirrorSettingsExtensions } from '@/services/editor/codemirror-config';
import { createCodeMirrorInlineCompletionController } from '@/services/editor/codemirror-inline-completion';
import {
  loadCodeMirrorLanguageSupport,
  resolveCodeMirrorLanguageExtension,
} from '@/services/editor/codemirror-language';
import {
  setShikiLanguage,
  shikiEditorChromeTheme,
  shikiHighlightExtension,
} from '@/services/editor/codemirror-shiki-highlight';
import {
  expandStructuralSelection,
  shrinkStructuralSelection,
  structuralSelectionHistoryField,
} from '@/services/editor/codemirror-structural-selection';
import {
  createLspExtension,
  createLucideCompletionIcon,
  lspCompletionTheme,
} from '@/services/editor/lsp-bridge';
import { useEditorStore } from '@/store/editor';
import type { TThemeMode } from '@/types/app';
import type {
  IAnalyzeScriptPayload,
  IEditorSelectionSummary,
  TScriptDiagnosticSeverity,
} from '@/types/editor';
import type { IEditorSettings } from '@/types/settings';
import { computeDocumentMetrics, type IDocumentMetrics } from '@/utils/editor/document-metrics';
import { computeDocChanges } from '@/utils/editor/editor-doc-diff';
import { resolveLanguageForPath } from '@/utils/editor/editor-language';
import { tryReadClipboardText, writeClipboardText } from '@/utils/platform/clipboard';

interface IEditorExpose {
  focusEditor: () => void;
  insertSnippet: (snippet: string) => void;
  revealPosition: (line: number, column: number) => void;
  layoutEditor: () => void;
}

// ──────────────────────────────
// Constants
// ──────────────────────────────
const VIEW_STATE_SAVE_DEBOUNCE_MS = 500;
const MENU_WIDTH = 224;
const MENU_MAX_HEIGHT = 320;
const SUBMENU_SAFE_WIDTH = 224;
const VIEWPORT_PADDING = 12;
const MENU_ROOT_SELECTOR = '.linear-context-menu-root';
const MENU_TRIGGER_SELECTOR = '.linear-context-menu-trigger';
const SELECTION_SUMMARY_CONTEXT_LINES = 60;
const SELECTION_SUMMARY_LONG_LINE_THRESHOLD = 4_000;
const SELECTION_SUMMARY_LONG_LINE_CONTEXT_CHARS = 100;

const createEmptyAnalysis = (): IAnalyzeScriptPayload => ({
  available: true,
  message: null,
  dialect: 'bash',
  diagnostics: [],
});

// ──────────────────────────────
// Lazy / cached shell completion source
// ──────────────────────────────
// `import('@/domains/terminal/utils/shell-completion')` 自身会被打包器缓存，但每次 completion 都
// 重新 `.then(...)` 并重新 `createShellCodeMirrorCompletionSource()` 仍有不必要的
// 微开销，且每次都拿到一个新的 source 实例，影响内部可能的状态复用。
let cachedShellCompletionSourcePromise: Promise<CompletionSource> | null = null;
const getShellCompletionSource = (): Promise<CompletionSource> => {
  if (!cachedShellCompletionSourcePromise) {
    cachedShellCompletionSourcePromise = import('@/domains/terminal/utils/shell-completion').then(
      (mod) => mod.createShellCodeMirrorCompletionSource(),
    );
  }
  return cachedShellCompletionSourcePromise;
};

const props = withDefaults(
  defineProps<{
    documentPath?: string | null;
    documentName?: string;
    modelValue?: string;
    theme?: TThemeMode;
    analysis?: IAnalyzeScriptPayload;
    editorSettings: IEditorSettings;
    canRun?: boolean;
  }>(),
  {
    documentPath: null,
    documentName: '',
    modelValue: '',
    theme: 'dark',
    analysis: undefined,
    canRun: false,
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: string, metrics?: IDocumentMetrics];
  'cursor-position-change': [line: number, column: number];
  'selection-change': [selection: IEditorSelectionSummary | null];
  'format-request': [];
  'command-palette-request': [];
  'run-request': [];
  'open-terminal-request': [];
}>();

const containerRef = ref<HTMLElement | null>(null);
const analysisState = computed(() => props.analysis ?? createEmptyAnalysis());
const analysisDiagnosticsSignature = computed(() => {
  const analysis = analysisState.value;
  if (!analysis.available) return 'unavailable';
  return analysis.diagnostics
    .map((item) =>
      [
        item.line,
        item.column,
        item.endLine,
        item.endColumn,
        item.level,
        item.code,
        item.message,
      ].join('\u001f'),
    )
    .join('\u001e');
});
const contextMenuState = ref({ open: false, x: 0 });
contextMenuState.value = { open: false, x: 0, y: 0 } as typeof contextMenuState.value & {
  y: number;
};
const contextMenuGroups = ref<ReturnType<typeof buildMenuGroups>>([]);
const submenuDirection = ref<'left' | 'right'>('right');

const editorStore = useEditorStore();

let editorView: EditorView | null = null;
let editorLayoutFrameId: number | null = null;
let viewStateSaveTimerId: number | null = null;
let suppressModelValueEmit = false;
// 记录最近一次与父组件 v-model 同步过的文档串:editor 自身 emit 出去的值,或外部
// 写入并已对齐的值。用于在 modelValue watcher 里做廉价的“回声”判定,避免每次按键
// 都对整篇文档 toString() 比较一次。
let lastSyncedModelValue: string | null = null;
let lastDocumentMetrics: IDocumentMetrics = computeDocumentMetrics(props.modelValue);
// 把同一同步 tick 内的多次文档变更(IME 组合、批量/多光标 dispatch)合并为一次 v-model
// emit:每次变更仍增量维护 metrics,但整篇 toString() 与 emit 推迟到 tick 末的微任务执行
// 一次。注意:单次按键的整篇 toString() 是 v-model「全文字符串」契约的固有成本,此处只消除
// 同一 tick 内的重复全文 emit,不改变单次按键语义;flush 始终读取当前文档,emit 的内容恒为
// 真实文档串,不会损坏内容。
let pendingModelValueEmit = false;
let pendingModelValueMetrics: IDocumentMetrics | null = null;
let previousContainerSize = { width: 0, height: 0 };
// 记录最近一次右键触发点(视口坐标),供浮动查找/转到行弹窗智能定位;消费后置空。
let lastPanelTriggerPoint: { x: number; y: number } | null = null;

const languageCompartment = new Compartment();
const settingsCompartment = new Compartment();
const completionCompartment = new Compartment();
const lspCompartment = new Compartment();
const gotoLinePanelCompartment = new Compartment();

const inlineCompletionController = createCodeMirrorInlineCompletionController({
  getFilePath: () => props.documentPath,
  getLanguage: () => getCurrentLanguage(),
});

// ──────────────────────────────
// Completion / language
// ──────────────────────────────
const buildCompletionExtension = (
  editorSettings: IEditorSettings,
  language: string,
  lspCompletionSource?: CompletionSource | null,
): Extension =>
  editorSettings.commandCompletion
    ? autocompletion({
        activateOnTyping: true,
        activateOnTypingDelay: editorSettings.suggestionDelay,
        // CM6 的 icons 是布尔开关：关掉内置字形，改用 Lucide SVG（addToOptions 渲染）
        icons: false,
        addToOptions: [
          {
            position: 20, // 图标槽位（label=50 / detail=80）
            render: (completion) => {
              try {
                return createLucideCompletionIcon(completion.type ?? 'text');
              } catch {
                return null;
              }
            },
          },
        ],
        override:
          language === 'shell'
            ? [
                async (completionContext: CompletionContext): Promise<CompletionResult | null> => {
                  const source = await getShellCompletionSource();
                  return source(completionContext);
                },
                ...(lspCompletionSource ? [lspCompletionSource] : []),
              ]
            : [completeAnyWord],
        maxRenderedOptions: 80,
      })
    : [];

const getCurrentLanguage = (): string =>
  resolveLanguageForPath(props.documentPath, props.documentName);

const normalizeDocumentMetrics = (metrics: IDocumentMetrics): IDocumentMetrics => ({
  lineCount: Math.max(1, metrics.lineCount),
  charCount: Math.max(0, metrics.charCount),
});

const applyDocumentMetricsFromChanges = (update: ViewUpdate): IDocumentMetrics => {
  let lineCount = lastDocumentMetrics.lineCount;
  let charCount = lastDocumentMetrics.charCount;

  update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const removedMetrics = computeDocumentMetrics(update.startState.doc.sliceString(fromA, toA));
    const insertedMetrics = computeDocumentMetrics(inserted.toString());

    lineCount += insertedMetrics.lineCount - removedMetrics.lineCount;
    charCount += insertedMetrics.charCount - removedMetrics.charCount;
  });

  lastDocumentMetrics = normalizeDocumentMetrics({ lineCount, charCount });
  return lastDocumentMetrics;
};

// ──────────────────────────────
// Selection helpers
// ──────────────────────────────
const lineColumnToOffset = (view: EditorView, line: number, column: number): number => {
  const lineInfo = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
  return Math.min(lineInfo.to, lineInfo.from + Math.max(0, column - 1));
};

const selectionRangeToText = (view: EditorView, range: SelectionRange): string =>
  view.state.doc.sliceString(range.from, range.to);

const resolveSelectedText = (): string => {
  const view = editorView;
  if (!view) return '';
  const selectedRanges = view.state.selection.ranges.filter((range) => !range.empty);
  if (selectedRanges.length > 0) {
    return selectedRanges.map((range) => selectionRangeToText(view, range)).join('\n');
  }
  const position = view.state.selection.main.head;
  const line = view.state.doc.lineAt(position);
  return line.text;
};

type TSelectionSummaryText = { text: string; truncated: boolean };

const withDefaultSelectionTruncation = (result: TSelectionSummaryText): string =>
  result.truncated ? `${result.text}\n[已截断]` : result.text;

const resolveSelectionLineWindow = (input: {
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

const resolveSelectionViewportFocusLine = (
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

const resolveSingleLineSelectionSummaryText = (
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

const resolveMultiLineSelectionSummaryText = (
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

const resolveSelectionSummary = (): IEditorSelectionSummary | null => {
  const view = editorView;
  const range = view?.state.selection.main;
  if (!view || !range || range.empty) return null;

  const effectiveTo = Math.max(range.from, range.to - 1);
  const startLine = view.state.doc.lineAt(range.from).number;
  const endLine = view.state.doc.lineAt(effectiveTo).number;
  const summaryText =
    startLine === endLine
      ? resolveSingleLineSelectionSummaryText(view, range)
      : resolveMultiLineSelectionSummaryText(view, range, startLine, endLine);
  if (!summaryText.text.trim()) return null;

  return {
    text: withDefaultSelectionTruncation(summaryText),
    startLine,
    endLine,
  };
};

const emitCursorPosition = (view: EditorView): void => {
  const position = view.state.selection.main.head;
  const line = view.state.doc.lineAt(position);
  emit('cursor-position-change', line.number, position - line.from + 1);
};

const emitSelectionSummary = (): void => {
  emit('selection-change', resolveSelectionSummary());
};

// ──────────────────────────────
// View state persist / restore
// ──────────────────────────────
const clearViewStateSaveTimer = (): void => {
  if (viewStateSaveTimerId !== null) {
    window.clearTimeout(viewStateSaveTimerId);
    viewStateSaveTimerId = null;
  }
};

const persistViewState = (path: string | null | undefined): void => {
  const view = editorView;
  if (!view || !path) return;
  editorStore.saveEditorViewState(path, {
    anchor: view.state.selection.main.anchor,
    head: view.state.selection.main.head,
    scrollTop: view.scrollDOM.scrollTop,
    scrollLeft: view.scrollDOM.scrollLeft,
  });
};

const scheduleViewStatePersist = (): void => {
  clearViewStateSaveTimer();
  viewStateSaveTimerId = window.setTimeout(() => {
    viewStateSaveTimerId = null;
    persistViewState(props.documentPath);
  }, VIEW_STATE_SAVE_DEBOUNCE_MS);
};

const readNumberField = (value: Record<string, unknown>, key: string): number | null => {
  const candidate = value[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
};

const restoreViewStateForPath = (path: string | null | undefined): void => {
  const view = editorView;
  if (!view || !path) return;
  const savedState = editorStore.getEditorViewState(path);
  if (!savedState) return;

  const anchor = readNumberField(savedState, 'anchor');
  const head = readNumberField(savedState, 'head') ?? anchor;
  const scrollTop = readNumberField(savedState, 'scrollTop');
  const scrollLeft = readNumberField(savedState, 'scrollLeft');
  const hasSavedScroll = scrollTop !== null || scrollLeft !== null;

  if (anchor !== null) {
    const maxPosition = view.state.doc.length;
    const selection = EditorSelection.single(
      Math.min(Math.max(0, anchor), maxPosition),
      // head 在上面已经 ?? anchor，不需要二次回退
      Math.min(Math.max(0, head as number), maxPosition),
    );
    // 仅在没有已保存滚动位置时，才用 scrollIntoView 兜底把光标滚到可视区中部；
    // 若已有保存的滚动位置，则交由下方精确恢复，避免二者冲突（滚动覆盖光标定位）。
    view.dispatch({
      selection,
      ...(hasSavedScroll
        ? {}
        : { effects: EditorView.scrollIntoView(selection.main.head, { y: 'center' }) }),
    });
  }

  if (hasSavedScroll) {
    requestAnimationFrame(() => {
      if (!editorView) return;
      editorView.scrollDOM.scrollTop = scrollTop ?? editorView.scrollDOM.scrollTop;
      editorView.scrollDOM.scrollLeft = scrollLeft ?? editorView.scrollDOM.scrollLeft;
    });
  }
};

// 单实例复用：切换文档标签页时整体替换文档内容，而非走 modelValue watcher 的
// Myers 差分（新旧文档差异巨大，差分会算出大量碎片区间，不如整体替换）。
// 同时整体替换会清除上一文档的折叠区间(foldEffect 范围因 doc 变化失效)，
// 避免折叠状态残留到新文档。更新 lastSyncedModelValue 哨兵，使紧随其后的
// modelValue watcher 命中回声判定直接跳过，不再重复 dispatch。
const replaceDocumentForPathSwitch = (): void => {
  const view = editorView;
  if (!view) return;
  const nextContent = props.modelValue;
  const currentLength = view.state.doc.length;
  view.dispatch({
    changes: { from: 0, to: currentLength, insert: nextContent },
    selection: EditorSelection.single(0),
    effects: EditorView.scrollIntoView(0, { y: 'start' }),
  });
  lastSyncedModelValue = nextContent;
  lastDocumentMetrics = computeDocumentMetrics(nextContent);
};

// ──────────────────────────────
// Diagnostics
// ──────────────────────────────
const toDiagnosticSeverity = (level: TScriptDiagnosticSeverity): Diagnostic['severity'] => {
  switch (level) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'style':
      return 'hint';
    default:
      return 'info';
  }
};

let shellcheckDiagnostics: Diagnostic[] = [];
let lspDiagnostics: Diagnostic[] = [];

const applyDiagnostics = (): void => {
  const view = editorView;
  if (!view) return;
  // shellcheck / lsp 两个来源各自缓存绝对位置，仅在自身重算时裁剪到当时的文档长度。
  // 当文档变短而另一来源仍是旧缓存时，过期位置会越界，触发 CM6 lint 的
  // doc.lineAt(越界) → RangeError（Invalid position）。下发前统一做最终裁剪兜底。
  const docLength = view.state.doc.length;
  const merged = [...shellcheckDiagnostics, ...lspDiagnostics]
    .map((diagnostic) => {
      const from = Math.min(Math.max(0, diagnostic.from), docLength);
      const to = Math.min(Math.max(from, diagnostic.to), docLength);
      return from === diagnostic.from && to === diagnostic.to
        ? diagnostic
        : { ...diagnostic, from, to };
    })
    .sort((a, b) => a.from - b.from || a.to - b.to);
  view.dispatch(setDiagnostics(view.state, merged));
};

const syncDiagnostics = (): void => {
  const view = editorView;
  if (!view) return;
  shellcheckDiagnostics = analysisState.value.available
    ? analysisState.value.diagnostics.map((item): Diagnostic => {
        const from = lineColumnToOffset(view, item.line, item.column);
        const to = Math.max(from + 1, lineColumnToOffset(view, item.endLine, item.endColumn));
        return {
          from,
          // 越界裁剪统一交给 applyDiagnostics(合并 shellcheck/lsp 后按当时文档长度兜底)，此处不再重复。
          to,
          severity: toDiagnosticSeverity(item.level),
          source: item.code,
          message: `${item.code} · ${item.message}`,
        };
      })
    : [];
  applyDiagnostics();
};

// ──────────────────────────────
// Layout / window resize coordination
// ──────────────────────────────
const layoutEditor = (): void => {
  editorView?.requestMeasure();
};

const scheduleEditorLayout = (): void => {
  if (editorLayoutFrameId !== null) return;
  editorLayoutFrameId = window.requestAnimationFrame(() => {
    editorLayoutFrameId = null;
    layoutEditor();
  });
};

const updatePreviousContainerSize = (): void => {
  if (!containerRef.value) return;
  previousContainerSize = {
    width: Math.round(containerRef.value.clientWidth),
    height: Math.round(containerRef.value.clientHeight),
  };
};

const handleShellWindowResizeStart = (): void => {
  updatePreviousContainerSize();
};

const handleShellWindowResizeSettled = (): void => {
  updatePreviousContainerSize();
  // editorView 为 null 时 layout 是 no-op，因此直接以「是否存在编辑器」决定是否重排。
  if (editorView !== null) scheduleEditorLayout();
};

useShellResizeFrameScheduler({
  onStart: handleShellWindowResizeStart,
  onFrame: scheduleEditorLayout,
  onSettled: handleShellWindowResizeSettled,
  settledFrames: 3,
});

// ──────────────────────────────
// Context menu
// ──────────────────────────────
const closeContextMenu = (): void => {
  contextMenuState.value.open = false;
  contextMenuGroups.value = [];
};

const clampMenuPosition = (clientX: number, clientY: number): { x: number; y: number } => {
  const maxX = Math.max(VIEWPORT_PADDING, window.innerWidth - MENU_WIDTH - VIEWPORT_PADDING);
  const maxY = Math.max(VIEWPORT_PADDING, window.innerHeight - MENU_MAX_HEIGHT - VIEWPORT_PADDING);
  return {
    x: Math.min(Math.max(clientX, VIEWPORT_PADDING), maxX),
    y: Math.min(Math.max(clientY, VIEWPORT_PADDING), maxY),
  };
};

const buildMenuGroups = (): Array<{ key: string; items: IEditorContextMenuItem[] }> => {
  const hasDocument = Boolean(editorView);
  return [
    {
      key: 'run-actions',
      items: [
        {
          key: 'open-terminal',
          label: '打开终端',
          icon: 'terminal',
          action: 'open-terminal',
          disabled: false,
        },
        {
          key: 'run-current-script',
          label: '运行当前脚本',
          icon: 'play',
          action: 'run-current-script',
          disabled: !props.canRun,
        },
      ],
    },
    {
      key: 'history-actions',
      items: [
        { key: 'undo', label: '撤销', icon: 'undo', action: 'undo', disabled: !hasDocument },
        { key: 'redo', label: '恢复撤销', icon: 'redo', action: 'redo', disabled: !hasDocument },
      ],
    },
    {
      key: 'code-actions',
      items: [
        {
          key: 'format-tools',
          label: '格式与注释',
          icon: 'format',
          disabled: !hasDocument,
          children: [
            {
              key: 'format-with-shfmt',
              label: '使用 shfmt 格式化',
              icon: 'format',
              action: 'format-with-shfmt',
              disabled: !hasDocument,
            },
            {
              key: 'toggle-comment-line',
              label: '切换行注释',
              icon: 'comment',
              action: 'toggle-comment-line',
              disabled: !hasDocument,
            },
          ],
        },
        {
          key: 'find-tools',
          label: '查找与跳转',
          icon: 'search',
          disabled: !hasDocument,
          children: [
            { key: 'find', label: '查找', icon: 'search', action: 'find', disabled: !hasDocument },
            {
              key: 'goto-line',
              label: '转到行 / 列',
              icon: 'goto',
              action: 'goto-line',
              disabled: !hasDocument,
            },
          ],
        },
      ],
    },
    {
      key: 'fold-actions',
      items: [
        {
          key: 'fold-all',
          label: '折叠全部',
          icon: 'minus',
          action: 'fold-all',
          disabled: !hasDocument,
        },
        {
          key: 'unfold-all',
          label: '展开全部',
          icon: 'plus',
          action: 'unfold-all',
          disabled: !hasDocument,
        },
      ],
    },
    {
      key: 'edit-actions',
      items: [
        { key: 'cut', label: '剪切', icon: 'cut', action: 'cut', disabled: !hasDocument },
        { key: 'copy', label: '复制', icon: 'copy', action: 'copy', disabled: !hasDocument },
        { key: 'paste', label: '粘贴', icon: 'paste', action: 'paste', disabled: !hasDocument },
      ],
    },
  ];
};

const openContextMenu = (event: MouseEvent): void => {
  if (!editorView) return;
  lastPanelTriggerPoint = { x: event.clientX, y: event.clientY };
  const nextPosition = clampMenuPosition(event.clientX, event.clientY);
  contextMenuGroups.value = buildMenuGroups();
  contextMenuState.value = {
    open: true,
    x: nextPosition.x,
    y: nextPosition.y,
  } as typeof contextMenuState.value & { y: number };
  submenuDirection.value =
    nextPosition.x + MENU_WIDTH + SUBMENU_SAFE_WIDTH + VIEWPORT_PADDING > window.innerWidth
      ? 'left'
      : 'right';
};

const handleContainerContextMenu = (event: MouseEvent): void => {
  editorView?.focus();
  openContextMenu(event);
};

const isTargetInsideMenu = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  (target.closest(MENU_ROOT_SELECTOR) !== null || target.closest(MENU_TRIGGER_SELECTOR) !== null);

const handleWindowPointerDown = (event: PointerEvent): void => {
  if (!contextMenuState.value.open || isTargetInsideMenu(event.target)) return;
  closeContextMenu();
};

const handleWindowKeydown = (event: KeyboardEvent): void => {
  if (contextMenuState.value.open && event.key === 'Escape') closeContextMenu();
};

const closeMenuOnWindowChange = (): void => {
  if (contextMenuState.value.open) closeContextMenu();
};

// ──────────────────────────────
// Clipboard
// ──────────────────────────────
const copyEditorSelection = async (): Promise<void> => {
  const text = resolveSelectedText();
  if (text.trim()) await writeClipboardText(text);
};

const cutEditorSelection = async (): Promise<void> => {
  const view = editorView;
  if (!view) return;
  const ranges = view.state.selection.ranges;
  const selectedText = ranges
    .filter((range) => !range.empty)
    .map((range) => selectionRangeToText(view, range))
    .join('\n');
  if (!selectedText) return;
  await writeClipboardText(selectedText);
  // 写剪贴板会让出事件循环，await 之前捕获的 ranges 可能已过期(文档被改)；用过期偏移删除
  // 会误删甚至越界。改用「当前」选区删除(replaceSelection 支持多选区)；写剪贴板若失败会在
  // 此之前抛出、不会执行删除，避免静默丢数据。
  const liveView = editorView;
  if (!liveView) return;
  liveView.dispatch(liveView.state.replaceSelection(''));
};

const pasteIntoEditor = async (): Promise<void> => {
  const view = editorView;
  if (!view) return;
  const clipboardText = await tryReadClipboardText();
  if (clipboardText === null) return;
  view.dispatch(view.state.replaceSelection(clipboardText));
  view.focus();
};

// ──────────────────────────────
// Context menu item dispatch
// ──────────────────────────────
const handleContextMenuItemSelect = async (item: IEditorContextMenuItem): Promise<void> => {
  const view = editorView;
  closeContextMenu();
  if (!view || !item.action) return;
  view.focus();
  switch (item.action) {
    case 'undo':
      undo(view);
      return;
    case 'redo':
      redo(view);
      return;
    case 'format-with-shfmt':
      emit('format-request');
      return;
    case 'toggle-comment-line':
      toggleLineComment(view);
      return;
    case 'find':
      openSearchPanel(view);
      return;
    case 'goto-line':
      openGotoLinePanel(view);
      return;
    case 'fold-all':
      foldAll(view);
      return;
    case 'unfold-all':
      unfoldAll(view);
      return;
    case 'quick-command':
      emit('command-palette-request');
      return;
    case 'run-current-script':
      emit('run-request');
      return;
    case 'open-terminal':
      emit('open-terminal-request');
      return;
    case 'cut':
      await cutEditorSelection();
      return;
    case 'copy':
      await copyEditorSelection();
      return;
    case 'paste':
      await pasteIntoEditor();
      return;
    default:
      return;
  }
};

// ──────────────────────────────
// Editor lifecycle
// ──────────────────────────────
const flushModelValueEmit = (): void => {
  pendingModelValueEmit = false;
  const view = editorView;
  if (!view) return;
  // 读取「当前」文档,合并后只对外同步最终内容;始终是真实文档串,不会损坏内容。
  const value = view.state.doc.toString();
  // 记录本次对外同步的串,作为 v-model 回声的廉价判定依据(见 modelValue watcher)。
  lastSyncedModelValue = value;
  emit('update:modelValue', value, pendingModelValueMetrics ?? lastDocumentMetrics);
};

const handleEditorUpdate = (update: ViewUpdate): void => {
  if (update.docChanged && !suppressModelValueEmit) {
    closeContextMenu();
    // metrics 内部状态依赖逐次变更,不能跳过,故每次变更都增量维护。
    pendingModelValueMetrics = applyDocumentMetricsFromChanges(update);
    // 把整篇 toString() 与 emit 合并到本 tick 末尾执行一次,避免同一 tick 内多次变更
    // (IME 组合 / 批量 dispatch)重复全文 emit。
    if (!pendingModelValueEmit) {
      pendingModelValueEmit = true;
      queueMicrotask(flushModelValueEmit);
    }
  }
  if (update.selectionSet || update.docChanged) {
    emitCursorPosition(update.view);
    emitSelectionSummary();
    scheduleViewStatePersist();
    inlineCompletionController.handleUpdate(update);
  }
  if (update.viewportChanged) {
    closeContextMenu();
    scheduleViewStatePersist();
  }
};

/** 构建 LSP extension（仅对 shell 文件启用） */
let currentLsp: ReturnType<typeof createLspExtension> | null = null;

const buildLspExtension = (): Extension => {
  currentLsp?.detach();
  currentLsp = null;
  lspDiagnostics = [];
  applyDiagnostics();

  const lang = getCurrentLanguage();
  if (lang !== 'shell' || !props.documentPath) return [];

  currentLsp = createLspExtension({
    filePath: props.documentPath,
    languageId: 'shellscript',
    getContent: () => props.modelValue,
    onDiagnostics: (diags) => {
      lspDiagnostics = diags;
      applyDiagnostics();
    },
  });

  return currentLsp.extensions;
};

// 编辑器底部预留约 15 行空白：不使用 scrollPastEnd()（它会预留近一屏空白，可把最后一行顶到屏幕最上沿），
// 固定高度更贴近常规编辑器手感。CM6 默认行高约为字号的 1.6 倍，故 24em ≈ 15 行。
const editorBottomPaddingTheme = EditorView.theme({
  '.cm-content': { paddingBottom: '24em' },
});

// drawSelection 提供可控制宽度的“自绘光标”（浏览器原生光标宽度无法用 CSS 修改），
// 因此重新启用它来让光标加粗生效；但隐藏它绘制的整块选区，改回浏览器原生选区，
// 保持行尾不刷蓝、多行/全选呈参差右边缘（与 VS Code 一致）的既有观感。
const nativeSelectionWithDrawnCursorTheme = Prec.highest(
  EditorView.theme({
    // 隐藏 drawSelection 的选区矩形层（仅保留其光标层 .cm-cursorLayer）。
    '.cm-selectionLayer': { display: 'none' },
    // 覆盖 drawSelection 注入的 “::selection 透明 !important”，恢复原生选区高亮。
    '.cm-content .cm-line::selection, .cm-content .cm-line ::selection': {
      backgroundColor: '#add6ff80 !important',
    },
  }),
);

// ──────────────────────────────
// Floating search popup (custom search panel)
// 自定义浮动查找弹窗:替代 CM 内置 search 面板。恒浅色、图标化、可拖拽,
// 出现位置智能匹配右键触发点(无触发点时回退到光标 / 编辑器顶部)。
// ──────────────────────────────
const SEARCH_POPUP_MARGIN = 12;
const SEARCH_POPUP_WIDTH = 272;
const SEARCH_POPUP_ESTIMATED_HEIGHT = 48;

const SEARCH_ICON_FIND =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';
const SEARCH_ICON_PREV =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>';
const SEARCH_ICON_NEXT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
const SEARCH_ICON_CLOSE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

const countSearchMatches = (
  view: EditorView,
  query: SearchQuery,
): { total: number; current: number } => {
  if (!query.valid) return { total: 0, current: 0 };
  const main = view.state.selection.main;
  let total = 0;
  let current = 0;
  const cursor = query.getCursor(view.state);
  while (!cursor.next().done) {
    total += 1;
    if (cursor.value.from === main.from && cursor.value.to === main.to) current = total;
  }
  return { total, current };
};

const createSearchPanel = (view: EditorView): Panel => {
  const dom = document.createElement('div');
  dom.className = 'cm-floating-search';
  dom.setAttribute('role', 'search');

  const grip = document.createElement('span');
  grip.className = 'cm-floating-search__grip';
  grip.setAttribute('aria-hidden', 'true');
  grip.innerHTML = SEARCH_ICON_FIND;

  const input = document.createElement('input');
  input.className = 'cm-floating-search__input';
  input.type = 'text';
  input.placeholder = '查找';
  input.setAttribute('aria-label', '查找');
  input.spellcheck = false;

  const count = document.createElement('span');
  count.className = 'cm-floating-search__count';

  const createIconButton = (label: string, icon: string): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-floating-search__btn';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = icon;
    return button;
  };

  const prevButton = createIconButton('上一个', SEARCH_ICON_PREV);
  const nextButton = createIconButton('下一个', SEARCH_ICON_NEXT);
  const closeButton = createIconButton('关闭', SEARCH_ICON_CLOSE);
  closeButton.classList.add('cm-floating-search__btn--close');

  dom.append(grip, input, count, prevButton, nextButton, closeButton);

  const refreshCount = (): void => {
    const query = getSearchQuery(view.state);
    if (!query.search) {
      count.textContent = '';
      return;
    }
    const { total, current } = countSearchMatches(view, query);
    count.textContent = total === 0 ? '无结果' : `${current || '–'}/${total}`;
  };

  const runQuery = (value: string): void => {
    const previous = getSearchQuery(view.state);
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: value,
          caseSensitive: previous.caseSensitive,
          regexp: previous.regexp,
          wholeWord: previous.wholeWord,
          literal: previous.literal,
        }),
      ),
    });
    refreshCount();
  };

  input.addEventListener('input', () => runQuery(input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) findPrevious(view);
      else findNext(view);
      refreshCount();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeSearchPanel(view);
    }
  });
  prevButton.addEventListener('click', () => {
    findPrevious(view);
    refreshCount();
    input.focus();
  });
  nextButton.addEventListener('click', () => {
    findNext(view);
    refreshCount();
    input.focus();
  });
  closeButton.addEventListener('click', () => closeSearchPanel(view));

  // 把视口坐标换算到弹窗定位坐标系,兼容存在 transform 的祖先容器。
  const positionAt = (clientX: number, clientY: number): void => {
    const width = dom.offsetWidth || SEARCH_POPUP_WIDTH;
    const height = dom.offsetHeight || SEARCH_POPUP_ESTIMATED_HEIGHT;
    // 严格夹在编辑器盒子(.cm-editor)内,任意方向都不许越界
    const bounds = view.dom.getBoundingClientRect();
    const minX = bounds.left + SEARCH_POPUP_MARGIN;
    const maxX = bounds.right - width - SEARCH_POPUP_MARGIN;
    const minY = bounds.top + SEARCH_POPUP_MARGIN;
    const maxY = bounds.bottom - height - SEARCH_POPUP_MARGIN;
    const x = maxX < minX ? minX : Math.min(Math.max(minX, clientX), maxX);
    const y = maxY < minY ? minY : Math.min(Math.max(minY, clientY), maxY);
    dom.style.left = `${x}px`;
    dom.style.top = `${y}px`;
    const rect = dom.getBoundingClientRect();
    dom.style.left = `${x + (x - rect.left)}px`;
    dom.style.top = `${y + (y - rect.top)}px`;
  };

  let dragPointerId: number | null = null;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  const onDragMove = (event: PointerEvent): void => {
    if (dragPointerId === null) return;
    positionAt(event.clientX - dragOffsetX, event.clientY - dragOffsetY);
  };
  const onDragEnd = (): void => {
    if (dragPointerId === null) return;
    dragPointerId = null;
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
  };
  grip.addEventListener('pointerdown', (event) => {
    dragPointerId = event.pointerId;
    const rect = dom.getBoundingClientRect();
    dragOffsetX = event.clientX - rect.left;
    dragOffsetY = event.clientY - rect.top;
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
    event.preventDefault();
  });

  return {
    dom,
    top: true,
    mount() {
      const query = getSearchQuery(view.state);
      if (query.search) input.value = query.search;
      const trigger = lastPanelTriggerPoint;
      lastPanelTriggerPoint = null;
      if (trigger) {
        positionAt(trigger.x, trigger.y);
      } else {
        const caret = view.coordsAtPos(view.state.selection.main.head);
        if (caret) {
          positionAt(caret.left, caret.bottom + 8);
        } else {
          const editorRect = view.dom.getBoundingClientRect();
          positionAt(editorRect.left + 24, editorRect.top + 16);
        }
      }
      refreshCount();
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    },
    update(update: ViewUpdate) {
      const queryChanged = update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(setSearchQuery)),
      );
      if (!update.docChanged && !update.selectionSet && !queryChanged) return;
      if (document.activeElement !== input) {
        const query = getSearchQuery(view.state);
        if (query.search !== input.value) input.value = query.search;
      }
      refreshCount();
    },
    destroy() {
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', onDragEnd);
    },
  };
};

// ──────────────────────────────
// Floating goto-line popup (custom panel)
// CM 内置 gotoLine 不支持 createPanel,改用 showPanel + Compartment 动态挂载自绘面板。
// 与查找弹窗同款:恒浅色、图标化、可拖拽、智能定位。行、列分两个输入框。
// ──────────────────────────────
const GOTO_ICON_TARGET =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3v3"/><path d="M12 18v3"/><path d="M3 12h3"/><path d="M18 12h3"/></svg>';
const GOTO_ICON_GO =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>';

const createGotoLinePanel = (view: EditorView): Panel => {
  const dom = document.createElement('div');
  dom.className = 'cm-floating-search cm-floating-search--goto';
  dom.setAttribute('role', 'dialog');

  const grip = document.createElement('span');
  grip.className = 'cm-floating-search__grip';
  grip.setAttribute('aria-hidden', 'true');
  grip.innerHTML = GOTO_ICON_TARGET;

  const lineInput = document.createElement('input');
  lineInput.className = 'cm-floating-search__input cm-floating-search__input--num';
  lineInput.type = 'text';
  lineInput.inputMode = 'numeric';
  lineInput.placeholder = '行';
  lineInput.setAttribute('aria-label', '行号');
  lineInput.spellcheck = false;

  const separator = document.createElement('span');
  separator.className = 'cm-floating-search__sep';
  separator.setAttribute('aria-hidden', 'true');
  separator.textContent = ':';

  const columnInput = document.createElement('input');
  columnInput.className = 'cm-floating-search__input cm-floating-search__input--num';
  columnInput.type = 'text';
  columnInput.inputMode = 'numeric';
  columnInput.placeholder = '列';
  columnInput.setAttribute('aria-label', '列号(可选)');
  columnInput.spellcheck = false;

  const goButton = document.createElement('button');
  goButton.type = 'button';
  goButton.className = 'cm-floating-search__btn';
  goButton.title = '转到';
  goButton.setAttribute('aria-label', '转到');
  goButton.innerHTML = GOTO_ICON_GO;

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'cm-floating-search__btn cm-floating-search__btn--close';
  closeButton.title = '关闭';
  closeButton.setAttribute('aria-label', '关闭');
  closeButton.innerHTML = SEARCH_ICON_CLOSE;

  dom.append(grip, lineInput, separator, columnInput, goButton, closeButton);

  const submit = (): void => {
    const lineRaw = lineInput.value.trim();
    if (!lineRaw) return;
    const line = Number.parseInt(lineRaw, 10);
    if (!Number.isFinite(line) || line <= 0) return;
    const columnRaw = columnInput.value.trim();
    const parsedColumn = Number.parseInt(columnRaw, 10);
    const column = columnRaw && Number.isFinite(parsedColumn) ? Math.max(1, parsedColumn) : 1;
    const lineInfo = view.state.doc.line(Math.min(line, view.state.doc.lines));
    const position = Math.min(lineInfo.to, lineInfo.from + (column - 1));
    view.dispatch({
      selection: EditorSelection.cursor(position),
      effects: EditorView.scrollIntoView(position, { y: 'center' }),
    });
    closeGotoLinePanel(view);
    view.focus();
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeGotoLinePanel(view);
      view.focus();
    }
  };
  lineInput.addEventListener('keydown', onKeydown);
  columnInput.addEventListener('keydown', onKeydown);
  goButton.addEventListener('click', submit);
  closeButton.addEventListener('click', () => {
    closeGotoLinePanel(view);
    view.focus();
  });

  const positionAt = (clientX: number, clientY: number): void => {
    const width = dom.offsetWidth || SEARCH_POPUP_WIDTH;
    const height = dom.offsetHeight || SEARCH_POPUP_ESTIMATED_HEIGHT;
    // 严格夹在编辑器盒子(.cm-editor)内,任意方向都不许越界
    const bounds = view.dom.getBoundingClientRect();
    const minX = bounds.left + SEARCH_POPUP_MARGIN;
    const maxX = bounds.right - width - SEARCH_POPUP_MARGIN;
    const minY = bounds.top + SEARCH_POPUP_MARGIN;
    const maxY = bounds.bottom - height - SEARCH_POPUP_MARGIN;
    const x = maxX < minX ? minX : Math.min(Math.max(minX, clientX), maxX);
    const y = maxY < minY ? minY : Math.min(Math.max(minY, clientY), maxY);
    dom.style.left = `${x}px`;
    dom.style.top = `${y}px`;
    const rect = dom.getBoundingClientRect();
    dom.style.left = `${x + (x - rect.left)}px`;
    dom.style.top = `${y + (y - rect.top)}px`;
  };

  let dragPointerId: number | null = null;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  const onDragMove = (event: PointerEvent): void => {
    if (dragPointerId === null) return;
    positionAt(event.clientX - dragOffsetX, event.clientY - dragOffsetY);
  };
  const onDragEnd = (): void => {
    if (dragPointerId === null) return;
    dragPointerId = null;
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
  };
  grip.addEventListener('pointerdown', (event) => {
    dragPointerId = event.pointerId;
    const rect = dom.getBoundingClientRect();
    dragOffsetX = event.clientX - rect.left;
    dragOffsetY = event.clientY - rect.top;
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
    event.preventDefault();
  });

  return {
    dom,
    top: true,
    mount() {
      const trigger = lastPanelTriggerPoint;
      lastPanelTriggerPoint = null;
      if (trigger) {
        positionAt(trigger.x, trigger.y);
      } else {
        const caret = view.coordsAtPos(view.state.selection.main.head);
        if (caret) {
          positionAt(caret.left, caret.bottom + 8);
        } else {
          const editorRect = view.dom.getBoundingClientRect();
          positionAt(editorRect.left + 24, editorRect.top + 16);
        }
      }
      requestAnimationFrame(() => {
        lineInput.focus();
        lineInput.select();
      });
    },
    destroy() {
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', onDragEnd);
    },
  };
};

const closeGotoLinePanel = (view: EditorView): void => {
  view.dispatch({ effects: gotoLinePanelCompartment.reconfigure([]) });
};

const openGotoLinePanel = (view: EditorView): void => {
  view.dispatch({
    effects: gotoLinePanelCompartment.reconfigure(showPanel.of(createGotoLinePanel)),
  });
};

const createBaseExtensions = (language: string): Extension[] => [
  lspCompletionTheme,
  highlightSpecialChars(),
  shikiHighlightExtension(language),
  history(),
  dropCursor(),
  drawSelection(),
  nativeSelectionWithDrawnCursorTheme,
  indentOnInput(),
  bracketMatching(),
  structuralSelectionHistoryField,
  rectangularSelection(),
  crosshairCursor(),
  highlightSelectionMatches(),
  search({ top: true, createPanel: createSearchPanel }),
  gotoLinePanelCompartment.of([]),
  lintGutter(),
  editorBottomPaddingTheme,
  ...inlineCompletionController.extensions,
  keymap.of([
    indentWithTab,
    {
      key: 'Alt-Shift-f',
      run: () => {
        emit('format-request');
        return true;
      },
    },
    {
      key: 'Mod-Enter',
      run: () => {
        emit('run-request');
        return true;
      },
    },
    { key: 'Ctrl-Space', run: acceptCompletion },
    // 结构化选区(扩大/缩小)由 codemirror-structural-selection 统一实现:
    // 同时从 defaultKeymap 过滤掉内置的 selectParentSyntax(原 Mod-i),避免与本地扩选命令双重绑定。
    { key: 'Mod-i', run: expandStructuralSelection, preventDefault: true },
    { key: 'Shift-Mod-i', run: shrinkStructuralSelection, preventDefault: true },
    ...defaultKeymap.filter((binding) => binding.run !== selectParentSyntax),
    ...historyKeymap,
    {
      key: 'Mod-Alt-g',
      run: (view) => {
        openGotoLinePanel(view);
        return true;
      },
    },
    ...searchKeymap,
    ...foldKeymap,
  ]),
  lspCompartment.of(buildLspExtension()),
  languageCompartment.of(resolveCodeMirrorLanguageExtension(language)),
  settingsCompartment.of(buildCodeMirrorSettingsExtensions(props.editorSettings)),
  completionCompartment.of(
    buildCompletionExtension(props.editorSettings, language, currentLsp?.completionSource),
  ),
  EditorView.updateListener.of(handleEditorUpdate),
  shikiEditorChromeTheme,
];

const createEditor = (): void => {
  if (!containerRef.value || editorView) return;
  const language = getCurrentLanguage();
  editorView = new EditorView({
    parent: containerRef.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: createBaseExtensions(language),
    }),
  });
  // 初始文档串与父组件 v-model 已对齐,记录为同步基线,避免首个 echo 误判。
  lastSyncedModelValue = props.modelValue;
  lastDocumentMetrics = computeDocumentMetrics(props.modelValue);
  emitCursorPosition(editorView);
  applyLanguageExtension(language);
  currentLsp?.attach(editorView);
  syncDiagnostics();
  restoreViewStateForPath(props.documentPath);
  requestAnimationFrame(() => scheduleEditorLayout());
};

const reconfigureLsp = (): void => {
  const view = editorView;
  if (!view) return;
  view.dispatch({
    effects: [
      lspCompartment.reconfigure(buildLspExtension()),
      completionCompartment.reconfigure(
        buildCompletionExtension(
          props.editorSettings,
          getCurrentLanguage(),
          currentLsp?.completionSource,
        ),
      ),
    ],
  });
  // 文件切换后重新 attach（didOpen 新文件，didClose 旧文件已在 buildLspExtension 中处理）
  if (currentLsp) {
    currentLsp.attach(view);
  }
};

// 语言语法按需加载：先用已缓存（或空）占位，加载完成后再 reconfigure 进编辑器，
// 避免把全部语法打进初始 bundle。
const applyLanguageExtension = (language: string): void => {
  void loadCodeMirrorLanguageSupport(language).then((support) => {
    const view = editorView;
    // 加载期间文档可能已切换语言，过期结果直接丢弃。
    if (!view || getCurrentLanguage() !== language) return;
    view.dispatch({ effects: languageCompartment.reconfigure(support ?? []) });
  });
};

const reconfigureLanguage = (): void => {
  const view = editorView;
  if (!view) return;
  const language = getCurrentLanguage();
  inlineCompletionController.clear();
  // 不在此处 reconfigure 补全：紧随其后调用的 reconfigureLsp 会用「新」LSP 的 completionSource
  // 统一重配补全。这里若先配一次，用的还是旧文件的 LSP 源，纯属多余 dispatch。
  view.dispatch({
    effects: [
      languageCompartment.reconfigure(resolveCodeMirrorLanguageExtension(language)),
      setShikiLanguage(language),
    ],
  });
  applyLanguageExtension(language);
};

const reconfigureSettings = (): void => {
  const view = editorView;
  if (!view) return;
  view.dispatch({
    effects: [
      settingsCompartment.reconfigure(buildCodeMirrorSettingsExtensions(props.editorSettings)),
      completionCompartment.reconfigure(
        buildCompletionExtension(
          props.editorSettings,
          getCurrentLanguage(),
          currentLsp?.completionSource,
        ),
      ),
    ],
  });
  scheduleEditorLayout();
};

// ──────────────────────────────
// Watchers
// ──────────────────────────────
watch(
  () => [props.documentPath, props.documentName] as const,
  ([nextPath], [previousPath]) => {
    if (previousPath) persistViewState(previousPath);
    replaceDocumentForPathSwitch();
    reconfigureLanguage();
    reconfigureLsp();
    restoreViewStateForPath(nextPath);
  },
  { flush: 'sync' },
);

watch(
  () => props.modelValue,
  (value) => {
    const view = editorView;
    if (!view) return;
    // 自身 emit 的 v-model 回声:用上次同步串做廉价比较,命中即跳过,不再每次按键
    // 对整篇文档 toString()。
    if (value === lastSyncedModelValue) return;
    const current = view.state.doc.toString();
    if (current === value) {
      lastSyncedModelValue = value;
      lastDocumentMetrics = computeDocumentMetrics(value);
      return;
    }
    // 外部真正改了内容（载入文件 / 格式化 / AI 补丁等）：只替换最小变化区间,保留未变
    // 区域的折叠/选区,避免整篇替换清空这些状态。Myers 最短编辑脚本可产出多个
    // 互不相邻的最小变更区间，详见 utils/editor/editor-doc-diff。
    lastSyncedModelValue = value;
    lastDocumentMetrics = computeDocumentMetrics(value);
    suppressModelValueEmit = true;
    try {
      view.dispatch({ changes: computeDocChanges(current, value) });
    } finally {
      suppressModelValueEmit = false;
    }
  },
);

watch(analysisDiagnosticsSignature, () => syncDiagnostics());

// app store 的 patchSettings/replaceSettings 每次都整体替换 settings 引用,
// editor 子对象随之成为新引用,故浅 watch 即可捕获所有偏好改动,无需 deep 遍历。
watch(
  () => props.editorSettings,
  () => reconfigureSettings(),
);

// ──────────────────────────────
// Mount / unmount
// ──────────────────────────────
useEventListener(window, 'pointerdown', handleWindowPointerDown, { capture: true });
useEventListener(window, 'keydown', handleWindowKeydown);
useEventListener(window, 'resize', closeMenuOnWindowChange);
useEventListener(window, 'blur', closeMenuOnWindowChange);

onMounted(() => {
  createEditor();

  useResizeObserver(containerRef, () => {
    if (!containerRef.value) return;
    const nextWidth = Math.round(containerRef.value.clientWidth);
    const nextHeight = Math.round(containerRef.value.clientHeight);
    if (previousContainerSize.width === nextWidth && previousContainerSize.height === nextHeight)
      return;
    previousContainerSize = { width: nextWidth, height: nextHeight };
    scheduleEditorLayout();
  });
});

onBeforeUnmount(() => {
  // 卸载前先冲刷待发送的 v-model,避免丢失最后一次合并中的文档变更。
  if (pendingModelValueEmit) {
    flushModelValueEmit();
  }
  persistViewState(props.documentPath);
  clearViewStateSaveTimer();
  inlineCompletionController.destroy();
  currentLsp?.detach();
  if (editorLayoutFrameId !== null) {
    window.cancelAnimationFrame(editorLayoutFrameId);
    editorLayoutFrameId = null;
  }
  closeContextMenu();
  editorView?.destroy();
  editorView = null;
});

// ──────────────────────────────
// Public methods
// ──────────────────────────────
const focusEditor = (): void => {
  editorView?.focus();
};

const insertSnippet = (snippetText: string): void => {
  const view = editorView;
  if (!view) return;
  const range = view.state.selection.main;
  snippet(snippetText)(view, null, range.from, range.to);
  view.focus();
};

const revealPosition = (line: number, column: number): void => {
  const view = editorView;
  if (!view) return;
  const position = lineColumnToOffset(view, line, column);
  view.dispatch({
    selection: EditorSelection.cursor(position),
    effects: EditorView.scrollIntoView(position, { y: 'center' }),
  });
  view.focus();
};

defineExpose<IEditorExpose>({
  focusEditor,
  insertSnippet,
  revealPosition,
  layoutEditor,
});
</script>

<style scoped>
.codemirror-editor-surface :deep(.cm-editor) {
  height: 100%;
  min-height: 0;
}

.codemirror-editor-surface :deep(.cm-content) {
  min-height: 100%;
}

.codemirror-editor-surface :deep(.cm-scroller) {
  overflow: auto;
}
</style>

<style>
/* CM6 补全 / hover 全局样式(非 scoped — 弹窗在 body，不在组件 DOM 内)
   编辑器整体刻意恒为 github-light(见 shikiEditorChromeTheme)，弹窗同样恒为浅色，
   与应用深浅主题无关。重复的卡片表面/描边/阴影集中为变量，便于统一维护。 */
.cm-tooltip-autocomplete,
.cm-tooltip-hover,
.cm-completionInfo {
  --cm-popup-surface: #ffffff;
  --cm-popup-border: #e6e8eb;
  --cm-popup-shadow: 0 10px 30px rgba(15, 23, 42, 0.12);
}

/* 弹窗：纯白卡片 */
.cm-tooltip.cm-tooltip.cm-tooltip-autocomplete {
  background: var(--cm-popup-surface);
  border: 1px solid var(--cm-popup-border);
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12), 0 0 0 0.5px rgba(15, 23, 42, 0.04);
  padding: 4px;
}

.cm-tooltip.cm-tooltip.cm-tooltip-autocomplete>ul {
  background: var(--cm-popup-surface);
}

.cm-tooltip.cm-tooltip-hover,
.cm-tooltip-autocomplete {
  max-width: none;
}

/* 隐藏补全弹窗滚动条(仍可滚动) */
.cm-tooltip-autocomplete>ul,
.cm-tooltip-autocomplete .cm-completionInfo {
  scrollbar-width: none;
  /* Firefox */
  -ms-overflow-style: none;
  /* 旧 Edge */
}

.cm-tooltip-autocomplete>ul::-webkit-scrollbar,
.cm-tooltip-autocomplete .cm-completionInfo::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
  /* Chromium / Tauri */
}

/* 选中行圆角：与外框同心(外 12 − 内边距 4 = 8) */
.cm-tooltip.cm-tooltip.cm-tooltip-autocomplete>ul>li[aria-selected] {
  border-radius: 8px;
}

/* 列表项 */
.cm-tooltip-autocomplete>ul {
  max-height: 320px;
  font-family: var(--font-mono);
}

.cm-tooltip-autocomplete>ul>li {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
  padding: 4px 10px;
  border-radius: 8px;
  color: #1f2937;
}

.cm-tooltip-autocomplete>ul>li[aria-selected] {
  background: #f1f5f9;
  color: #111827;
}

/* Lucide 图标(addToOptions 注入，类名 cm-lsp-icon) */
.cm-lsp-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  color: #98a2b3;
}

.cm-lsp-icon svg {
  width: 16px;
  height: 16px;
}

.cm-lsp-icon[data-type="function"],
.cm-lsp-icon[data-type="method"] {
  color: #8b5cf6;
}

.cm-lsp-icon[data-type="keyword"] {
  color: #e0457b;
}

.cm-lsp-icon[data-type="variable"],
.cm-lsp-icon[data-type="field"] {
  color: #2f80ed;
}

.cm-lsp-icon[data-type="property"] {
  color: #0ea5b7;
}

.cm-lsp-icon[data-type="constant"],
.cm-lsp-icon[data-type="value"],
.cm-lsp-icon[data-type="enum"] {
  color: #0f9d58;
}

.cm-lsp-icon[data-type="class"],
.cm-lsp-icon[data-type="interface"],
.cm-lsp-icon[data-type="namespace"] {
  color: #d97706;
}

.cm-lsp-icon[data-type="snippet"] {
  color: #f59e0b;
}

.cm-lsp-icon[data-type="operator"] {
  color: #6366f1;
}

.cm-lsp-icon[data-type="text"] {
  color: #98a2b3;
}

/* 文字 */
.cm-tooltip-autocomplete .cm-completionLabel {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cm-tooltip-autocomplete .cm-completionDetail {
  flex-shrink: 0;
  margin-left: auto;
  padding-left: 12px;
  font-size: 11px;
  font-style: normal;
  color: #98a2b3;
}

.cm-tooltip-autocomplete .cm-completionMatchedText {
  color: #4f46e5;
  font-weight: 600;
  text-decoration: none;
}

/* 详情 / 文档面板：同样纯白 */
.cm-tooltip.cm-completionInfo,
.cm-tooltip-autocomplete .cm-completionInfo {
  margin-left: 6px;
  padding: 10px 12px;
  max-width: none;
  background: var(--cm-popup-surface);
  border: 1px solid var(--cm-popup-border);
  border-radius: 10px;
  box-shadow: var(--cm-popup-shadow);
  color: #475467;
}

/* 滚动条 */
.cm-tooltip-autocomplete>ul::-webkit-scrollbar {
  width: 8px;
}

.cm-tooltip-autocomplete>ul::-webkit-scrollbar-thumb {
  background: #d0d5dd;
  border-radius: 8px;
}

/* hover 卡片 */
.cm-tooltip.cm-tooltip-hover {
  background: var(--cm-popup-surface);
  border: 1px solid var(--cm-popup-border);
  border-radius: 10px;
  box-shadow: var(--cm-popup-shadow);
}

.cm-lsp-hover {
  padding: 8px 10px;
  font-size: 12.5px;
  line-height: 1.55;
  color: #1f2937;
}

/* LSP 文档 markdown */
.cm-lsp-doc {
  font-size: 12px;
  line-height: 1.55;
  color: #475467;
}

.cm-lsp-para {
  margin: 4px 0;
}

.cm-lsp-inline-code {
  background: #f2f4f7;
  border-radius: 3px;
  padding: 1px 5px;
  font-family: var(--font-mono);
  font-size: 0.92em;
}

.cm-lsp-code-block {
  margin: 6px 0;
  border-radius: 6px;
  overflow: hidden;
}

.cm-lsp-code-block pre {
  margin: 0;
  padding: 8px 10px;
  background: #f7f8fa;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.45;
}

/* 浮动查找弹窗:恒为浅色,沿用补全/hover 卡片同一套表面/描边/阴影语言 */
.cm-panels.cm-panels-top:has(.cm-floating-search) {
  border-bottom: none;
  background: transparent;
}

.cm-floating-search {
  position: fixed;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 4px;
  width: 272px;
  max-width: calc(100vw - 24px);
  padding: 5px 6px 5px 10px;
  background: #ffffff;
  border: none;
  border-radius: 12px;
  box-shadow:
    0 0 0 1px #e7e6e4,
    0 0 0 2px #efefee,
    0 0 0 3px #f7f7f7,
    0 0 0 4px #f8f8f8,
    0 0 0 5px #f9f9f9,
    0 0 0 6px #fafafa,
    0 0 0 7px #fbfbfb,
    0 0 0 8px #fcfcfc,
    0 0 0 9px #fdfdfd,
    0 0 0 10px #fefefe;
  font-family: var(--font-mono);
  color: #1f2937;
}

.cm-floating-search__grip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  color: #98a2b3;
  cursor: grab;
  touch-action: none;
}

.cm-floating-search__grip:active {
  cursor: grabbing;
}

.cm-floating-search__grip svg {
  width: 13px;
  height: 13px;
}

.cm-floating-search__input {
  flex: 1 1 auto;
  min-width: 0;
  height: 26px;
  padding: 0 6px;
  border: none;
  outline: none;
  background: transparent;
  font-family: inherit;
  font-size: 13px;
  color: #111827;
}

.cm-floating-search__input::placeholder {
  color: #98a2b3;
}

.cm-floating-search__count {
  flex-shrink: 0;
  min-width: 34px;
  padding: 0 4px;
  text-align: right;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: #98a2b3;
}

.cm-floating-search__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #475467;
  cursor: pointer;
  transition: background-color 0.12s ease, color 0.12s ease;
}

.cm-floating-search__btn:hover {
  background: #f1f5f9;
  color: #111827;
}

.cm-floating-search__btn:active {
  background: #e7ebf0;
}

.cm-floating-search__btn svg {
  width: 14px;
  height: 14px;
}

.cm-floating-search__btn--close {
  color: #98a2b3;
}

.cm-floating-search__btn--close:hover {
  background: #fde8e8;
  color: #d92d20;
}


.cm-floating-search--goto {
  width: auto;
}
.cm-floating-search__input--num {
  width: 56px;
  flex: 0 0 auto;
  text-align: center;
}
.cm-floating-search__sep {
  color: #9aa0a6;
  font-size: 13px;
  line-height: 1;
  user-select: none;
}

</style>
