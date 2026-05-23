<template>
  <ScriptEditor
ref="innerEditorRef" :document-path="documentPath" :document-name="documentName"
    :model-value="modelValue" :theme="theme" :can-run="canRun" :analysis="analysisState" :editor-settings="editorSettings"
    @update:model-value="handleModelValueChange" @cursor-position-change="handleCursorPositionChange"
    @selection-change="emit('selection-change', $event)" @open-terminal-request="emit('open-terminal-request')"
    @format-request="emit('format-request')" @command-palette-request="emit('command-palette-request')"
    @run-request="emit('run-request')" />
</template>

<script setup lang="ts">
import ScriptEditor from '@/components/editor/ScriptEditor.vue';
import { tauriService } from '@/services/tauri';
import type { IAiCodeActionRequest } from '@/types/ai';
import type { TThemeMode } from '@/types/app';
import type { IAnalyzeScriptPayload, IEditorSelectionSummary } from '@/types/editor';
import type { IEditorSettings } from '@/types/settings';
import { waitForDesktopRuntime } from '@/utils/desktop-runtime';
import { toErrorMessage } from '@/utils/error';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

const ANALYSIS_INITIAL_DELAY_MS = 90;
const ANALYSIS_TYPING_DELAY_MS = 420;

interface IEditorExpose {
  focusEditor: () => void;
  insertSnippet: (snippet: string) => void;
  revealPosition: (line: number, column: number) => void;
  rerunDiagnostics: () => void;
  layoutEditor: () => void;
  runAiCodeAction: (kind: IAiCodeActionRequest['kind']) => Promise<void>;
}

const props = withDefaults(
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
  'update:modelValue': [value: string];
  'cursor-position-change': [line: number, column: number];
  'selection-change': [selection: IEditorSelectionSummary | null];
  'diagnostics-change': [documentId: string, payload: IAnalyzeScriptPayload];
  'open-terminal-request': [];
  'format-request': [];
  'command-palette-request': [];
  'run-request': [];
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
let lastCompletedAnalysisRequestId = 0;
let isAnalysisInFlight = false;
let isUnmounted = false;

type TAnalysisSnapshot = {
  path: string | null;
  name: string | null;
  content: string;
};

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

const captureAnalysisSnapshot = (): TAnalysisSnapshot => ({
  path: props.documentPath ?? null,
  name: props.documentName ?? null,
  content: props.modelValue ?? '',
});

const runAnalysis = async (requestId: number): Promise<void> => {
  const snapshot = captureAnalysisSnapshot();

  if (!snapshot.content.trim()) {
    if (!isUnmounted && requestId === latestAnalysisRequestId) {
      clearAnalysis();
    }
    return;
  }

  const runtimeReady = await waitForDesktopRuntime(160);
  if (!runtimeReady) {
    if (!isUnmounted && requestId === latestAnalysisRequestId) {
      clearAnalysis();
    }
    return;
  }

  try {
    const payload = await tauriService.analyzeScript({
      path: snapshot.path,
      name: snapshot.name,
      content: snapshot.content,
    });

    if (isUnmounted || requestId !== latestAnalysisRequestId) {
      return;
    }

    emitAnalysis(payload);
  } catch (error) {
    if (isUnmounted || requestId !== latestAnalysisRequestId) {
      return;
    }

    emitAnalysis({
      available: false,
      message: toErrorMessage(error, 'ShellCheck 实时诊断失败。'),
      dialect: 'bash',
      diagnostics: [],
    });
  }
};

const drainAnalysisQueue = async (): Promise<void> => {
  if (isAnalysisInFlight) {
    return;
  }

  isAnalysisInFlight = true;

  try {
    while (!isUnmounted && lastCompletedAnalysisRequestId < latestAnalysisRequestId) {
      const requestId = latestAnalysisRequestId;
      await runAnalysis(requestId);
      lastCompletedAnalysisRequestId = requestId;
    }
  } finally {
    isAnalysisInFlight = false;

    if (!isUnmounted && lastCompletedAnalysisRequestId < latestAnalysisRequestId) {
      void drainAnalysisQueue();
    }
  }
};

const scheduleAnalysis = (delayMs = ANALYSIS_TYPING_DELAY_MS): void => {
  clearPendingAnalysisTimer();
  pendingAnalysisTimerId = window.setTimeout(() => {
    pendingAnalysisTimerId = null;
    latestAnalysisRequestId += 1;
    void drainAnalysisQueue();
  }, delayMs);
};

const rerunDiagnostics = (): void => {
  clearPendingAnalysisTimer();
  latestAnalysisRequestId += 1;
  void drainAnalysisQueue();
};

onMounted(() => {
  isUnmounted = false;
  scheduleAnalysis(ANALYSIS_INITIAL_DELAY_MS);
});

watch(
  () => [props.documentId, props.documentPath, props.documentName, props.modelValue],
  (nextValue, previousValue) => {
    const documentIdentityChanged =
      !previousValue ||
      nextValue[0] !== previousValue[0] ||
      nextValue[1] !== previousValue[1] ||
      nextValue[2] !== previousValue[2];

    scheduleAnalysis(
      documentIdentityChanged ? ANALYSIS_INITIAL_DELAY_MS : ANALYSIS_TYPING_DELAY_MS,
    );
  },
);

onBeforeUnmount(() => {
  isUnmounted = true;
  latestAnalysisRequestId += 1;
  clearPendingAnalysisTimer();
});

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

const runAiCodeAction = async (kind: IAiCodeActionRequest['kind']): Promise<void> => {
  await innerEditorRef.value?.runAiCodeAction(kind);
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
  revealPosition,
  rerunDiagnostics,
  layoutEditor,
  runAiCodeAction,
});
</script>
