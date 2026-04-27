<template>
  <div class="shell-editor-surface relative h-full min-h-0 w-full bg-(--editor-bg)">
    <div ref="containerRef" class="h-full min-h-0 w-full bg-(--editor-bg)" />
    <section v-if="aiActionResult || isAiActionRunning || aiActionError" class="ai-code-action-card">
      <div class="ai-code-action-head">
        <span>{{ isAiActionRunning ? 'AI 正在分析…' : 'AI Code Action' }}</span>
        <button type="button" aria-label="关闭 AI 结果" @click="clearAiActionResult">×</button>
      </div>
      <p v-if="aiActionError" class="is-error">{{ aiActionError }}</p>
      <template v-else-if="aiActionResult">
        <p>{{ aiActionResult.explanation }}</p>
        <ul v-if="aiActionResult.followUpQuestions.length">
          <li v-for="question in aiActionResult.followUpQuestions" :key="question">
            {{ question }}
          </li>
        </ul>
        <p v-if="aiActionResult.testSuggestion" class="ai-code-action-note">
          {{ aiActionResult.testSuggestion }}
        </p>
      </template>
    </section>
    <EditorContextMenu
      :open="contextMenuState.open"
      :x="contextMenuState.x"
      :y="contextMenuState.y"
      :groups="contextMenuGroups"
      :theme="props.theme"
      :submenu-direction="submenuDirection"
      @select="handleContextMenuItemSelect"
    />
  </div>
</template>

<script setup lang="ts">
import type { IEditorContextMenuItem } from '@/components/editor/editor-context-menu.types';
import EditorContextMenu from '@/components/editor/EditorContextMenu.vue';
import { useEditorContextMenu } from '@/composables/useEditorContextMenu';
import { aiService } from '@/services/modules/ai';
import { useEditorStore } from '@/store/editor';
import type { TThemeMode } from '@/types/app';
import type { IAnalyzeScriptPayload, TScriptDiagnosticSeverity } from '@/types/editor';
import type { IEditorSelectionSummary } from '@/types/editor';
import type { IGitFileBaselinePayload } from '@/types/git';
import type { IEditorSettings } from '@/types/settings';
import type { IAiCodeActionRequest, IAiCodeActionResult } from '@/types/ai';
import { computeGitLineChanges } from '@/utils/git-diff';
import { applyMonacoTheme, monaco } from '@/utils/monaco';
import {
    SHELL_WINDOW_RESIZE_END_EVENT,
    SHELL_WINDOW_RESIZE_SETTLED_EVENT,
    SHELL_WINDOW_RESIZE_START_EVENT,
} from '@/utils/window-resize-events';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

interface IEditorExpose {
  focusEditor: () => void;
  insertSnippet: (snippet: string) => void;
  revealPosition: (line: number, column: number) => void;
  layoutEditor: () => void;
  runAiCodeAction: (kind: IAiCodeActionRequest['kind']) => Promise<void>;
}

const VIEW_STATE_SAVE_DEBOUNCE_MS = 500;

const createEmptyAnalysis = (): IAnalyzeScriptPayload => ({
  available: true,
  message: null,
  dialect: 'bash',
  diagnostics: [],
});

