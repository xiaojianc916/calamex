<template>
  <div data-shell-resize-responder class="shell-editor-surface codemirror-editor-surface relative h-full min-h-0 w-full bg-(--editor-bg)">
    <div ref="containerRef" class="h-full min-h-0 w-full bg-(--editor-bg)"></div>
  </div>
</template>

<script setup lang="ts">
import type { CompletionSource } from '@codemirror/autocomplete';
import { acceptCompletion, autocompletion, completeAnyWord, snippet } from '@codemirror/autocomplete';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleLineComment,
} from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { type Diagnostic, lintGutter, setDiagnostics } from '@codemirror/lint';
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, type Extension, Prec, type SelectionRange } from '@codemirror/state';
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
import { useResizeObserver } from '@vueuse/core';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useShellResizeFrameScheduler } from '@/composables/useShellResizeFrameScheduler';
import { buildCodeMirrorSettingsExtensions } from '@/services/editor/codemirror-config';
import { createCodeMirrorInlineCompletionController } from '@/services/editor/codemirror-inline-completion';
import { loadCodeMirrorLanguageSupport, resolveCodeMirrorLanguageExtension } from '@/services/editor/codemirror-language';
import { setShikiLanguage, shikiEditorChromeTheme, shikiHighlightExtension } from '@/services/editor/codemirror-shiki-highlight';
import { createLspExtension, lspCompletionTheme } from '@/services/editor/lsp-bridge';
import { useEditorStore } from '@/store/editor';
import type { TThemeMode } from '@/types/app';
import type { IAnalyzeScriptPayload, IEditorSelectionSummary, TScriptDiagnosticSeverity } from '@/types/editor';
import type { IEditorSettings } from '@/types/settings';
import { resolveLanguageForPath } from '@/utils/editor-language';

interface IEditorExpose {
  focusEditor: () => void;
  insertSnippet: (snippet: string) => void;
  revealPosition: (line: number, column: number) => void;
  layoutEditor: () => void;
}

interface IAnalysisSignatureDiagnostic {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  level: TScriptDiagnosticSeverity;
  code: string;
  message: string;
}

const VIEW_STATE_SAVE_DEBOUNCE_MS = 500;
const SELECTION_SUMMARY_LIMIT = 4_000;

const createEmptyAnalysis = (): IAnalyzeScriptPayload => ({
  available: true,
  message: null,
  dialect: 'bash',
  diagnostics: [],
});

