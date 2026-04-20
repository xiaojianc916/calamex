<template>
  <ScriptEditor
ref="innerEditorRef" :model-value="modelValue" :theme="theme" :analysis="analysisState"
    :editor-settings="editorSettings"
    :git-baseline="gitBaseline" @update:model-value="handleModelValueChange"
    @cursor-position-change="handleCursorPositionChange" @format-request="emit('format-request')" />
</template>

<script setup lang="ts">
import ScriptEditor from '@/components/editor/ScriptEditor.vue';
import { tauriService } from '@/services/tauri';
import { useGitStore } from '@/store/git';
import type { TThemeMode } from '@/types/app';
import type { IAnalyzeScriptPayload } from '@/types/editor';
import type { IGitFileBaselinePayload } from '@/types/git';
import type { IEditorSettings } from '@/types/settings';
import { waitForDesktopRuntime } from '@/utils/desktop-runtime';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

const ANALYSIS_INITIAL_DELAY_MS = 90;
const ANALYSIS_TYPING_DELAY_MS = 420;

interface IEditorExpose {
  focusEditor: () => void;
  insertSnippet: (snippet: string) => void;
  revealPosition: (line: number, column: number) => void;
  rerunDiagnostics: () => void;
}

const props = withDefaults(
  defineProps<{
    documentId: string;
    documentPath?: string | null;
    documentName?: string;
    modelValue?: string;
    theme?: TThemeMode;
    editorSettings: IEditorSettings;
  }>(),
  {
    documentPath: null,
    documentName: '',
    modelValue: '',
    theme: 'dark',
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
  'cursor-position-change': [line: number, column: number];
  'diagnostics-change': [documentId: string, payload: IAnalyzeScriptPayload];
  'format-request': [];
}>();

const innerEditorRef = ref<IEditorExpose | null>(null);
const analysisState = ref<IAnalyzeScriptPayload>({
  available: true,
  message: null,
  dialect: 'bash',
  diagnostics: [],
});
const gitBaseline = ref<IGitFileBaselinePayload | null>(null);
const gitStore = useGitStore();

let pendingAnalysisTimerId: number | null = null;
let latestAnalysisRequestId = 0;
let lastCompletedAnalysisRequestId = 0;
let isAnalysisInFlight = false;
let isUnmounted = false;
let latestGitBaselineRequestId = 0;

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

const clearGitBaseline = (): void => {
  gitBaseline.value = null;
};

const loadGitBaseline = async (requestId: number): Promise<void> => {
  const documentPath = props.documentPath;
  if (!documentPath) {
    clearGitBaseline();
    return;
  }

  const runtimeReady = await waitForDesktopRuntime(120);
  if (!runtimeReady) {
    clearGitBaseline();
    return;
  }

  try {
    const payload = await gitStore.getFileBaseline(documentPath);
    if (isUnmounted || requestId !== latestGitBaselineRequestId) {
      return;
    }

    gitBaseline.value = payload;
  } catch {
    if (isUnmounted || requestId !== latestGitBaselineRequestId) {
      return;
    }

    clearGitBaseline();
  }
};

const scheduleGitBaselineLoad = (): void => {
  latestGitBaselineRequestId += 1;
  void loadGitBaseline(latestGitBaselineRequestId);
};

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
      message: error instanceof Error ? error.message : 'ShellCheck 实时诊断失败。',
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
  scheduleGitBaselineLoad();
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

watch(
  () => [props.documentPath, gitStore.baselineEpoch],
  () => {
    scheduleGitBaselineLoad();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  isUnmounted = true;
  latestAnalysisRequestId += 1;
  latestGitBaselineRequestId += 1;
  clearPendingAnalysisTimer();
  clearGitBaseline();
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
});
</script>