const props = withDefaults(
  defineProps<{
    documentPath?: string | null;
    modelValue?: string;
    theme?: TThemeMode;
    analysis?: IAnalyzeScriptPayload;
    gitBaseline?: IGitFileBaselinePayload | null;
    editorSettings: IEditorSettings;
    canRun?: boolean;
  }>(),
  {
    documentPath: null,
    modelValue: '',
    theme: 'dark',
    analysis: undefined,
    gitBaseline: null,
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
}>();

let editorInstance: monaco.editor.IStandaloneCodeEditor | null = null;

const containerRef = ref<HTMLElement | null>(null);
const analysisState = computed(() => props.analysis ?? createEmptyAnalysis());
const aiActionResult = ref<IAiCodeActionResult | null>(null);
const aiActionError = ref('');
const isAiActionRunning = ref(false);
const editorStore = useEditorStore();
const {
  contextMenuState,
  contextMenuGroups,
  submenuDirection,
  closeContextMenu,
  executeContextMenuItem,
  handleEditorContextMenu,
} = useEditorContextMenu({
  getEditor: () => editorInstance,
  canRunCurrentScript: () => props.canRun,
  onFormatRequest: () => {
    emit('format-request');
  },
  onCommandPaletteRequest: () => {
    emit('command-palette-request');
  },
  onRunCurrentScriptRequest: () => {
    emit('run-request');
  },
  onAiCodeActionRequest: async (kind, selection) => {
    await runAiCodeAction(kind, selection);
  },
});

const handleContextMenuItemSelect = (item: IEditorContextMenuItem): void => {
  void executeContextMenuItem(item);
};

const clearAiActionResult = (): void => {
  aiActionResult.value = null;
  aiActionError.value = '';
  isAiActionRunning.value = false;
};

const runAiCodeAction = async (
  kind: IAiCodeActionRequest['kind'],
  selection: string,
): Promise<void> => {
  if (isAiActionRunning.value) {
    return;
  }

  isAiActionRunning.value = true;
  aiActionError.value = '';
  aiActionResult.value = null;

  try {
    aiActionResult.value = await aiService.codeAction({
      kind,
      filePath: props.documentPath ?? null,
      language: 'shell',
      selection,
      diagnostics: analysisState.value.diagnostics.map(
        (item) => `${item.code}: ${item.message}`,
      ),
    });
  } catch (error) {
    aiActionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    isAiActionRunning.value = false;
  }
};

const resolveCurrentSelectionText = (): string => {
  const editor = editorInstance;
  const model = editor?.getModel();
  const selection = editor?.getSelection();
  if (!model || !selection) {
    return '';
  }

  const selectedText = model.getValueInRange(selection);
  if (selectedText.trim()) {
    return selectedText;
  }

  const position = editor.getPosition();
  if (!position) {
    return '';
  }

  return model.getLineContent(position.lineNumber);
};

const resolveCurrentSelectionSummary = (): IEditorSelectionSummary | null => {
  const editor = editorInstance;
  const model = editor?.getModel();
  const selection = editor?.getSelection();
  if (!model || !selection || selection.isEmpty()) {
    return null;
  }

  const selectedText = model.getValueInRange(selection);
  if (!selectedText.trim()) {
    return null;
  }

  const chars = [...selectedText];
  return {
    text: chars.length > 4_000 ? `${chars.slice(0, 4_000).join('')}\n[已截断]` : selectedText,
    startLine: selection.startLineNumber,
    endLine: selection.endLineNumber,
  };
};

const emitSelectionSummary = (): void => {
  emit('selection-change', resolveCurrentSelectionSummary());
};

const runAiCodeActionFromEditor = async (
  kind: IAiCodeActionRequest['kind'],
): Promise<void> => {
  const selection = resolveCurrentSelectionText();
  await runAiCodeAction(kind, selection);
};

const DEFAULT_EDITOR_FONT_FAMILY =
  "Berkeley Mono, JetBrains Mono, Consolas, 'Courier New', monospace";

const resolveEditorFontFamily = (fontFamily: string): string => {
  const normalizedFontFamily = fontFamily.trim();
  return normalizedFontFamily.length > 0
    ? `${normalizedFontFamily}, ${DEFAULT_EDITOR_FONT_FAMILY}`
    : DEFAULT_EDITOR_FONT_FAMILY;
};

const resolveEditorLineHeight = (
  fontSize: number,
  lineHeight: IEditorSettings['lineHeight'],
): number => Math.max(fontSize + 4, Math.round(fontSize * Number(lineHeight)));

const resolveEditorWhitespace = (
  whitespace: IEditorSettings['whitespace'],
): 'all' | 'none' | 'selection' => {
  switch (whitespace) {
    case 'always':
      return 'all';
    case 'selection':
      return 'selection';
    case 'never':
    default:
      return 'none';
  }
};

const resolveWordWrap = (wordWrap: IEditorSettings['wordWrap']): 'off' | 'on' =>
  wordWrap === 'viewport' ? 'on' : 'off';

const resolveLineNumbers = (enabled: boolean): 'off' | 'on' => (enabled ? 'on' : 'off');

const resolveInsertSpaces = (indentation: IEditorSettings['indentation']): boolean =>
  indentation === 'spaces';

const resolveQuickSuggestions = (
  enabled: boolean,
): false | { comments: false; other: true; strings: true } =>
  enabled
    ? {
      other: true,
      comments: false,
      strings: true,
    }
    : false;

const resolveAutoClosingStrategy = (
  enabled: boolean,
): 'languageDefined' | 'never' => (enabled ? 'languageDefined' : 'never');

const resolveEditorRuntimeOptions = (editorSettings: IEditorSettings) => ({
  minimap: { enabled: editorSettings.minimap },
  lineNumbers: resolveLineNumbers(editorSettings.lineNumbers),
  fontSize: editorSettings.fontSize,
  fontFamily: resolveEditorFontFamily(editorSettings.fontFamily),
  fontLigatures: editorSettings.fontLigatures,
  lineHeight: resolveEditorLineHeight(editorSettings.fontSize, editorSettings.lineHeight),
  wordWrap: resolveWordWrap(editorSettings.wordWrap),
  renderWhitespace: resolveEditorWhitespace(editorSettings.whitespace),
  quickSuggestions: resolveQuickSuggestions(editorSettings.commandCompletion),
  quickSuggestionsDelay: editorSettings.suggestionDelay,
  suggestOnTriggerCharacters: editorSettings.commandCompletion,
  autoClosingBrackets: resolveAutoClosingStrategy(editorSettings.autoClosingPairs),
  autoClosingQuotes: resolveAutoClosingStrategy(editorSettings.autoClosingPairs),
  guides: {
    indentation: editorSettings.indentGuides,
  },
});

let suppressModelValueEmit = false;
let resizeObserver: ResizeObserver | null = null;
let editorLayoutFrameId: number | null = null;
let shellCompletionRegistrationTimerId: number | null = null;
let shellCompletionRegistrationPromise: Promise<void> | null = null;
let aiInlineCompletionDisposable: monaco.IDisposable | null = null;
let aiInlineCompletionRequestId = 0;
let previousContainerSize = { width: 0, height: 0 };
let gitDecorationsCollection: monaco.editor.IEditorDecorationsCollection | null = null;
let viewStateSaveTimerId: number | null = null;
let isShellWindowResizing = false;
let pendingEditorLayoutAfterWindowResize = false;

const clearViewStateSaveTimer = (): void => {
  if (viewStateSaveTimerId !== null) {
    window.clearTimeout(viewStateSaveTimerId);
    viewStateSaveTimerId = null;
  }
};

const persistViewState = (path: string | null | undefined): void => {
  if (!editorInstance || !path) {
    return;
  }

  const nextState = editorInstance.saveViewState();
  if (!nextState) {
    return;
  }

  editorStore.saveEditorViewState(path, nextState as unknown as Record<string, unknown>);
};

const scheduleViewStatePersist = (): void => {
  clearViewStateSaveTimer();
  viewStateSaveTimerId = window.setTimeout(() => {
    viewStateSaveTimerId = null;
    persistViewState(props.documentPath);
  }, VIEW_STATE_SAVE_DEBOUNCE_MS);
};

const restoreViewStateForPath = (path: string | null | undefined): void => {
  if (!editorInstance || !path) {
    return;
  }

  const savedState = editorStore.getEditorViewState(path);
  if (!savedState) {
    return;
  }

  editorInstance.restoreViewState(savedState as unknown as monaco.editor.ICodeEditorViewState);
  editorInstance.focus();
};

const toMarkerSeverity = (level: TScriptDiagnosticSeverity): monaco.MarkerSeverity => {
  switch (level) {
    case 'error':
      return monaco.MarkerSeverity.Error;
    case 'warning':
      return monaco.MarkerSeverity.Warning;
    case 'style':
      return monaco.MarkerSeverity.Hint;
    default:
      return monaco.MarkerSeverity.Info;
  }
};

const syncMarkers = (): void => {
  const model = editorInstance?.getModel();
  if (!model) {
    return;
  }

  const markers = analysisState.value.available
    ? analysisState.value.diagnostics.map((item) => ({
      startLineNumber: item.line,
      endLineNumber: item.endLine,
      startColumn: item.column,
      endColumn: Math.max(item.column + 1, item.endColumn),
      severity: toMarkerSeverity(item.level),
      message: `${item.code} · ${item.message}`,
      source: 'ShellCheck',
      code: item.code,
    }))
    : [];

  monaco.editor.setModelMarkers(model, 'shellcheck', markers);
};

const buildGitDecorations = (): monaco.editor.IModelDeltaDecoration[] => {
  const currentContent = props.modelValue ?? '';
  const gitBaseline = props.gitBaseline;

  if (!gitBaseline?.available || !gitBaseline.repositoryRootPath) {
    return [];
  }

  const lineChanges = !gitBaseline.isTracked
    ? (() => {
      const lineCount = currentContent.length === 0 ? 0 : currentContent.split('\n').length;
      return lineCount === 0
        ? []
        : [{ type: 'added', startLine: 1, endLine: lineCount }];
    })()
    : gitBaseline.content === null
      ? []
      : computeGitLineChanges(gitBaseline.content, currentContent);

  return lineChanges.map((change) => {
    const tone = change.type === 'deleted' ? 'deleted' : 'added';
    const range = new monaco.Range(change.startLine, 1, change.endLine, 1);

    return {
      range,
      options: {
        isWholeLine: true,
        className: `git-diff-line git-diff-line-${tone}`,
        lineNumberClassName: `git-diff-line-number git-diff-line-number-${tone}`,
        linesDecorationsClassName: `git-diff-gutter git-diff-gutter-${tone}`,
        overviewRuler: {
          color: tone === 'added' ? '#86efaccc' : '#fb7185cc',
          position: monaco.editor.OverviewRulerLane.Left,
        },
      },
    };
  });
};

const getGitDecorationsCollection = (): monaco.editor.IEditorDecorationsCollection | null => {
  if (!editorInstance) {
    return null;
  }

  if (!gitDecorationsCollection) {
    gitDecorationsCollection = editorInstance.createDecorationsCollection();
  }

  return gitDecorationsCollection;
};

const syncGitDecorations = (): void => {
  const collection = getGitDecorationsCollection();
  if (!collection) {
    return;
  }

  collection.set(buildGitDecorations());
};

const layoutEditor = (): void => {
  editorInstance?.layout();
};

const scheduleEditorLayout = (): void => {
  if (isShellWindowResizing) {
    pendingEditorLayoutAfterWindowResize = true;
    return;
  }

  if (editorLayoutFrameId !== null) {
    return;
  }

  editorLayoutFrameId = window.requestAnimationFrame(() => {
    editorLayoutFrameId = null;
    layoutEditor();
  });
};

const updatePreviousContainerSize = (): void => {
  if (!containerRef.value) {
    return;
  }

  previousContainerSize = {
    width: Math.round(containerRef.value.clientWidth),
    height: Math.round(containerRef.value.clientHeight),
  };
};

const handleShellWindowResizeStart = (): void => {
  isShellWindowResizing = true;
  pendingEditorLayoutAfterWindowResize = false;

  if (editorLayoutFrameId !== null) {
    window.cancelAnimationFrame(editorLayoutFrameId);
    editorLayoutFrameId = null;
  }
};

const handleShellWindowResizeEnd = (): void => {
  const shouldRelayout = pendingEditorLayoutAfterWindowResize || editorInstance !== null;
  pendingEditorLayoutAfterWindowResize = false;
  pendingEditorLayoutAfterWindowResize = shouldRelayout;
};

const handleShellWindowResizeSettled = (): void => {
  isShellWindowResizing = false;
  updatePreviousContainerSize();
  const shouldRelayout = pendingEditorLayoutAfterWindowResize || editorInstance !== null;
  pendingEditorLayoutAfterWindowResize = false;
  if (shouldRelayout) {
    scheduleEditorLayout();
  }
};

const setTheme = (theme: TThemeMode): void => {
  applyMonacoTheme(theme);
};

const ensureShellCompletionProvider = async (): Promise<void> => {
  if (!shellCompletionRegistrationPromise) {
    shellCompletionRegistrationPromise = import('@/utils/shell-completion')
      .then(({ registerShellCompletionProvider }) => {
        registerShellCompletionProvider(monaco);
      })
      .catch((error) => {
        shellCompletionRegistrationPromise = null;
        console.error('Shell completion provider preload failed', error);
      });
  }

  await shellCompletionRegistrationPromise;
};

const scheduleShellCompletionRegistration = (): void => {
  if (shellCompletionRegistrationTimerId !== null) {
    return;
  }

  shellCompletionRegistrationTimerId = window.setTimeout(() => {
    shellCompletionRegistrationTimerId = null;
    void ensureShellCompletionProvider();
  }, 0);
};

const clipInlineContext = (value: string, limit: number): string => {
  const chars = [...value];
  return chars.length <= limit ? value : chars.slice(chars.length - limit).join('');
};

const registerAiInlineCompletionProvider = (): void => {
  if (aiInlineCompletionDisposable) {
    return;
  }

  aiInlineCompletionDisposable = monaco.languages.registerInlineCompletionsProvider('shell', {
    async provideInlineCompletions(model, position, _context, token) {
      const requestId = ++aiInlineCompletionRequestId;
      const config = await aiService.getConfig();
      if (
        token.isCancellationRequested ||
        requestId !== aiInlineCompletionRequestId ||
        !config.inlineCompletionEnabled
      ) {
        return { items: [] };
      }

      const cursorOffset = model.getOffsetAt(position);
      const fullText = model.getValue();
      const prefix = clipInlineContext(fullText.slice(0, cursorOffset), 8_000);
      const suffix = fullText.slice(cursorOffset, cursorOffset + 8_000);
      const result = await aiService.inlineComplete({
        filePath: props.documentPath ?? 'untitled.sh',
        language: 'shell',
        cursorOffset,
        prefix,
        suffix,
      });

      if (
        token.isCancellationRequested ||
        requestId !== aiInlineCompletionRequestId ||
        !result.insertText.trim()
      ) {
        return { items: [] };
      }

      return {
        items: [
          {
            insertText: result.insertText,
            range: new monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column,
            ),
          },
        ],
      };
    },
    disposeInlineCompletions() {
      // Monaco 0.55 要求提供释放入口；当前没有额外资源需要释放。
    },
  });
};

