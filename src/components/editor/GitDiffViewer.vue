<template>
  <section class="git-diff-viewer" aria-label="Git Diff Preview">
    <section v-if="preview.isEmpty" class="git-diff-viewer-empty">
      <strong>没有可显示的 Diff</strong>
      <p>当前文件在这个 Git 区域没有内容差异。</p>
    </section>

    <div v-else ref="diffHostRef" class="git-diff-viewer-surface" />
  </section>
</template>

<script setup lang="ts">
import type { TThemeMode } from '@/types/app';
import type { IGitDiffPreviewPayload } from '@/types/git';
import type { IEditorSettings } from '@/types/settings';
import { applyShikiTheme, ensureShikiLanguageLoaded } from '@/services/editor/monaco-shiki';
import { applyMonacoTheme, monaco, resolveLanguageForPath } from '@/utils/monaco';
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const DEFAULT_DIFF_EDITOR_FONT_FAMILY =
  "Berkeley Mono, JetBrains Mono, Consolas, 'Courier New', monospace";


const props = defineProps<{
  preview: IGitDiffPreviewPayload;
  theme: TThemeMode;
  editorSettings: IEditorSettings;
}>();

const diffHostRef = ref<HTMLElement | null>(null);

let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
let originalModel: monaco.editor.ITextModel | null = null;
let modifiedModel: monaco.editor.ITextModel | null = null;
let resizeObserver: ResizeObserver | null = null;
let layoutFrameId: number | null = null;
let pendingLayoutRetryId: number | null = null;

const resolveEditorFontFamily = (fontFamily: string): string => {
  const normalizedFontFamily = fontFamily.trim();
  return normalizedFontFamily.length > 0
    ? `${normalizedFontFamily}, ${DEFAULT_DIFF_EDITOR_FONT_FAMILY}`
    : DEFAULT_DIFF_EDITOR_FONT_FAMILY;
};

const resolveLineHeight = (
  fontSize: number,
  lineHeight: IEditorSettings['lineHeight'],
): number => Math.max(fontSize + 4, Math.round(fontSize * Number(lineHeight)));

const resolveLineNumbers = (enabled: boolean): 'off' | 'on' => (enabled ? 'on' : 'off');

const resolveRuntimeOptions = (): monaco.editor.IDiffEditorConstructionOptions => ({
  automaticLayout: false,
  contextmenu: false,
  diffWordWrap: 'on',
  enableSplitViewResizing: true,
  fixedOverflowWidgets: true,
  fontFamily: resolveEditorFontFamily(props.editorSettings.fontFamily),
  fontLigatures: props.editorSettings.fontLigatures,
  fontSize: props.editorSettings.fontSize,
  lineDecorationsWidth: 16,
  lineHeight: resolveLineHeight(props.editorSettings.fontSize, props.editorSettings.lineHeight),
  lineNumbers: resolveLineNumbers(props.editorSettings.lineNumbers),
  lineNumbersMinChars: 3,
  minimap: { enabled: props.editorSettings.minimap },
  originalEditable: false,
  renderOverviewRuler: false,
  'semanticHighlighting.enabled': false,
  overviewRulerBorder: false,
  padding: {
    top: 0,
    bottom: 0,
  },
  readOnly: true,
  renderSideBySide: true,
  roundedSelection: false,
  scrollBeyondLastLine: false,
  scrollbar: {
    verticalScrollbarSize: 6,
    horizontalScrollbarSize: 6,
    useShadows: false,
  },
  useInlineViewWhenSpaceIsLimited: false,
  useShadowDOM: false,
  wordWrap: 'on',
  wrappingIndent: 'same',
});

const layoutDiffEditor = (): boolean => {
  const host = diffHostRef.value;
  if (!host || !diffEditor) {
    return false;
  }

  const width = Math.floor(host.clientWidth);
  const height = Math.floor(host.clientHeight);
  if (width <= 0 || height <= 0) {
    return false;
  }

  diffEditor.layout({ width, height });
  return true;
};

const clearLayoutRetry = (): void => {
  if (pendingLayoutRetryId !== null) {
    window.clearTimeout(pendingLayoutRetryId);
    pendingLayoutRetryId = null;
  }
};

