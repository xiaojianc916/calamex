<template>
  <div ref="containerRef" class="h-full min-h-0 w-full bg-[var(--editor-bg)]" />
</template>

<script setup lang="ts">
import type { TThemeMode } from '@/types/app';
import { monaco } from '@/utils/monaco';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

interface IEditorExpose {
  focusEditor: () => void;
  insertSnippet: (snippet: string) => void;
}

const props = withDefaults(
  defineProps<{
    modelValue: string;
    theme: TThemeMode;
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
    lineDecorationsWidth: 10,
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
    glyphMargin: false,
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
    emit('cursor-position-change', event.position.lineNumber, event.position.column);
  });

  const initialPosition = editorInstance.getPosition();
  if (initialPosition) {
    emit('cursor-position-change', initialPosition.lineNumber, initialPosition.column);
  }

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
