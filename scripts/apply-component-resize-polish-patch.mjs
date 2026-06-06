#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const write = (path, value) => writeFileSync(resolve(root, path), value, 'utf8');

const fail = (path, label) => {
  throw new Error(`[component-resize-polish-patch] ${path} 未找到补丁锚点：${label}`);
};

const replaceRequired = (path, source, oldText, newText, label) => {
  if (source.includes(newText)) return source;
  if (!source.includes(oldText)) fail(path, label);
  return source.replace(oldText, newText);
};

const replaceOptional = (source, oldText, newText) =>
  source.includes(oldText) ? source.replace(oldText, newText) : source;

const updateFile = (path, updater) => {
  const before = read(path);
  const after = updater(before);
  if (after === before) {
    console.log(`[component-resize-polish-patch] ${path} 无需更新。`);
    return;
  }
  write(path, after);
  console.log(`[component-resize-polish-patch] 已更新 ${path}`);
};

updateFile('src/components/editor/CodeMirrorScriptEditor.vue', (source) => {
  let next = source;

  next = replaceRequired(
    'src/components/editor/CodeMirrorScriptEditor.vue',
    next,
    '<div class="shell-editor-surface codemirror-editor-surface relative h-full min-h-0 w-full bg-(--editor-bg)"',
    '<div data-shell-resize-responder class="shell-editor-surface codemirror-editor-surface relative h-full min-h-0 w-full bg-(--editor-bg)"',
    'CodeMirror root resize responder marker',
  );

  if (!next.includes("@/composables/useShellResizeFrameScheduler")) {
    next = replaceRequired(
      'src/components/editor/CodeMirrorScriptEditor.vue',
      next,
      "import EditorContextMenu from '@/components/editor/EditorContextMenu.vue';\n",
      "import EditorContextMenu from '@/components/editor/EditorContextMenu.vue';\nimport { useShellResizeFrameScheduler } from '@/composables/useShellResizeFrameScheduler';\n",
      'CodeMirror resize scheduler import',
    );
  }

  next = replaceOptional(
    next,
    "import {\n  SHELL_WINDOW_RESIZE_SETTLED_EVENT,\n  SHELL_WINDOW_RESIZE_START_EVENT,\n} from '@/utils/window-resize-events';\n",
    '',
  );

  if (!next.includes('useShellResizeFrameScheduler({')) {
    next = replaceRequired(
      'src/components/editor/CodeMirrorScriptEditor.vue',
      next,
      "const handleShellWindowResizeSettled = (): void => {\n  updatePreviousContainerSize();\n  // editorView 为 null 时 layout 是 no-op，因此直接以「是否存在编辑器」决定是否重排。\n  if (editorView !== null) scheduleEditorLayout();\n};\n",
      "const handleShellWindowResizeSettled = (): void => {\n  updatePreviousContainerSize();\n  // editorView 为 null 时 layout 是 no-op，因此直接以「是否存在编辑器」决定是否重排。\n  if (editorView !== null) scheduleEditorLayout();\n};\n\nuseShellResizeFrameScheduler({\n  onStart: handleShellWindowResizeStart,\n  onFrame: scheduleEditorLayout,\n  onSettled: handleShellWindowResizeSettled,\n  settledFrames: 3,\n});\n",
      'CodeMirror resize scheduler setup',
    );
  }

  next = replaceOptional(
    next,
    '  window.addEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);\n  window.addEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);\n',
    '',
  );
  next = replaceOptional(
    next,
    '  window.removeEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);\n  window.removeEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);\n',
    '',
  );

  return next;
});

updateFile('src/components/editor/ImageAssetPreview.vue', (source) =>
  replaceRequired(
    'src/components/editor/ImageAssetPreview.vue',
    source,
    '<div class="flex h-full min-h-0 flex-col bg-(--editor-bg)">',
    '<div data-shell-resize-responder class="image-asset-preview flex h-full min-h-0 flex-col bg-(--editor-bg)">',
    'image preview root resize responder marker',
  ),
);

updateFile('src/components/business/ai/shell/AiPanelFrame.vue', (source) =>
  replaceRequired(
    'src/components/business/ai/shell/AiPanelFrame.vue',
    source,
    '<section\n    class="ai-panel-frame"',
    '<section\n    data-shell-resize-responder\n    class="ai-panel-frame"',
    'AI panel frame resize responder marker',
  ),
);

updateFile('src/styles/app-shell.css', (source) => {
  let next = source;

  next = replaceRequired(
    'src/styles/app-shell.css',
    next,
    'html.is-resizing .git-diff-viewer,\nhtml.is-resizing .git-diff-viewer-surface {',
    'html.is-resizing .codemirror-editor-surface,\nhtml.is-resizing .shell-editor-surface,\nhtml.is-resizing .image-asset-preview,\nhtml.is-resizing .image-preview-frame,\nhtml.is-resizing .image-preview-asset,\nhtml.is-resizing .ai-panel-frame__body,\nhtml.is-resizing .ai-panel-frame__composer,\nhtml.is-resizing .git-diff-viewer,\nhtml.is-resizing .git-diff-viewer-surface {',
    'resize transition suppression selectors',
  );

  next = replaceRequired(
    'src/styles/app-shell.css',
    next,
    'html.is-resizing .ai-chat-list,\nhtml.is-resizing .embedded-terminal-shell,',
    'html.is-resizing .ai-chat-list,\nhtml.is-resizing .ai-panel-frame__body,\nhtml.is-resizing .ai-panel-frame__composer,\nhtml.is-resizing .codemirror-editor-surface,\nhtml.is-resizing .shell-editor-surface,\nhtml.is-resizing .image-asset-preview,\nhtml.is-resizing .embedded-terminal-shell,',
    'resize size stabilization selectors',
  );

  return next;
});

console.log('[component-resize-polish-patch] 完成。建议继续运行：pnpm typecheck && pnpm test && pnpm tauri:dev');
