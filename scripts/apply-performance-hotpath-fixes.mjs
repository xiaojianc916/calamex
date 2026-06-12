#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = process.cwd();

const filesTouched = new Set();

const readText = (relativePath) => {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
};

const writeText = (relativePath, content) => {
  writeFileSync(resolve(repoRoot, relativePath), content, 'utf8');
  filesTouched.add(relativePath);
};

const replaceOnce = (relativePath, source, target, label) => {
  const content = readText(relativePath);
  const occurrences = content.split(source).length - 1;

  if (occurrences !== 1) {
    throw new Error(
      `[${relativePath}] ${label} expected exactly 1 match, got ${occurrences}. ` +
        '文件内容可能已经变化，请先 git diff / git status 确认。',
    );
  }

  writeText(relativePath, content.replace(source, target));
};

const replaceAll = (relativePath, source, target, label) => {
  const content = readText(relativePath);
  const occurrences = content.split(source).length - 1;

  if (occurrences < 1) {
    throw new Error(
      `[${relativePath}] ${label} expected at least 1 match, got 0. ` +
        '文件内容可能已经变化，请先 git diff / git status 确认。',
    );
  }

  writeText(relativePath, content.split(source).join(target));
};

const assertContains = (relativePath, needle, label) => {
  const content = readText(relativePath);
  if (!content.includes(needle)) {
    throw new Error(`[${relativePath}] missing expected anchor: ${label}`);
  }
};

// ─────────────────────────────────────────────────────────────
// 1) Editor store: allow caller-provided exact metrics.
//    This removes full-document metric scanning from the typing hot path.
// ─────────────────────────────────────────────────────────────

{
  const path = 'src/store/editor.ts';

  replaceOnce(
    path,
    `import { computeDocumentMetrics } from '@/utils/document-metrics';`,
    `import { computeDocumentMetrics, type IDocumentMetrics } from '@/utils/document-metrics';`,
    'import IDocumentMetrics',
  );

  replaceOnce(
    path,
    `const syncDocumentState = (document: IEditorDocument): IEditorDocument => {
  if (document.kind === 'text' && document.bufferLoaded === false) {
    document.content = '';
    document.savedContent = '';
    document.isDirty = false;
    document.lineCount = 1;
    document.charCount = 0;
    return document;
  }

  const { lineCount, charCount } = computeDocumentMetrics(document.content);
  document.lineCount = lineCount;
  document.charCount = charCount;
  document.isDirty =
    document.content !== document.savedContent || document.encoding !== document.savedEncoding;
  return document;
};`,
    `const syncDocumentState = (
  document: IEditorDocument,
  metrics?: IDocumentMetrics,
): IEditorDocument => {
  if (document.kind === 'text' && document.bufferLoaded === false) {
    document.content = '';
    document.savedContent = '';
    document.isDirty = false;
    document.lineCount = 1;
    document.charCount = 0;
    return document;
  }

  const { lineCount, charCount } = metrics ?? computeDocumentMetrics(document.content);
  document.lineCount = lineCount;
  document.charCount = charCount;
  document.isDirty =
    document.content !== document.savedContent || document.encoding !== document.savedEncoding;
  return document;
};`,
    'syncDocumentState metrics parameter',
  );

  replaceOnce(
    path,
    `    const updateDocumentContent = (documentId: string, content: string): void => {
      const targetDocument = getDocumentById(documentId);
      if (targetDocument?.kind !== 'text') {
        return;
      }
      targetDocument.bufferLoaded = true;
      targetDocument.content = content;
      touchDocumentAccess(targetDocument);
      syncDocumentState(targetDocument);
      // 内容变更后维护未保存草稿(与磁盘基线 savedContent 比较),写入防抖见上。
      if (targetDocument.path) {
        scheduleDraftCapture(targetDocument.id);
      }
    };

    const updateActiveDocumentContent = (content: string): void => {
      updateDocumentContent(document.value.id, content);
    };`,
    `    const updateDocumentContentWithMetrics = (
      documentId: string,
      content: string,
      metrics: IDocumentMetrics,
    ): void => {
      const targetDocument = getDocumentById(documentId);
      if (targetDocument?.kind !== 'text') {
        return;
      }
      targetDocument.bufferLoaded = true;
      targetDocument.content = content;
      touchDocumentAccess(targetDocument);
      syncDocumentState(targetDocument, metrics);
      // 内容变更后维护未保存草稿(与磁盘基线 savedContent 比较),写入防抖见上。
      if (targetDocument.path) {
        scheduleDraftCapture(targetDocument.id);
      }
    };

    const updateDocumentContent = (documentId: string, content: string): void => {
      updateDocumentContentWithMetrics(documentId, content, computeDocumentMetrics(content));
    };

    const updateActiveDocumentContentWithMetrics = (
      content: string,
      metrics: IDocumentMetrics,
    ): void => {
      updateDocumentContentWithMetrics(document.value.id, content, metrics);
    };

    const updateActiveDocumentContent = (content: string): void => {
      updateDocumentContent(document.value.id, content);
    };`,
    'updateDocumentContentWithMetrics action',
  );

  replaceOnce(
    path,
    `      updateDocumentContent,
      updateActiveDocumentContent,
      updateDocumentEncoding,`,
    `      updateDocumentContent,
      updateDocumentContentWithMetrics,
      updateActiveDocumentContent,
      updateActiveDocumentContentWithMetrics,
      updateDocumentEncoding,`,
    'return metrics-aware editor actions',
  );
}

