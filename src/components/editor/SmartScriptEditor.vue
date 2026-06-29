<template>
  <CodeMirrorScriptEditor
    ref="innerEditorRef"
    :document-path="documentPath"
    :document-name="documentName"
    :model-value="modelValue"
    :theme="theme"
    :can-run="canRun"
    :editor-settings="editorSettings"
    @update:model-value="handleModelValueChange"
    @cursor-position-change="handleCursorPositionChange"
    @selection-change="emit('selection-change', $event)"
    @open-terminal-request="emit('open-terminal-request')"
    @format-request="emit('format-request')"
    @command-palette-request="emit('command-palette-request')"
    @run-request="emit('run-request')"
  />
</template>

<script setup lang="ts">
import { ref } from 'vue';
import CodeMirrorScriptEditor from '@/components/editor/CodeMirrorScriptEditor.vue';
import type { TThemeMode } from '@/types/app';
import type { IEditorSelectionSummary } from '@/types/editor';
import type { IEditorSettings } from '@/types/settings';
import type { IDocumentMetrics } from '@/utils/editor/document-metrics';

interface IEditorExpose {
  focusEditor: () => void;
  insertSnippet: (snippet: string) => void;
  revealPosition: (line: number, column: number) => void;
  layoutEditor: () => void;
}

withDefaults(
  defineProps<{
    documentId: string;
    documentPath?: string | null;
    documentName?: string;
    modelValue?: string;
    theme?: TThemeMode;
    editorSettings: IEditorSettings;
    canRun?: boolean;
  }>(),
  {
    documentPath: null,
    documentName: '',
    modelValue: '',
    theme: 'dark',
    canRun: false,
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: string, metrics?: IDocumentMetrics];
  'cursor-position-change': [line: number, column: number];
  'selection-change': [selection: IEditorSelectionSummary | null];
  'open-terminal-request': [];
  'format-request': [];
  'command-palette-request': [];
  'run-request': [];
}>();

const innerEditorRef = ref<IEditorExpose | null>(null);

const focusEditor = (): void => {
  innerEditorRef.value?.focusEditor();
};

const insertSnippet = (snippet: string): void => {
  innerEditorRef.value?.insertSnippet(snippet);
};

const revealPosition = (line: number, column: number): void => {
  innerEditorRef.value?.revealPosition(line, column);
};

const layoutEditor = (): void => {
  innerEditorRef.value?.layoutEditor();
};

const handleModelValueChange = (value: string, metrics?: IDocumentMetrics): void => {
  emit('update:modelValue', value, metrics);
};

const handleCursorPositionChange = (line: number, column: number): void => {
  emit('cursor-position-change', line, column);
};

defineExpose<IEditorExpose>({
  focusEditor,
  insertSnippet,
  revealPosition,
  layoutEditor,
});
</script>