let cachedShellCompletionSourcePromise: Promise<CompletionSource> | null = null;
const getShellCompletionSource = (): Promise<CompletionSource> => {
  if (!cachedShellCompletionSourcePromise) {
    cachedShellCompletionSourcePromise = import('@/utils/shell-completion').then((mod) =>
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
  'update:modelValue': [value: string];
  'cursor-position-change': [line: number, column: number];
  'selection-change': [selection: IEditorSelectionSummary | null];
  'format-request': [];
  'command-palette-request': [];
  'run-request': [];
  'open-terminal-request': [];
}>();

const containerRef = ref<HTMLElement | null>(null);
const analysisState = computed(() => props.analysis ?? createEmptyAnalysis());
const editorStore = useEditorStore();

let editorView: EditorView | null = null;
let editorLayoutFrameId: number | null = null;
let viewStateSaveTimerId: number | null = null;
let suppressModelValueEmit = false;
let lastSyncedModelValue: string | null = null;
let previousContainerSize = { width: 0, height: 0 };
let shellcheckDiagnostics: Diagnostic[] = [];
let lspDiagnostics: Diagnostic[] = [];
let currentLsp: ReturnType<typeof createLspExtension> | null = null;

const languageCompartment = new Compartment();
const settingsCompartment = new Compartment();
const completionCompartment = new Compartment();
const lspCompartment = new Compartment();

const getCurrentLanguage = (): string => resolveLanguageForPath(props.documentPath, props.documentName);

const inlineCompletionController = createCodeMirrorInlineCompletionController({
  getFilePath: () => props.documentPath,
  getLanguage: () => getCurrentLanguage(),
});

const buildCompletionExtension = (
  editorSettings: IEditorSettings,
  language: string,
  lspCompletionSource?: CompletionSource | null,
): Extension =>
  editorSettings.commandCompletion
    ? autocompletion({
        activateOnTyping: true,
        activateOnTypingDelay: editorSettings.suggestionDelay,
        override:
          language === 'shell'
            ? [
                async (context) => {
                  const source = await getShellCompletionSource();
                  return source(context);
                },
                ...(lspCompletionSource ? [lspCompletionSource] : []),
              ]
            : [completeAnyWord],
        maxRenderedOptions: 80,
      })
    : [];

const lineColumnToOffset = (view: EditorView, line: number, column: number): number => {
  const lineInfo = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
  return Math.min(lineInfo.to, lineInfo.from + Math.max(0, column - 1));
};

const selectionRangeToText = (view: EditorView, range: SelectionRange): string =>
  view.state.doc.sliceString(range.from, range.to);

const truncateByCodePoint = (value: string, limit: number): string => {
  let count = 0;
  let endIndex = 0;
  for (const char of value) {
    if (count >= limit) break;
    endIndex += char.length;
    count += 1;
  }
  return endIndex < value.length ? `${value.slice(0, endIndex)}\n[已截断]` : value;
};

const resolveSelectionSummary = (): IEditorSelectionSummary | null => {
  const view = editorView;
  const range = view?.state.selection.main;
  if (!view || !range || range.empty) return null;
  const selectedText = selectionRangeToText(view, range);
  if (!selectedText.trim()) return null;
  return {
    text: truncateByCodePoint(selectedText, SELECTION_SUMMARY_LIMIT),
    startLine: view.state.doc.lineAt(range.from).number,
    endLine: view.state.doc.lineAt(range.to).number,
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
  if (anchor !== null) {
    const maxPosition = view.state.doc.length;
    view.dispatch({
      selection: EditorSelection.single(
        Math.min(Math.max(0, anchor), maxPosition),
        Math.min(Math.max(0, head as number), maxPosition),
      ),
    });
  }
  if (scrollTop !== null || scrollLeft !== null) {
    requestAnimationFrame(() => {
      if (!editorView) return;
      editorView.scrollDOM.scrollTop = scrollTop ?? editorView.scrollDOM.scrollTop;
      editorView.scrollDOM.scrollLeft = scrollLeft ?? editorView.scrollDOM.scrollLeft;
    });
  }
};

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

const applyDiagnostics = (): void => {
  const view = editorView;
  if (!view) return;
  const docLength = view.state.doc.length;
  const merged = [...shellcheckDiagnostics, ...lspDiagnostics]
    .map((diagnostic) => {
      const from = Math.min(Math.max(0, diagnostic.from), docLength);
      const to = Math.min(Math.max(from, diagnostic.to), docLength);
      return from === diagnostic.from && to === diagnostic.to ? diagnostic : { ...diagnostic, from, to };
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
          to,
          severity: toDiagnosticSeverity(item.level),
          source: item.code,
          message: `${item.code} · ${item.message}`,
        };
      })
    : [];
  applyDiagnostics();
};

const analysisSignature = computed(() => {
  const analysis = analysisState.value;
  const diagnostics = analysis.diagnostics as IAnalysisSignatureDiagnostic[];
  return JSON.stringify({
    available: analysis.available,
    diagnostics: diagnostics.map((item) => [
      item.line,
      item.column,
      item.endLine,
      item.endColumn,
      item.level,
      item.code,
      item.message,
    ]),
  });
});

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

useShellResizeFrameScheduler({
  onStart: updatePreviousContainerSize,
  onFrame: scheduleEditorLayout,
  onSettled: () => {
    updatePreviousContainerSize();
    scheduleEditorLayout();
  },
  settledFrames: 3,
});

const handleEditorUpdate = (update: ViewUpdate): void => {
  if (update.docChanged && !suppressModelValueEmit) {
    const nextValue = update.state.doc.toString();
    lastSyncedModelValue = nextValue;
    emit('update:modelValue', nextValue);
  }
  if (update.selectionSet || update.docChanged) {
    emitCursorPosition(update.view);
    emitSelectionSummary();
    scheduleViewStatePersist();
    inlineCompletionController.handleUpdate(update);
  }
  if (update.viewportChanged) scheduleViewStatePersist();
};

const buildLspExtension = (): Extension => {
  currentLsp?.detach();
  currentLsp = null;
  lspDiagnostics = [];
  applyDiagnostics();
  const language = getCurrentLanguage();
  if (language !== 'shell' || !props.documentPath) return [];
  currentLsp = createLspExtension({
    filePath: props.documentPath,
    languageId: 'shellscript',
    getContent: () => props.modelValue,
    onDiagnostics: (diagnostics) => {
      lspDiagnostics = diagnostics;
      applyDiagnostics();
    },
  });
  return currentLsp.extensions;
};

const editorBottomPaddingTheme = EditorView.theme({ '.cm-content': { paddingBottom: '24em' } });
const nativeSelectionWithDrawnCursorTheme = Prec.highest(
  EditorView.theme({
    '.cm-selectionLayer': { display: 'none' },
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
  lintGutter(),
  editorBottomPaddingTheme,
  ...inlineCompletionController.extensions,
  keymap.of([
    indentWithTab,
    { key: 'Alt-Shift-f', run: () => (emit('format-request'), true) },
    { key: 'Mod-Enter', run: () => (emit('run-request'), true) },
    { key: 'Mod-f', run: (view) => openSearchPanel(view) },
    { key: 'Mod-/', run: (view) => toggleLineComment(view) },
    { key: 'Ctrl-Space', run: acceptCompletion },
    ...defaultKeymap,
    ...historyKeymap,
    ...searchKeymap,
  ]),
  lspCompartment.of(buildLspExtension()),
  languageCompartment.of(resolveCodeMirrorLanguageExtension(language)),
  settingsCompartment.of(buildCodeMirrorSettingsExtensions(props.editorSettings)),
  completionCompartment.of(buildCompletionExtension(props.editorSettings, language, currentLsp?.completionSource)),
  EditorView.updateListener.of(handleEditorUpdate),
  shikiEditorChromeTheme,
];

const applyLanguageExtension = (language: string): void => {
  void loadCodeMirrorLanguageSupport(language).then((support) => {
    const view = editorView;
    if (!view || getCurrentLanguage() !== language) return;
    view.dispatch({ effects: languageCompartment.reconfigure(support ?? []) });
  });
};

const createEditor = (): void => {
  if (!containerRef.value || editorView) return;
  const language = getCurrentLanguage();
  editorView = new EditorView({
    parent: containerRef.value,
    state: EditorState.create({ doc: props.modelValue, extensions: createBaseExtensions(language) }),
  });
  lastSyncedModelValue = props.modelValue;
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
        buildCompletionExtension(props.editorSettings, getCurrentLanguage(), currentLsp?.completionSource),
      ),
    ],
  });
  currentLsp?.attach(view);
};

