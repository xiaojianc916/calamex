<template>
  <ScriptEditor
    ref="innerEditorRef"
    :model-value="modelValue"
    :theme="theme"
    :analysis="analysisState"
    @update:model-value="handleModelValueChange"
    @cursor-position-change="handleCursorPositionChange"
  />
</template>

<script setup lang="ts">
import ScriptEditor from '@/components/editor/ScriptEditor.vue';
import { tauriService } from '@/services/tauri';
import type { TThemeMode } from '@/types/app';
import type { IAnalyzeScriptPayload } from '@/types/editor';
import { waitForDesktopRuntime } from '@/utils/desktop-runtime';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

interface IEditorExpose {
  focusEditor: () => void;
  insertSnippet: (snippet: string) => void;
}

const props = withDefaults(
  defineProps<{
    documentId: string;
    documentPath?: string | null;
    documentName?: string;
    modelValue?: string;
    theme?: TThemeMode;
  }>(),
  {
    modelValue: '',
    theme: 'dark',
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
  'cursor-position-change': [line: number, column: number];
  'diagnostics-change': [documentId: string, payload: IAnalyzeScriptPayload];
}>();

const innerEditorRef = ref<IEditorExpose | null>(null);
const analysisState = ref<IAnalyzeScriptPayload>({
  available: true,
  message: null,
  dialect: 'bash',
  diagnostics: [],
});

let pendingAnalysisTimerId: number | null = null;
let latestAnalysisRequestId = 0;

const clearPendingAnalysisTimer = (): void => {
  if (pendingAnalysisTimerId !== null) {
    window.clearTimeout(pendingAnalysisTimerId);
    pendingAnalysisTimerId = null;
  }
};

const emitAnalysis = (payload: IAnalyzeScriptPayload): void => {
  analysisState.value = payload;
  emit('diagnostics-change', props.documentId, payload);
};

const clearAnalysis = (): void => {
  emitAnalysis({
    available: true,
    message: null,
    dialect: 'bash',
    diagnostics: [],
  });
};

const runAnalysis = async (): Promise<void> => {
  const requestId = ++latestAnalysisRequestId;
  const content = props.modelValue ?? '';

  if (!content.trim()) {
    clearAnalysis();
    return;
  }

  const runtimeReady = await waitForDesktopRuntime(160);
  if (!runtimeReady) {
    if (requestId === latestAnalysisRequestId) {
      clearAnalysis();
    }
    return;
  }

  try {
    const payload = await tauriService.analyzeScript({
      path: props.documentPath ?? null,
      name: props.documentName ?? null,
      content,
    });

    if (requestId !== latestAnalysisRequestId) {
      return;
    }

    emitAnalysis(payload);
  } catch (error) {
    if (requestId !== latestAnalysisRequestId) {
      return;
    }

    emitAnalysis({
      available: false,
      message: error instanceof Error ? error.message : 'ShellCheck 实时诊断失败。',
      dialect: 'bash',
      diagnostics: [],
    });
  }
};

const scheduleAnalysis = (): void => {
  clearPendingAnalysisTimer();
  pendingAnalysisTimerId = window.setTimeout(() => {
    pendingAnalysisTimerId = null;
    void runAnalysis();
  }, 320);
};

onMounted(() => {
  scheduleAnalysis();
});

watch(
  () => [props.documentId, props.documentPath, props.documentName, props.modelValue],
  () => {
    scheduleAnalysis();
  },
);

onBeforeUnmount(() => {
  latestAnalysisRequestId += 1;
  clearPendingAnalysisTimer();
});

const focusEditor = (): void => {
  innerEditorRef.value?.focusEditor();
};

const insertSnippet = (snippet: string): void => {
  innerEditorRef.value?.insertSnippet(snippet);
};

const handleModelValueChange = (value: string): void => {
  emit('update:modelValue', value);
};

const handleCursorPositionChange = (line: number, column: number): void => {
  emit('cursor-position-change', line, column);
};

defineExpose<IEditorExpose>({
  focusEditor,
  insertSnippet,
});
</script>