// ─────────────────────────────────────────────────────────────
// 2) CodeMirror editor: compute metrics incrementally from CM changes.
//    Keep exact Unicode code-point charCount semantics.
// ─────────────────────────────────────────────────────────────

{
  const path = 'src/components/editor/CodeMirrorScriptEditor.vue';

  replaceOnce(
    path,
    `import { tryReadClipboardText, writeClipboardText } from '@/utils/clipboard';
import { computeDocChanges } from '@/utils/editor-doc-diff';`,
    `import { tryReadClipboardText, writeClipboardText } from '@/utils/clipboard';
import { computeDocumentMetrics, type IDocumentMetrics } from '@/utils/document-metrics';
import { computeDocChanges } from '@/utils/editor-doc-diff';`,
    'import document metrics',
  );

  replaceOnce(
    path,
    `const emit = defineEmits<{
  'update:modelValue': [value: string];`,
    `const emit = defineEmits<{
  'update:modelValue': [value: string, metrics?: IDocumentMetrics];`,
    'emit metrics through update:modelValue',
  );

  replaceOnce(
    path,
    `let lastSyncedModelValue: string | null = null;
let previousContainerSize = { width: 0, height: 0 };`,
    `let lastSyncedModelValue: string | null = null;
let lastDocumentMetrics: IDocumentMetrics = computeDocumentMetrics(props.modelValue);
let previousContainerSize = { width: 0, height: 0 };`,
    'track last document metrics',
  );

  replaceOnce(
    path,
    `const getCurrentLanguage = (): string =>
  resolveLanguageForPath(props.documentPath, props.documentName);

// ──────────────────────────────
// Selection helpers
// ──────────────────────────────`,
    `const getCurrentLanguage = (): string =>
  resolveLanguageForPath(props.documentPath, props.documentName);

const normalizeDocumentMetrics = (metrics: IDocumentMetrics): IDocumentMetrics => ({
  lineCount: Math.max(1, metrics.lineCount),
  charCount: Math.max(0, metrics.charCount),
});

const applyDocumentMetricsFromChanges = (update: ViewUpdate): IDocumentMetrics => {
  let lineCount = lastDocumentMetrics.lineCount;
  let charCount = lastDocumentMetrics.charCount;

  update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const removedMetrics = computeDocumentMetrics(update.startState.doc.sliceString(fromA, toA));
    const insertedMetrics = computeDocumentMetrics(inserted.toString());

    lineCount += insertedMetrics.lineCount - removedMetrics.lineCount;
    charCount += insertedMetrics.charCount - removedMetrics.charCount;
  });

  lastDocumentMetrics = normalizeDocumentMetrics({ lineCount, charCount });
  return lastDocumentMetrics;
};

// ──────────────────────────────
// Selection helpers
// ──────────────────────────────`,
    'incremental document metrics helpers',
  );

  replaceOnce(
    path,
    `const handleEditorUpdate = (update: ViewUpdate): void => {
  if (update.docChanged && !suppressModelValueEmit) {
    closeContextMenu();
    const nextValue = update.state.doc.toString();
    // 记录本次对外同步的串,作为 v-model 回声的廉价判定依据(见 modelValue watcher)。
    lastSyncedModelValue = nextValue;
    emit('update:modelValue', nextValue);
  }`,
    `const handleEditorUpdate = (update: ViewUpdate): void => {
  if (update.docChanged && !suppressModelValueEmit) {
    closeContextMenu();
    const nextMetrics = applyDocumentMetricsFromChanges(update);
    const nextValue = update.state.doc.toString();
    // 记录本次对外同步的串,作为 v-model 回声的廉价判定依据(见 modelValue watcher)。
    lastSyncedModelValue = nextValue;
    emit('update:modelValue', nextValue, nextMetrics);
  }`,
    'emit incremental metrics on editor update',
  );

  replaceOnce(
    path,
    `  // 初始文档串与父组件 v-model 已对齐,记录为同步基线,避免首个 echo 误判。
  lastSyncedModelValue = props.modelValue;
  emitCursorPosition(editorView);`,
    `  // 初始文档串与父组件 v-model 已对齐,记录为同步基线,避免首个 echo 误判。
  lastSyncedModelValue = props.modelValue;
  lastDocumentMetrics = computeDocumentMetrics(props.modelValue);
  emitCursorPosition(editorView);`,
    'initialize document metrics on createEditor',
  );

  replaceOnce(
    path,
    `    if (current === value) {
      lastSyncedModelValue = value;
      return;
    }
    // 外部真正改了内容（载入文件 / 格式化 / AI 补丁等）：只替换最小变化区间,保留未变
    // 区域的折叠/选区,避免整篇替换清空这些状态。Myers 最短编辑脚本可产出多个
    // 互不相邻的最小变更区间，详见 utils/editor-doc-diff。
    lastSyncedModelValue = value;
    suppressModelValueEmit = true;`,
    `    if (current === value) {
      lastSyncedModelValue = value;
      lastDocumentMetrics = computeDocumentMetrics(value);
      return;
    }
    // 外部真正改了内容（载入文件 / 格式化 / AI 补丁等）：只替换最小变化区间,保留未变
    // 区域的折叠/选区,避免整篇替换清空这些状态。Myers 最短编辑脚本可产出多个
    // 互不相邻的最小变更区间，详见 utils/editor-doc-diff。
    lastSyncedModelValue = value;
    lastDocumentMetrics = computeDocumentMetrics(value);
    suppressModelValueEmit = true;`,
    'refresh metrics for external modelValue changes',
  );
}