const applyEditorSettings = (): void => {
  const editor = editorInstance;
  const model = editor?.getModel();

  if (!editor || !model) {
    return;
  }

  const { editorSettings } = props;

  editor.updateOptions(resolveEditorRuntimeOptions(editorSettings));

  model.updateOptions({
    trimAutoWhitespace: editorSettings.trimTrailingWhitespace,
  });

  if (editorSettings.detectIndentation) {
    model.detectIndentation(resolveInsertSpaces(editorSettings.indentation), editorSettings.tabSize);
  } else {
    model.updateOptions({
      insertSpaces: resolveInsertSpaces(editorSettings.indentation),
      tabSize: editorSettings.tabSize,
      trimAutoWhitespace: editorSettings.trimTrailingWhitespace,
    });
  }

  scheduleEditorLayout();
};

const createEditor = (): void => {
  if (!containerRef.value) {
    return;
  }

  setTheme(props.theme);

  editorInstance = monaco.editor.create(containerRef.value, {
    value: props.modelValue,
    language: 'shell',
    useShadowDOM: false,
    automaticLayout: false,
    lineDecorationsWidth: 16,
    lineNumbersMinChars: 3,
    fontWeight: '400',
    padding: {
      top: 18,
      bottom: 24,
    },
    roundedSelection: false,
    scrollBeyondLastLine: false,
    autoIndent: 'advanced',
    folding: true,
    foldingStrategy: 'auto',
    smoothScrolling: false,
    cursorBlinking: 'smooth',
    overviewRulerBorder: false,
    glyphMargin: true,
    renderValidationDecorations: 'on',
    fixedOverflowWidgets: true,
    contextmenu: false,
    scrollbar: {
      verticalScrollbarSize: 10,
      horizontalScrollbarSize: 10,
      useShadows: false,
    },
    ...resolveEditorRuntimeOptions(props.editorSettings),
  });

  applyEditorSettings();

  editorInstance.addAction({
    id: 'sh-editor.format-with-shfmt',
    label: '使用 shfmt 格式化',
    run: async () => {
      emit('format-request');
    },
  });

  editorInstance.onContextMenu((event) => {
    handleEditorContextMenu(event);
  });

  editorInstance.onDidBlurEditorText(() => {
    closeContextMenu();
  });

  editorInstance.onDidBlurEditorWidget(() => {
    closeContextMenu();
  });

  editorInstance.onDidChangeModelContent(() => {
    if (!editorInstance || suppressModelValueEmit) {
      return;
    }

    closeContextMenu();
    emit('update:modelValue', editorInstance.getValue());
  });

  editorInstance.onDidChangeCursorPosition((event) => {
    emit('cursor-position-change', event.position.lineNumber, event.position.column);
    scheduleViewStatePersist();
  });

  editorInstance.onDidChangeCursorSelection(() => {
    emitSelectionSummary();
  });

  editorInstance.onDidScrollChange(() => {
    closeContextMenu();
    scheduleViewStatePersist();
  });

  editorInstance.onDidChangeModelDecorations(() => {
    scheduleViewStatePersist();
  });

  const initialPosition = editorInstance.getPosition();
  if (initialPosition) {
    emit('cursor-position-change', initialPosition.lineNumber, initialPosition.column);
  }

  syncMarkers();
  syncGitDecorations();
  restoreViewStateForPath(props.documentPath);
  scheduleShellCompletionRegistration();
  registerAiInlineCompletionProvider();

  requestAnimationFrame(() => {
    scheduleEditorLayout();
    requestAnimationFrame(() => {
      scheduleEditorLayout();
    });
  });
};

