<template>
  <div class="shell-editor-surface relative h-full min-h-0 w-full bg-[var(--editor-bg)]">
    <div ref="containerRef" class="h-full min-h-0 w-full bg-[var(--editor-bg)]" />

    <aside
      v-if="shouldShowOverlay"
      class="shell-diagnostic-overlay"
      :class="overlayToneClass"
    >
      <div class="shell-diagnostic-overlay-head">
        <div>
          <p class="shell-diagnostic-overlay-eyebrow">实时诊断</p>
          <p class="shell-diagnostic-overlay-title">ShellCheck / {{ analysisState.dialect }}</p>
        </div>
        <span class="shell-diagnostic-overlay-count mono-text">
          {{ overlaySummaryLabel }}
        </span>
      </div>

      <p v-if="analysisState.message && !analysisState.available" class="shell-diagnostic-overlay-message">
        {{ analysisState.message }}
      </p>

      <div v-else class="shell-diagnostic-overlay-list">
        <article
          v-for="item in overlayDiagnostics"
          :key="`${item.code}-${item.line}-${item.column}-${item.message}`"
          class="shell-diagnostic-card"
          :class="diagnosticCardToneClass(item.level)"
        >
          <div class="shell-diagnostic-card-head">
            <span class="shell-diagnostic-card-badge" :class="diagnosticBadgeToneClass(item.level)">
              {{ severityLabel(item.level) }}
            </span>
            <span class="mono-text shell-diagnostic-card-position">
              L{{ item.line }}:{{ item.column }} · {{ item.code }}
            </span>
          </div>
          <p class="shell-diagnostic-card-message">{{ item.message }}</p>
          <div class="shell-diagnostic-card-snippet mono-text">
            <span class="shell-diagnostic-card-line">{{ item.line }}</span>
            <span class="truncate">{{ excerptFor(item) }}</span>
          </div>
        </article>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
import type { TThemeMode } from '@/types/app';
import type { IAnalyzeScriptPayload, IScriptDiagnostic, TScriptDiagnosticSeverity } from '@/types/editor';
import { monaco } from '@/utils/monaco';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

interface IEditorExpose {
  focusEditor: () => void;
  insertSnippet: (snippet: string) => void;
}

const createEmptyAnalysis = (): IAnalyzeScriptPayload => ({
  available: true,
  message: null,
  dialect: 'bash',
  diagnostics: [],
});