// ─────────────────────────────────────────────────────────────
// 3) SmartScriptEditor: forward optional metrics upward.
// ─────────────────────────────────────────────────────────────

{
  const path = 'src/components/editor/SmartScriptEditor.vue';

  replaceOnce(
    path,
    `import { tauriService } from '@/services/tauri';
import type { TThemeMode } from '@/types/app';`,
    `import { tauriService } from '@/services/tauri';
import type { TThemeMode } from '@/types/app';
import type { IDocumentMetrics } from '@/utils/document-metrics';`,
    'import IDocumentMetrics in SmartScriptEditor',
  );

  replaceOnce(
    path,
    `const emit = defineEmits<{
  'update:modelValue': [value: string];`,
    `const emit = defineEmits<{
  'update:modelValue': [value: string, metrics?: IDocumentMetrics];`,
    'SmartScriptEditor emit metrics',
  );

  replaceOnce(
    path,
    `const handleModelValueChange = (value: string): void => {
  emit('update:modelValue', value);
};`,
    `const handleModelValueChange = (value: string, metrics?: IDocumentMetrics): void => {
  emit('update:modelValue', value, metrics);
};`,
    'SmartScriptEditor forward metrics',
  );
}

// ─────────────────────────────────────────────────────────────
// 4) Workbench: consume optional metrics and call metrics-aware store action.
// ─────────────────────────────────────────────────────────────