watch(
  () => props.documentPath,
  (nextPath, previousPath) => {
    if (!editorInstance) {
      return;
    }

    if (previousPath) {
      persistViewState(previousPath);
    }

    restoreViewStateForPath(nextPath);
  },
  { flush: 'sync' },
);

watch(
  () => props.modelValue,
  (value) => {
    if (!editorInstance) {
      return;
    }

    if (editorInstance.getValue() !== value) {
      suppressModelValueEmit = true;
      editorInstance.setValue(value);
      suppressModelValueEmit = false;
    }

    syncGitDecorations();
  },
);

watch(
  () => props.theme,
  (value) => {
    setTheme(value);
  },
);

watch(
  () => props.analysis,
  () => {
    syncMarkers();
  },
  { deep: true },
);

watch(
  () => props.gitBaseline,
  () => {
    syncGitDecorations();
  },
  { deep: true },
);

watch(
  () => props.editorSettings,
  () => {
    applyEditorSettings();
  },
  { deep: true },
);

onMounted(() => {
  createEditor();
  window.addEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);
  window.addEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleShellWindowResizeEnd);
  window.addEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);

  if (typeof ResizeObserver !== 'undefined' && containerRef.value) {
    updatePreviousContainerSize();

    resizeObserver = new ResizeObserver(() => {
      if (!containerRef.value) {
        return;
      }

      const nextWidth = Math.round(containerRef.value.clientWidth);
      const nextHeight = Math.round(containerRef.value.clientHeight);

      if (
        previousContainerSize.width === nextWidth &&
        previousContainerSize.height === nextHeight
      ) {
        return;
      }

      previousContainerSize = {
        width: nextWidth,
        height: nextHeight,
      };
      scheduleEditorLayout();
    });
    resizeObserver.observe(containerRef.value);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);
  window.removeEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleShellWindowResizeEnd);
  window.removeEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);

  persistViewState(props.documentPath);
  clearViewStateSaveTimer();

  const model = editorInstance?.getModel();
  if (model) {
    monaco.editor.setModelMarkers(model, 'shellcheck', []);
  }

  gitDecorationsCollection?.clear();
  gitDecorationsCollection = null;

  resizeObserver?.disconnect();
  resizeObserver = null;

  if (editorLayoutFrameId !== null) {
    window.cancelAnimationFrame(editorLayoutFrameId);
    editorLayoutFrameId = null;
  }

  if (shellCompletionRegistrationTimerId !== null) {
    window.clearTimeout(shellCompletionRegistrationTimerId);
    shellCompletionRegistrationTimerId = null;
  }

  aiInlineCompletionRequestId += 1;
  aiInlineCompletionDisposable?.dispose();
  aiInlineCompletionDisposable = null;

  closeContextMenu();
  editorInstance?.dispose();
  editorInstance = null;
});