const props = withDefaults(
  defineProps<{
    modelValue?: string;
    theme?: TThemeMode;
    analysis?: IAnalyzeScriptPayload;
  }>(),
  {
    modelValue: '',
    theme: 'dark',
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
  'cursor-position-change': [line: number, column: number];
}>();

const containerRef = ref<HTMLElement | null>(null);
let editorInstance: monaco.editor.IStandaloneCodeEditor | null = null;
let suppressModelValueEmit = false;
let resizeObserver: ResizeObserver | null = null;
const activeCursorLine = ref(1);

const analysisState = computed(() => props.analysis ?? createEmptyAnalysis());
const normalizedLines = computed(() =>
  (props.modelValue ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n'),
);

const overlayDiagnostics = computed<IScriptDiagnostic[]>(() => {
  const diagnostics = analysisState.value.diagnostics;
  if (diagnostics.length === 0) {
    return [];
  }

  const activeLineMatches = diagnostics.filter(
    (item) => activeCursorLine.value >= item.line && activeCursorLine.value <= item.endLine,
  );

  return (activeLineMatches.length > 0 ? activeLineMatches : diagnostics).slice(0, 3);
});

const shouldShowOverlay = computed(
  () => !analysisState.value.available || overlayDiagnostics.value.length > 0,
);

const overlaySummaryLabel = computed(() => {
  if (!analysisState.value.available) {
    return '未就绪';
  }

  return `${analysisState.value.diagnostics.length} 项`;
});

const overlayToneClass = computed(() => {
  if (!analysisState.value.available) {
    return 'is-warning';
  }

  const highestLevel = overlayDiagnostics.value[0]?.level;
  if (highestLevel === 'error') {
    return 'is-danger';
  }
  if (highestLevel === 'warning') {
    return 'is-warning';
  }

  return 'is-info';
});

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

const excerptFor = (diagnostic: IScriptDiagnostic): string => {
  const lineText = normalizedLines.value[diagnostic.line - 1] ?? '';
  return lineText.trim() || '(空行)';
};

const severityLabel = (level: TScriptDiagnosticSeverity): string => {
  switch (level) {
    case 'error':
      return '错误';
    case 'warning':
      return '警告';
    case 'style':
      return '风格';
    default:
      return '提示';
  }
};

const diagnosticCardToneClass = (level: TScriptDiagnosticSeverity): string => {
  switch (level) {
    case 'error':
      return 'is-danger';
    case 'warning':
      return 'is-warning';
    default:
      return 'is-info';
  }
};

const diagnosticBadgeToneClass = (level: TScriptDiagnosticSeverity): string => {
  switch (level) {
    case 'error':
      return 'is-danger';
    case 'warning':
      return 'is-warning';
    default:
      return 'is-info';
  }
};

const layoutEditor = (): void => {
  editorInstance?.layout();
};

const setTheme = (theme: TThemeMode): void => {
  monaco.editor.setTheme(theme === 'dark' ? 'sh-dark' : 'sh-light');
};

const createEditor = (): void => {
  if (!containerRef.value) {
    return;
  }

  setTheme(props.theme);

  editorInstance = monaco.editor.create(containerRef.value, {
    value: props.modelValue,
    language: 'shell',
    automaticLayout: false,
    minimap: { enabled: false },
    lineNumbers: 'on',
    lineDecorationsWidth: 16,
    lineNumbersMinChars: 3,
    fontSize: 13,
    fontWeight: '400',
    fontFamily: `Berkeley Mono, JetBrains Mono, Consolas, 'Courier New', monospace`,
    padding: {
      top: 18,
      bottom: 24,
    },
    roundedSelection: false,
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    tabSize: 2,
    insertSpaces: true,
    guides: {
      indentation: true,
    },
    renderWhitespace: 'selection',
    autoIndent: 'advanced',
    folding: true,
    foldingStrategy: 'auto',
    smoothScrolling: false,
    cursorBlinking: 'smooth',
    overviewRulerBorder: false,
    glyphMargin: true,
    renderValidationDecorations: 'on',
    fixedOverflowWidgets: true,
    scrollbar: {
      verticalScrollbarSize: 10,
      horizontalScrollbarSize: 10,
      useShadows: false,
    },
  });

  editorInstance.onDidChangeModelContent(() => {
    if (!editorInstance) {
      return;
    }

    if (suppressModelValueEmit) {
      return;
    }

    emit('update:modelValue', editorInstance.getValue());
  });

  editorInstance.onDidChangeCursorPosition((event) => {
    activeCursorLine.value = event.position.lineNumber;
    emit('cursor-position-change', event.position.lineNumber, event.position.column);
  });

  const initialPosition = editorInstance.getPosition();
  if (initialPosition) {
    activeCursorLine.value = initialPosition.lineNumber;
    emit('cursor-position-change', initialPosition.lineNumber, initialPosition.column);
  }

  syncMarkers();

  requestAnimationFrame(() => {
    layoutEditor();
    requestAnimationFrame(() => {
      layoutEditor();
    });
  });
};

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

onMounted(() => {
  createEditor();

  if (typeof ResizeObserver !== 'undefined' && containerRef.value) {
    resizeObserver = new ResizeObserver(() => {
      layoutEditor();
    });
    resizeObserver.observe(containerRef.value);
  }
});

onBeforeUnmount(() => {
  const model = editorInstance?.getModel();
  if (model) {
    monaco.editor.setModelMarkers(model, 'shellcheck', []);
  }
  resizeObserver?.disconnect();
  resizeObserver = null;
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

defineExpose<IEditorExpose>({
  focusEditor,
  insertSnippet,
});
</script>