const scheduleLayout = (retryWhenEmpty = true): void => {
  if (layoutFrameId !== null) {
    window.cancelAnimationFrame(layoutFrameId);
  }

  layoutFrameId = window.requestAnimationFrame(() => {
    layoutFrameId = null;
    clearLayoutRetry();
    const didLayout = layoutDiffEditor();
    if (!didLayout && retryWhenEmpty) {
      pendingLayoutRetryId = window.setTimeout(() => {
        pendingLayoutRetryId = null;
        scheduleLayout(false);
      }, 32);
    }
  });
};

const disposeModels = (): void => {
  originalModel?.dispose();
  modifiedModel?.dispose();
  originalModel = null;
  modifiedModel = null;
};

const syncModels = async (
  targetDiffEditor: monaco.editor.IStandaloneDiffEditor,
): Promise<void> => {
  if (props.preview.isEmpty) {
    return;
  }

  disposeModels();
  const language = resolveLanguageForPath(props.preview.relativePath);
  await ensureShikiLanguageLoaded(language).catch((error) => {
    console.error('Shiki 语法加载失败', error);
  });

  if (diffEditor !== targetDiffEditor) {
    return;
  }

  originalModel = monaco.editor.createModel(props.preview.originalContent, language);
  modifiedModel = monaco.editor.createModel(props.preview.modifiedContent, language);
  targetDiffEditor.setModel({
    original: originalModel,
    modified: modifiedModel,
  });
  scheduleLayout();
};

const mountDiffEditor = async (): Promise<void> => {
  const host = diffHostRef.value;
  if (!host || props.preview.isEmpty) {
    return;
  }

  applyMonacoTheme(props.theme);
  applyShikiTheme();
  diffEditor = monaco.editor.createDiffEditor(host, resolveRuntimeOptions());
  await syncModels(diffEditor);
  await nextTick();
  scheduleLayout();
  window.requestAnimationFrame(() => scheduleLayout());

  resizeObserver = new ResizeObserver(() => scheduleLayout());
  resizeObserver.observe(host);
};

const disposeDiffEditor = (): void => {
  if (layoutFrameId !== null) {
    window.cancelAnimationFrame(layoutFrameId);
    layoutFrameId = null;
  }
  clearLayoutRetry();

  resizeObserver?.disconnect();
  resizeObserver = null;
  diffEditor?.dispose();
  diffEditor = null;
  disposeModels();
};

onMounted(() => {
  void mountDiffEditor();
});

onBeforeUnmount(() => {
  disposeDiffEditor();
});

watch(
  () => [
    props.preview.id,
    props.preview.originalContent,
    props.preview.modifiedContent,
    props.preview.isEmpty,
  ],
  async () => {
    disposeDiffEditor();
    await nextTick();
    await mountDiffEditor();
  },
);

watch(
  () => props.theme,
  () => {
    applyMonacoTheme(props.theme);
    applyShikiTheme();
    scheduleLayout();
  },
);

watch(
  () => props.editorSettings,
  () => {
    diffEditor?.updateOptions(resolveRuntimeOptions());
    scheduleLayout();
  },
  { deep: true },
);
</script>

<style scoped>
.git-diff-viewer {
  display: flex;
  min-height: 0;
  height: 100%;
  flex-direction: column;
  background: var(--editor-bg);
  color: var(--text-primary);
}

.git-diff-viewer-surface {
  --vscode-sash-hover-size: var(--diff-resize-handle-width);

  min-height: 0;
  height: 100%;
  flex: 1 1 auto;
  overflow: hidden;
}

.git-diff-viewer-surface :global(.monaco-diff-editor) {
  width: 100%;
  height: 100%;
  outline: none;
}

.git-diff-viewer-empty {
  display: grid;
  min-height: 0;
  flex: 1;
  place-content: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-xl);
  text-align: center;
}

.git-diff-viewer-empty strong {
  font-size: var(--font-size-base);
  font-weight: 600;
}

.git-diff-viewer-empty p {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
}
</style>
