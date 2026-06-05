#!/usr/bin/env node
/**
 * apply-editor-fixes.mjs — 编辑器相关代码精读修复批量应用
 * 机制: 缩进容错的整块匹配替换; 命中必须唯一; 写盘前生成 .bak; 按文件原子写入(临时文件+rename)。
 * 退出码: 任意编辑未命中/不唯一 => 1。
 */
import { readFile, writeFile, rename, copyFile } from 'node:fs/promises';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const ROOT = argv.find((a) => !a.startsWith('--')) ?? 'D:\\com.xiaojianc\\my_desktop_app';

const edits = {
  'src/components/editor/CodeMirrorScriptEditor.vue': [
    {
      id: 'E4-import',
      find: `import {
  SHELL_WINDOW_RESIZE_END_EVENT,
  SHELL_WINDOW_RESIZE_SETTLED_EVENT,
  SHELL_WINDOW_RESIZE_START_EVENT,
} from '@/utils/window-resize-events';`,
      replace: `import {
  SHELL_WINDOW_RESIZE_SETTLED_EVENT,
  SHELL_WINDOW_RESIZE_START_EVENT,
} from '@/utils/window-resize-events';`,
    },
    {
      id: 'E4-state',
      find: `let isShellWindowResizing = false;
let pendingEditorLayoutAfterWindowResize = false;`,
      replace: `let isShellWindowResizing = false;`,
    },
    {
      id: 'E4-scheduleLayout',
      find: `const scheduleEditorLayout = (): void => {
  if (isShellWindowResizing) {
    pendingEditorLayoutAfterWindowResize = true;
    return;
  }
  if (editorLayoutFrameId !== null) return;`,
      replace: `const scheduleEditorLayout = (): void => {
  // 窗口拖拽缩放期间不逐帧重排，统一在 settled 后做一次重排。
  if (isShellWindowResizing) return;
  if (editorLayoutFrameId !== null) return;`,
    },
    {
      id: 'E4-resizeStart',
      find: `const handleShellWindowResizeStart = (): void => {
  isShellWindowResizing = true;
  pendingEditorLayoutAfterWindowResize = false;
  if (editorLayoutFrameId !== null) {`,
      replace: `const handleShellWindowResizeStart = (): void => {
  isShellWindowResizing = true;
  if (editorLayoutFrameId !== null) {`,
    },
    {
      id: 'E4-resizeEndSettled',
      find: `const handleShellWindowResizeEnd = (): void => {
  // 等价于原版的 (= false; = shouldRelayout) 序列，但去掉中间被立即覆盖的死代码。
  // 语义：只要当前有 editor 或之前已经标记了待重排，就在 settled 时重排。
  pendingEditorLayoutAfterWindowResize ||= editorView !== null;
};

const handleShellWindowResizeSettled = (): void => {
  isShellWindowResizing = false;
  updatePreviousContainerSize();
  const shouldRelayout = pendingEditorLayoutAfterWindowResize || editorView !== null;
  pendingEditorLayoutAfterWindowResize = false;
  if (shouldRelayout) scheduleEditorLayout();
};`,
      replace: `const handleShellWindowResizeSettled = (): void => {
  isShellWindowResizing = false;
  updatePreviousContainerSize();
  // editorView 为 null 时 layout 是 no-op，因此直接以「是否存在编辑器」决定是否重排。
  if (editorView !== null) scheduleEditorLayout();
};`,
    },
    {
      id: 'E5-fn',
      find: `const handleWindowResize = (): void => {
  if (contextMenuState.value.open) closeContextMenu();
};`,
      replace: `const closeMenuOnWindowChange = (): void => {
  if (contextMenuState.value.open) closeContextMenu();
};`,
    },
    {
      id: 'E1-cut',
      find: `  if (!selectedText) return;
  await writeClipboardText(selectedText);
  view.dispatch({
    changes: ranges.map((range) => ({ from: range.from, to: range.to, insert: '' })),
  });
};`,
      replace: `  if (!selectedText) return;
  await writeClipboardText(selectedText);
  // 写剪贴板会让出事件循环，await 之前捕获的 ranges 可能已过期(文档被改)；用过期偏移删除
  // 会误删甚至越界。改用「当前」选区删除(replaceSelection 支持多选区)；写剪贴板若失败会在
  // 此之前抛出、不会执行删除，避免静默丢数据。
  const liveView = editorView;
  if (!liveView) return;
  liveView.dispatch(liveView.state.replaceSelection(''));
};`,
    },
    {
      id: 'E6-sync',
      find: `        const to = Math.max(from + 1, lineColumnToOffset(view, item.endLine, item.endColumn));
        return {
          from,
          to: Math.min(to, view.state.doc.length),
          severity: toDiagnosticSeverity(item.level),`,
      replace: `        const to = Math.max(from + 1, lineColumnToOffset(view, item.endLine, item.endColumn));
        return {
          from,
          // 越界裁剪统一交给 applyDiagnostics(合并 shellcheck/lsp 后按当时文档长度兜底)，此处不再重复。
          to,
          severity: toDiagnosticSeverity(item.level),`,
    },
    {
      id: 'E3-reconfLang',
      find: `  const language = getCurrentLanguage();
  inlineCompletionController.clear();
  view.dispatch({
    effects: [
      languageCompartment.reconfigure(resolveCodeMirrorLanguageExtension(language)),
      completionCompartment.reconfigure(
        buildCompletionExtension(props.editorSettings, language, currentLsp?.completionSource),
      ),
      setShikiLanguage(language),
    ],
  });
  applyLanguageExtension(language);
};`,
      replace: `  const language = getCurrentLanguage();
  inlineCompletionController.clear();
  // 不在此处 reconfigure 补全：紧随其后调用的 reconfigureLsp 会用「新」LSP 的 completionSource
  // 统一重配补全。这里若先配一次，用的还是旧文件的 LSP 源，纯属多余 dispatch。
  view.dispatch({
    effects: [
      languageCompartment.reconfigure(resolveCodeMirrorLanguageExtension(language)),
      setShikiLanguage(language),
    ],
  });
  applyLanguageExtension(language);
};`,
    },
    {
      id: 'E2-reconfLsp',
      find: `  if (currentLsp && view) {
    currentLsp.attach(view);
  }`,
      replace: `  if (currentLsp) {
    currentLsp.attach(view);
  }`,
    },
    {
      id: 'E4E5-onMounted',
      find: `  window.addEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);
  window.addEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleShellWindowResizeEnd);
  window.addEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);
  window.addEventListener('pointerdown', handleWindowPointerDown, true);
  window.addEventListener('keydown', handleWindowKeydown);
  window.addEventListener('resize', handleWindowResize);
  window.addEventListener('blur', handleWindowResize);`,
      replace: `  window.addEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);
  window.addEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);
  window.addEventListener('pointerdown', handleWindowPointerDown, true);
  window.addEventListener('keydown', handleWindowKeydown);
  window.addEventListener('resize', closeMenuOnWindowChange);
  window.addEventListener('blur', closeMenuOnWindowChange);`,
    },
    {
      id: 'E4E5-onUnmount',
      find: `  window.removeEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);
  window.removeEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleShellWindowResizeEnd);
  window.removeEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);
  window.removeEventListener('pointerdown', handleWindowPointerDown, true);
  window.removeEventListener('keydown', handleWindowKeydown);
  window.removeEventListener('resize', handleWindowResize);
  window.removeEventListener('blur', handleWindowResize);`,
      replace: `  window.removeEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);
  window.removeEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);
  window.removeEventListener('pointerdown', handleWindowPointerDown, true);
  window.removeEventListener('keydown', handleWindowKeydown);
  window.removeEventListener('resize', closeMenuOnWindowChange);
  window.removeEventListener('blur', closeMenuOnWindowChange);`,
    },
    {
      id: 'E7-vars',
      find: `<style>
/* CM6 补全 / hover 全局样式(非 scoped — 弹窗在 body，不在组件 DOM 内)
   主色纯白 #ffffff，图标 Lucide，颜色按语义区分 */

/* 弹窗：纯白卡片 */
.cm-tooltip.cm-tooltip.cm-tooltip-autocomplete {
  background: #ffffff;
  border: 1px solid #e6e8eb;
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12), 0 0 0 0.5px rgba(15, 23, 42, 0.04);
  padding: 4px;
}`,
      replace: `<style>
/* CM6 补全 / hover 全局样式(非 scoped — 弹窗在 body，不在组件 DOM 内)
   编辑器整体刻意恒为 github-light(见 shikiEditorChromeTheme)，弹窗同样恒为浅色，
   与应用深浅主题无关。重复的卡片表面/描边/阴影集中为变量，便于统一维护。 */
.cm-tooltip-autocomplete,
.cm-tooltip-hover,
.cm-completionInfo {
  --cm-popup-surface: #ffffff;
  --cm-popup-border: #e6e8eb;
  --cm-popup-shadow: 0 10px 30px rgba(15, 23, 42, 0.12);
}

/* 弹窗：纯白卡片 */
.cm-tooltip.cm-tooltip.cm-tooltip-autocomplete {
  background: var(--cm-popup-surface);
  border: 1px solid var(--cm-popup-border);
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12), 0 0 0 0.5px rgba(15, 23, 42, 0.04);
  padding: 4px;
}`,
    },
    {
      id: 'E7-ulbg',
      find: `.cm-tooltip.cm-tooltip.cm-tooltip-autocomplete>ul {
  background: #ffffff;
}`,
      replace: `.cm-tooltip.cm-tooltip.cm-tooltip-autocomplete>ul {
  background: var(--cm-popup-surface);
}`,
    },
    {
      id: 'E7-info',
      find: `.cm-tooltip.cm-completionInfo,
.cm-tooltip-autocomplete .cm-completionInfo {
  margin-left: 6px;
  padding: 10px 12px;
  max-width: none;
  background: #ffffff;
  border: 1px solid #e6e8eb;
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12);
  color: #475467;
}`,
      replace: `.cm-tooltip.cm-completionInfo,
.cm-tooltip-autocomplete .cm-completionInfo {
  margin-left: 6px;
  padding: 10px 12px;
  max-width: none;
  background: var(--cm-popup-surface);
  border: 1px solid var(--cm-popup-border);
  border-radius: 10px;
  box-shadow: var(--cm-popup-shadow);
  color: #475467;
}`,
    },
    {
      id: 'E7-hover',
      find: `.cm-tooltip.cm-tooltip-hover {
  background: #ffffff;
  border: 1px solid #e6e8eb;
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12);
}`,
      replace: `.cm-tooltip.cm-tooltip-hover {
  background: var(--cm-popup-surface);
  border: 1px solid var(--cm-popup-border);
  border-radius: 10px;
  box-shadow: var(--cm-popup-shadow);
}`,
    },
  ],
  'src/services/editor/codemirror-inline-completion.ts': [
    {
      id: 'E8-contexts',
      find: `const resolveInlineCompletionContexts = (
  view: EditorView,
  cursorOffset: number,
): { prefix: string; suffix: string } => {
  const prefixStart = Math.max(0, cursorOffset - INLINE_COMPLETION_CONTEXT_CODE_UNIT_WINDOW);
  return {
    prefix: clipInlineContext(
      view.state.doc.sliceString(prefixStart, cursorOffset),
      INLINE_COMPLETION_CONTEXT_LIMIT,
    ),
    suffix: view.state.doc.sliceString(
      cursorOffset,
      cursorOffset + INLINE_COMPLETION_CONTEXT_LIMIT,
    ),
  };
};`,
      replace: `// 从字符串「开头」保留至多 limit 个码点，且不在末尾切断一个代理对(与 clipInlineContext 对称，
// 后者从结尾保留)。用于裁剪光标右侧的 suffix 上下文。
export const clipInlineContextTrailing = (value: string, limit: number): string => {
  if (limit <= 0 || value.length === 0) {
    return '';
  }
  let codePoints = 0;
  let end = 0;
  while (end < value.length && codePoints < limit) {
    const code = value.charCodeAt(end);
    if (code >= 0xd800 && code <= 0xdbff && end + 1 < value.length) {
      const nextCode = value.charCodeAt(end + 1);
      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        end += 1;
      }
    }
    end += 1;
    codePoints += 1;
  }
  return value.slice(0, end);
};

const resolveInlineCompletionContexts = (
  view: EditorView,
  cursorOffset: number,
): { prefix: string; suffix: string } => {
  const prefixStart = Math.max(0, cursorOffset - INLINE_COMPLETION_CONTEXT_CODE_UNIT_WINDOW);
  return {
    prefix: clipInlineContext(
      view.state.doc.sliceString(prefixStart, cursorOffset),
      INLINE_COMPLETION_CONTEXT_LIMIT,
    ),
    suffix: clipInlineContextTrailing(
      view.state.doc.sliceString(
        cursorOffset,
        cursorOffset + INLINE_COMPLETION_CONTEXT_CODE_UNIT_WINDOW,
      ),
      INLINE_COMPLETION_CONTEXT_LIMIT,
    ),
  };
};`,
    },
    {
      id: 'E8-handleUpdate',
      find: `    handleUpdate(update: ViewUpdate): void {
      if (update.selectionSet || update.docChanged) {
        schedule(update.view);
      }
    },`,
      replace: `    handleUpdate(update: ViewUpdate): void {
      if (update.docChanged) {
        schedule(update.view);
        return;
      }
      // 纯移动光标(无文档变化)不应触发 AI 补全请求：仅作废待定请求并清掉已展示的 ghost，
      // 否则方向键导航也会在停顿后打一次补全 IPC。
      if (update.selectionSet) {
        viewRef = update.view;
        clearTimer();
        requestId += 1;
        clearGhost();
      }
    },`,
    },
  ],
  'src/components/editor/GitDiffViewer.vue': [
    {
      id: 'E9-watch',
      find: `watch(
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
);`,
      replace: `// 不监听 props.theme —— diff 视图(与主编辑器一致)刻意恒为 github-light，buildMergeView
// 不读取 theme，监听它只会在每次主题切换时整块 remount 出一个完全相同的视图。
watch(
  () => [
    props.preview.id,
    props.preview.originalContent,
    props.preview.modifiedContent,
    props.preview.isEmpty,
    props.editorSettings,
  ],
  () => {
    void remountDiffEditor();
  },
  { deep: true },
);`,
    },
  ],
  'src/utils/editor-language.ts': [
    {
      id: 'E10a-dockerfile',
      find: `  dart: 'dart',
  dockerfile: 'dockerfile',
  env: 'ini',`,
      replace: `  dart: 'dart',
  env: 'ini',`,
    },
  ],
  'src/components/editor/SmartScriptEditor.vue': [
    {
      id: 'E10b-ref',
      find: `const analysisState = ref<IAnalyzeScriptPayload>({
  available: true,
  message: null,
  dialect: 'bash',
  diagnostics: [],
});`,
      replace: `const createEmptyAnalysis = (): IAnalyzeScriptPayload => ({
  available: true,
  message: null,
  dialect: 'bash',
  diagnostics: [],
});

const analysisState = ref<IAnalyzeScriptPayload>(createEmptyAnalysis());`,
    },
    {
      id: 'E10b-clear',
      find: `const clearAnalysis = (): void => {
  emitAnalysis({
    available: true,
    message: null,
    dialect: 'bash',
    diagnostics: [],
  });
};`,
      replace: `const clearAnalysis = (): void => {
  emitAnalysis(createEmptyAnalysis());
};`,
    },
  ],
};