{
  const path = 'src/composables/useWorkbench.ts';

  replaceOnce(
    path,
    `import { isShellScriptPath } from '@/utils/file-assets';`,
    `import type { IDocumentMetrics } from '@/utils/document-metrics';
import { isShellScriptPath } from '@/utils/file-assets';`,
    'import IDocumentMetrics in useWorkbench',
  );

  replaceOnce(
    path,
    `  const updateContent = (value: string): void => {
    if (editorStore.document.bufferLoaded === false) {
      return;
    }
    editorStore.updateActiveDocumentContent(value);
  };`,
    `  const updateContent = (value: string, metrics?: IDocumentMetrics): void => {
    if (editorStore.document.bufferLoaded === false) {
      return;
    }
    if (metrics) {
      editorStore.updateActiveDocumentContentWithMetrics(value, metrics);
      return;
    }
    editorStore.updateActiveDocumentContent(value);
  };`,
    'useWorkbench consume metrics',
  );
}

// ─────────────────────────────────────────────────────────────
// 5) Search streaming: avoid copying all previous results on every batch.
// ─────────────────────────────────────────────────────────────

{
  const path = 'src/components/workbench/SearchSidebarPanel.vue';

  replaceOnce(
    path,
    `const handleSearchStreamEvent = (payload: IWorkspaceSearchStreamEvent): void => {
  if (payload.searchId !== streamingSearchId || payload.results.length === 0) return;
  backendResults.value = backendResults.value.concat(payload.results);
};`,
    `const handleSearchStreamEvent = (payload: IWorkspaceSearchStreamEvent): void => {
  if (payload.searchId !== streamingSearchId || payload.results.length === 0) return;
  backendResults.value.push(...payload.results);
};`,
    'append search stream batches without array copy',
  );
}

// ─────────────────────────────────────────────────────────────
// 6) Git PR background preload: keep list warm, do not compete with startup by
//    concurrently pulling many PR details.
// ─────────────────────────────────────────────────────────────

{
  const path = 'src/store/git.ts';

  replaceOnce(
    path,
    `      await loadPullRequests('open', {
        preloadDetails: true,
        updateActive: false,
        visibleLoading: false,
      });`,
    `      await loadPullRequests('open', {
        preloadDetails: false,
        updateActive: false,
        visibleLoading: false,
      });`,
    'disable background PR detail preload',
  );
}

// Basic post-change sanity anchors.

assertContains(
  'src/store/editor.ts',
  'updateActiveDocumentContentWithMetrics',
  'editor store metrics-aware action',
);

assertContains(
  'src/components/editor/CodeMirrorScriptEditor.vue',
  'applyDocumentMetricsFromChanges',
  'CodeMirror incremental metrics helper',
);

assertContains(
  'src/components/workbench/SearchSidebarPanel.vue',
  'backendResults.value.push(...payload.results);',
  'search stream push append',
);

assertContains(
  'src/store/git.ts',
  'preloadDetails: false',
  'background PR detail preload disabled',
);

console.log('Applied performance hot-path fixes:');
for (const file of [...filesTouched].sort()) {
  console.log(` - ${file}`);
}

console.log('');
console.log('Next:');
console.log('  pnpm typecheck');
console.log('  pnpm test');
console.log('');
console.log('Rollback if needed:');
console.log(
  '  git checkout -- src/store/editor.ts src/components/editor/CodeMirrorScriptEditor.vue src/components/editor/SmartScriptEditor.vue src/composables/useWorkbench.ts src/components/workbench/SearchSidebarPanel.vue src/store/git.ts',
);