const reconfigureLanguage = (): void => {
  const view = editorView;
  if (!view) return;
  const language = getCurrentLanguage();
  inlineCompletionController.clear();
  view.dispatch({
    effects: [languageCompartment.reconfigure(resolveCodeMirrorLanguageExtension(language)), setShikiLanguage(language)],
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
        buildCompletionExtension(props.editorSettings, getCurrentLanguage(), currentLsp?.completionSource),
      ),
    ],
  });
  scheduleEditorLayout();
};

const computeMinimalDocChange = (current: string, next: string): { from: number; to: number; insert: string } => {
  const currentLength = current.length;
  const nextLength = next.length;
  let prefix = 0;
  const maxPrefix = Math.min(currentLength, nextLength);
  while (prefix < maxPrefix && current.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  const maxSuffix = Math.min(currentLength, nextLength) - prefix;
  while (
    suffix < maxSuffix &&
    current.charCodeAt(currentLength - 1 - suffix) === next.charCodeAt(nextLength - 1 - suffix)
  ) {
    suffix += 1;
  }
  return { from: prefix, to: currentLength - suffix, insert: next.slice(prefix, nextLength - suffix) };
};

watch(
  () => [props.documentPath, props.documentName] as const,
  ([nextPath], [previousPath]) => {
    if (previousPath) persistViewState(previousPath);
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
    if (value === lastSyncedModelValue) return;
    const current = view.state.doc.toString();
    if (current === value) {
      lastSyncedModelValue = value;
      return;
    }
    lastSyncedModelValue = value;
    suppressModelValueEmit = true;
    try {
      view.dispatch({ changes: computeMinimalDocChange(current, value) });
    } finally {
      suppressModelValueEmit = false;
    }
  },
);

watch(analysisSignature, () => syncDiagnostics());
watch(() => props.editorSettings, () => reconfigureSettings(), { deep: true });

onMounted(() => {
  createEditor();
  useResizeObserver(containerRef, () => {
    if (!containerRef.value) return;
    const nextWidth = Math.round(containerRef.value.clientWidth);
    const nextHeight = Math.round(containerRef.value.clientHeight);
    if (previousContainerSize.width === nextWidth && previousContainerSize.height === nextHeight) return;
    previousContainerSize = { width: nextWidth, height: nextHeight };
    scheduleEditorLayout();
  });
});

onBeforeUnmount(() => {
  persistViewState(props.documentPath);
  clearViewStateSaveTimer();
  inlineCompletionController.destroy();
  currentLsp?.detach();
  if (editorLayoutFrameId !== null) {
    window.cancelAnimationFrame(editorLayoutFrameId);
    editorLayoutFrameId = null;
  }
  editorView?.destroy();
  editorView = null;
});

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

defineExpose<IEditorExpose>({ focusEditor, insertSnippet, revealPosition, layoutEditor });
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