function findBlockMatches(contentLines, findLines) {
  const matches = [];
  const first = findLines[0];
  for (let i = 0; i + findLines.length <= contentLines.length; i += 1) {
    const cFirst = contentLines[i];
    if (!cFirst.endsWith(first)) continue;
    const pad = cFirst.slice(0, cFirst.length - first.length);
    if (pad.trim() !== '') continue;
    let ok = true;
    for (let j = 0; j < findLines.length; j += 1) {
      const cl = contentLines[i + j];
      const fl = findLines[j];
      if (fl.trim() === '') {
        if (cl.trim() !== '') { ok = false; break; }
      } else if (cl !== pad + fl) {
        ok = false; break;
      }
    }
    if (ok) matches.push({ index: i, pad });
  }
  return matches;
}

function applyEdit(content, edit) {
  const contentLines = content.split('\n');
  const findLines = edit.find.split('\n');
  const matches = findBlockMatches(contentLines, findLines);
  if (matches.length === 0) return { ok: false, reason: '未找到匹配' };
  if (matches.length > 1) return { ok: false, reason: `匹配不唯一(${matches.length} 处)` };
  const { index, pad } = matches[0];
  const replaceLines = edit.replace.split('\n').map((l) => (l === '' ? '' : pad + l));
  const next = [
    ...contentLines.slice(0, index),
    ...replaceLines,
    ...contentLines.slice(index + findLines.length),
  ];
  return { ok: true, content: next.join('\n') };
}

