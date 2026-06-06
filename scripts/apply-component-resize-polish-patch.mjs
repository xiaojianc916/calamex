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

const ensureImport = (path, source, importLine) => {
  if (source.includes(importLine)) return source;
  const matches = [...source.matchAll(/^import[\s\S]*?;\n/gm)];
  if (matches.length === 0) fail(path, `import insertion for ${importLine}`);
  const last = matches.at(-1);
  const insertAt = last.index + last[0].length;
  return `${source.slice(0, insertAt)}${importLine}\n${source.slice(insertAt)}`;
};

const removeWindowResizeEventsImport = (source) =>
  source.replace(
    /import \{\n\s*SHELL_WINDOW_RESIZE_SETTLED_EVENT,\n\s*SHELL_WINDOW_RESIZE_START_EVENT,\n\} from '@\/utils\/window-resize-events';\n/g,
    '',
  );

updateFile('src/components/editor/CodeMirrorScriptEditor.vue', (source) => {
  let next = source;

  next = replaceRequired(
    'src/components/editor/CodeMirrorScriptEditor.vue',
    next,
    '<div class="shell-editor-surface codemirror-editor-surface relative h-full min-h-0 w-full bg-(--editor-bg)"',
    '<div data-shell-resize-responder class="shell-editor-surface codemirror-editor-surface relative h-full min-h-0 w-full bg-(--editor-bg)"',
    'CodeMirror root resize responder marker',
  );

  next = ensureImport(
    'src/components/editor/CodeMirrorScriptEditor.vue',
    next,
    "import { useShellResizeFrameScheduler } from '@/composables/useShellResizeFrameScheduler';",
  );

  next = removeWindowResizeEventsImport(next);

  if (!next.includes('useShellResizeFrameScheduler({')) {
    next = replaceRequired(
      'src/components/editor/CodeMirrorScriptEditor.vue',
      next,
      `const handleShellWindowResizeSettled = (): void => {
  updatePreviousContainerSize();
  // editorView 为 null 时 layout 是 no-op，因此直接以「是否存在编辑器」决定是否重排。
  if (editorView !== null) scheduleEditorLayout();
};
`,
      `const handleShellWindowResizeSettled = (): void => {
  updatePreviousContainerSize();
  // editorView 为 null 时 layout 是 no-op，因此直接以「是否存在编辑器」决定是否重排。
  if (editorView !== null) scheduleEditorLayout();
};

useShellResizeFrameScheduler({
  onStart: handleShellWindowResizeStart,
  onFrame: scheduleEditorLayout,
  onSettled: handleShellWindowResizeSettled,
  settledFrames: 3,
});
`,
      'CodeMirror resize scheduler setup',
    );
  }

  next = replaceOptional(
    next,
    `  window.addEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);
  window.addEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);
`,
    '',
  );
  next = replaceOptional(
    next,
    `  window.removeEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);
  window.removeEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);
`,
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
    `<section
    class="ai-panel-frame"`,
    `<section
    data-shell-resize-responder
    class="ai-panel-frame"`,
    'AI panel frame resize responder marker',
  ),
);

updateFile('src/styles/app-shell.css', (source) => {
  let next = source;

  next = replaceRequired(
    'src/styles/app-shell.css',
    next,
    `html.is-resizing .git-diff-viewer,
html.is-resizing .git-diff-viewer-surface {`,
    `html.is-resizing .codemirror-editor-surface,
html.is-resizing .shell-editor-surface,
html.is-resizing .image-asset-preview,
html.is-resizing .image-preview-frame,
html.is-resizing .image-preview-asset,
html.is-resizing .ai-panel-frame__body,
html.is-resizing .ai-panel-frame__composer,
html.is-resizing .git-diff-viewer,
html.is-resizing .git-diff-viewer-surface {`,
    'resize transition suppression selectors',
  );

  next = replaceRequired(
    'src/styles/app-shell.css',
    next,
    `html.is-resizing .ai-chat-list,
html.is-resizing .embedded-terminal-shell,`,
    `html.is-resizing .ai-chat-list,
html.is-resizing .ai-panel-frame__body,
html.is-resizing .ai-panel-frame__composer,
html.is-resizing .codemirror-editor-surface,
html.is-resizing .shell-editor-surface,
html.is-resizing .image-asset-preview,
html.is-resizing .embedded-terminal-shell,`,
    'resize size stabilization selectors',
  );

  return next;
});

console.log('[component-resize-polish-patch] 完成。建议继续运行：pnpm typecheck && pnpm test && pnpm tauri:dev');