const focusEditor = (): void => {
  editorInstance?.focus();
};

const insertSnippet = (snippet: string): void => {
  if (!editorInstance) {
    return;
  }

  const selection = editorInstance.getSelection();
  if (!selection) {
    return;
  }

  editorInstance.executeEdits('insert-snippet', [
    {
      range: selection,
      text: snippet,
      forceMoveMarkers: true,
    },
  ]);
  editorInstance.focus();
};

const revealPosition = (line: number, column: number): void => {
  if (!editorInstance) {
    return;
  }

  const position = {
    lineNumber: Math.max(1, line),
    column: Math.max(1, column),
  };

  editorInstance.revealPositionInCenter(position);
  editorInstance.setPosition(position);
  editorInstance.focus();
};

defineExpose<IEditorExpose>({
  focusEditor,
  insertSnippet,
  revealPosition,
  layoutEditor,
  runAiCodeAction: runAiCodeActionFromEditor,
});
</script>

<style scoped>
.ai-code-action-card {
  position: absolute;
  right: 14px;
  bottom: 14px;
  z-index: 8;
  display: grid;
  width: min(420px, calc(100% - 28px));
  max-height: 280px;
  gap: 8px;
  overflow: auto;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 100%, rgba(255, 255, 255, 0.1));
  border-radius: 8px;
  background: color-mix(in srgb, var(--panel-bg) 96%, var(--sidebar-bg));
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.36), 0 0 0 0.5px rgba(255, 255, 255, 0.06);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.55;
  padding: 10px;
}

.ai-code-action-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--text-primary);
  font-weight: 600;
}

.ai-code-action-head button {
  width: 22px;
  height: 22px;
  border-radius: 5px;
  color: var(--text-quaternary);
}

.ai-code-action-head button:hover {
  background: var(--surface-soft);
  color: var(--text-primary);
}

.ai-code-action-card p,
.ai-code-action-card ul {
  margin: 0;
}

.ai-code-action-card ul {
  padding-left: 18px;
}

.ai-code-action-card .is-error {
  color: var(--danger);
}

.ai-code-action-note {
  color: var(--text-tertiary);
}
</style>