let totalApplied = 0;
const failures = [];

for (const [rel, fileEdits] of Object.entries(edits)) {
  const abs = join(ROOT, rel);
  let content;
  try {
    content = await readFile(abs, 'utf8');
  } catch (err) {
    failures.push(`${rel}: 读取失败 ${err.message}`);
    continue;
  }
  // 自动适配换行风格：CRLF 文件先归一为 LF 做整块匹配，写回时再还原为原换行符。
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const normalized = eol === '\n' ? content : content.replace(/\r\n/g, '\n');
  let working = normalized;
  let fileApplied = 0;
  for (const edit of fileEdits) {
    const res = applyEdit(working, edit);
    if (!res.ok) {
      failures.push(`${rel} [${edit.id}]: ${res.reason}`);
      continue;
    }
    working = res.content;
    fileApplied += 1;
    totalApplied += 1;
    console.log(`✓ ${rel} [${edit.id}]`);
  }
  if (!DRY && fileApplied > 0 && working !== normalized) {
    await copyFile(abs, `${abs}.bak`);
    const tmp = `${abs}.tmp-${Date.now()}`;
    const output = eol === '\n' ? working : working.replace(/\n/g, eol);
    await writeFile(tmp, output, 'utf8');
    await rename(tmp, abs);
    console.log(`  → 已写入 ${rel} (${fileApplied} 处), 备份 ${rel}.bak`);
  }
}

console.log(`\n命中 ${totalApplied} 处, 失败 ${failures.length} 处${DRY ? ' (dry-run, 未写盘)' : ''}`);
if (failures.length > 0) {
  console.error('失败明细:');
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}