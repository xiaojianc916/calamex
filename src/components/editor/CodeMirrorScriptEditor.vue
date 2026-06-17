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
  toggleLineComment,
  undo,
} from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { type Diagnostic, lintGutter, setDiagnostics } from '@codemirror/lint';
import {
  gotoLine,
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
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
  rectangularSelection,
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
// `import('@/utils/terminal/shell-completion')` 自身会被打包器缓存，但每次 completion 都
// 重新 `.then(...)` 并重新 `createShellCodeMirrorCompletionSource()` 仍有不必要的
// 微开销，且每次都拿到一个新的 source 实例，影响内部可能的状态复用。
let cachedShellCompletionSourcePromise: Promise<CompletionSource> | null = null;
const getShellCompletionSource = (): Promise<CompletionSource> => {
  if (!cachedShellCompletionSourcePromise) {
    cachedShellCompletionSourcePromise = import('@/utils/terminal/shell-completion').then((mod) =>
      mod.createShellCodeMirrorCompletionSource(),
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
// emit:每次变更仍增量维护 metrics,但整篇 toString() 与 emit 推迟到 tick 末尾的微任务执行
// 一次。注意:单次按键的整篇 toString() 是 v-model「全文字符串」契约的固有成本,此处只消除
// 同一 tick 内的重复全文 emit,不改变单次按键语义;flush 始终读取当前文档,emit 的内容恒为
// 真实文档串,不会损坏内容。
let pendingModelValueEmit = false;
let pendingModelValueMetrics: IDocumentMetrics | null = null;
let previousContainerSize = { width: 0, height: 0 };

const languageCompartment = new Compartment();
const settingsCompartment = new Compartment();
const completionCompartment = new Compartment();
const lspCompartment = new Compartment();

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
      gotoLine(view);
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

// 编辑器底部预留约 5 行空白：替代 scrollPastEnd()（其会预留近一屏空白、
// 可把最后一行滚到顶部）。改为固定 5 行更贴近常规编辑器手感。
// CM6 默认行高约为字号的 1.6 倍，故 15 行 = 24em。
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
  rectangularSelection(),
  crosshairCursor(),
  highlightSelectionMatches(),
  search({ top: true }),
  lint