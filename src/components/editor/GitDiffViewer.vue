<template>
  <section class="git-diff-viewer" aria-label="Git Diff Preview">
    <section v-if="preview.isEmpty" class="git-diff-viewer-empty">
      <strong>没有可显示的 Diff</strong>
      <p>当前文件在这个 Git 区域没有内容差异。</p>
    </section>
    <div v-else ref="diffHostRef" class="git-diff-viewer-surface"></div>
  </section>
</template>

<script setup lang="ts">
import { buildCodeMirrorSettingsExtensions } from '@/services/editor/codemirror-config';
import { resolveCodeMirrorLanguageExtension } from '@/services/editor/codemirror-language';
import type { TThemeMode } from '@/types/app';
import type { IGitDiffPreviewPayload } from '@/types/git';
import type { IEditorSettings } from '@/types/settings';
import { resolveLanguageForPath } from '@/utils/editor-language';
import { MergeView } from '@codemirror/merge';
import type { Extension } from '@codemirror/state';
import { EditorView, highlightSpecialChars } from '@codemirror/view';
import { githubLight } from '@fsegurai/codemirror-theme-github-light';
import { useResizeObserver } from '@vueuse/core';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{
  preview: IGitDiffPreviewPayload;
  theme: TThemeMode;
  editorSettings: IEditorSettings;
}>();

const diffHostRef = ref<HTMLElement | null>(null);

let mergeView: MergeView | null = null;
let layoutFrameId: number | null = null;

// ──────────────────────────────────────────────────────────────────────
// Extensions
// ──────────────────────────────────────────────────────────────────────
const buildDiffEditorExtensions = (language: string): Extension[] => [
  highlightSpecialChars(),
  githubLight,
  resolveCodeMirrorLanguageExtension(language),
  buildCodeMirrorSettingsExtensions(props.editorSettings, {
    activeLine: false,
    autoClosingPairs: false,
    editable: false,
    foldGutter: false,
    readOnly: true,
  }),
  EditorView.contentAttributes.of({ 'aria-readonly': 'true' }),
];

const buildMergeView = (host: HTMLElement): MergeView => {
  const language = resolveLanguageForPath(props.preview.relativePath);
  const extensions = buildDiffEditorExtensions(language);
  return new MergeView({
    a: { doc: props.preview.originalContent, extensions },
    b: { doc: props.preview.modifiedContent, extensions },
    collapseUnchanged: { margin: 3, minSize: 8 },
    diffConfig: { scanLimit: 1_000, timeout: 500 },
    gutter: true,
    highlightChanges: true,
    parent: host,
    // revertControls 留空即可，原值 undefined 已是默认行为
  });
};

// ──────────────────────────────────────────────────────────────────────
// Layout
// ──────────────────────────────────────────────────────────────────────
const layoutDiffEditor = (): boolean => {
  const host = diffHostRef.value;
  if (!host || !mergeView) return false;
  if (host.clientWidth <= 0 || host.clientHeight <= 0) return false;
  mergeView.a.requestMeasure();
  mergeView.b.requestMeasure();
  return true;
};

const scheduleLayout = (): void => {
  if (layoutFrameId !== null) {
    window.cancelAnimationFrame(layoutFrameId);
    layoutFrameId = null;
  }
  layoutFrameId = window.requestAnimationFrame(() => {
    layoutFrameId = null;
    layoutDiffEditor();
  });
};

// ──────────────────────────────────────────────────────────────────────
// Mount / dispose
//
// 关键修复：
//   1. dispose 必须调用 MergeView.destroy()，否则两个内部 EditorView 的
//      DOM / 事件 / observer 会泄漏，多次 remount 还会让 diff DOM 叠加。
//   2. ResizeObserver 只在 onMounted 注册一次；mountDiffEditor 自身不再
//      注册，避免每次 remount 累积。
// ──────────────────────────────────────────────────────────────────────
const disposeDiffEditor = (): void => {
  if (layoutFrameId !== null) {
    window.cancelAnimationFrame(layoutFrameId);
    layoutFrameId = null;
  }
  if (mergeView) {
    mergeView.destroy();
    mergeView = null;
  }
};

const mountDiffEditor = (): void => {
  const host = diffHostRef.value;
  if (!host || props.preview.isEmpty || mergeView) return;
  mergeView = buildMergeView(host);
  // MergeView 已挂载到 host；下一帧再 requestMeasure 拿到正确尺寸。
  scheduleLayout();
};

const remountDiffEditor = async (): Promise<void> => {
  disposeDiffEditor();
  // 等 DOM 反映 v-if/v-else 切换（preview.isEmpty 可能刚变化，
  // 导致 diffHostRef 这一帧还不存在）。
  await Promise.resolve();
  mountDiffEditor();
};

// ──────────────────────────────────────────────────────────────────────
// Lifecycle
// ──────────────────────────────────────────────────────────────────────
onMounted(() => {
  mountDiffEditor();
  // 全生命周期只注册一次；vueuse 会在 scope dispose 时自动 stop。
  useResizeObserver(diffHostRef, () => scheduleLayout());
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
    props.theme,
    props.editorSettings,
  ],
  () => {
    void remountDiffEditor();
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
  min-height: 0;
  height: 100%;
  flex: 1 1 auto;
  overflow: hidden;
}

.git-diff-viewer-surface :deep(.cm-mergeView) {
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: auto;
  outline: none;
}

.git-diff-viewer-surface :deep(.cm-mergeViewEditors) {
  height: 100%;
  min-height: 0;
}

.git-diff-viewer-surface :deep(.cm-mergeViewEditor) {
  min-width: 0;
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