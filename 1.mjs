// 2.mjs —— 统一诊断管线：删除 analyzeScript 第二引擎 + 全部休眠脚手架，LSP 为唯一来源
// 运行：在仓库根目录  node 2.mjs
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';

const R = (p) => readFileSync(p, 'utf8');
const detectEol = (s) => (s.includes('\r\n') ? '\r\n' : '\n');
const norm = (s) => s.replace(/\r\n/g, '\n');

const pending = [];
function edit(file, fn) {
  const raw = R(file);
  const eol = detectEol(raw);
  const after = fn(norm(raw));
  pending.push({ file, content: after, eol });
}

// —— 原语：锚点缺失即抛错（写盘前整体中止，不会留下半成品）——
function cut(s, startSub, endSub) {
  const i = s.indexOf(startSub);
  if (i < 0) throw new Error(`cut 起点未命中: ${startSub.slice(0, 70)}`);
  const j = s.indexOf(endSub, i + startSub.length);
  if (j < 0) throw new Error(`cut 终点未命中: ${endSub.slice(0, 70)}`);
  return s.slice(0, s.lastIndexOf('\n', i) + 1) + s.slice(s.lastIndexOf('\n', j) + 1);
}
function replaceOnce(s, find, repl) {
  const i = s.indexOf(find);
  if (i < 0) throw new Error(`replace 未命中: ${find.slice(0, 70)}`);
  if (s.indexOf(find, i + find.length) >= 0) throw new Error(`replace 多处命中: ${find.slice(0, 70)}`);
  return s.slice(0, i) + repl + s.slice(i + find.length);
}
function dropLines(s, ...needles) {
  const set = needles.map((n) => n.trim());
  return s.split('\n').filter((l) => !set.includes(l.trim())).join('\n');
}
function removeArrowFn(s, startSub) {
  const i = s.indexOf(startSub);
  if (i < 0) throw new Error(`removeArrowFn 未命中: ${startSub.slice(0, 70)}`);
  const lineStart = s.lastIndexOf('\n', i) + 1;
  let depth = 0, k = s.indexOf('{', i);
  if (k < 0) throw new Error(`removeArrowFn 无函数体: ${startSub.slice(0, 70)}`);
  for (; k < s.length; k++) {
    if (s[k] === '{') depth++;
    else if (s[k] === '}' && --depth === 0) { k++; break; }
  }
  if (s[k] === ')') k++;
  if (s[k] === ',' || s[k] === ';') k++;
  if (s[k] === '\n') k++;
  return s.slice(0, lineStart) + s.slice(k);
}
function removeCall(s, startSub) {
  const i = s.indexOf(startSub);
  if (i < 0) throw new Error(`removeCall 未命中: ${startSub.slice(0, 70)}`);
  const lineStart = s.lastIndexOf('\n', i) + 1;
  let depth = 0, k = s.indexOf('(', i);
  if (k < 0) throw new Error(`removeCall 无调用括号: ${startSub.slice(0, 70)}`);
  for (; k < s.length; k++) {
    if (s[k] === '(') depth++;
    else if (s[k] === ')' && --depth === 0) { k++; break; }
  }
  if (s[k] === ',' || s[k] === ';') k++;
  if (s[k] === '\n') k++;
  return s.slice(0, lineStart) + s.slice(k);
}

// ===========================================================================
// 1) SmartScriptEditor.vue —— 整文件重写为「纯转发壳」（删尽 analyze 调度/诊断上抛/rerun）
// ===========================================================================
const SMART = `<template>
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
`;
edit('src/components/editor/SmartScriptEditor.vue', () => SMART);

// ===========================================================================
// 2) CodeMirrorScriptEditor.vue —— 删 analysis 输入侧（squiggles 改由 LSP 独供）
// ===========================================================================
edit('src/components/editor/CodeMirrorScriptEditor.vue', (s) => {
  s = replaceOnce(
    s,
    `import type {\n  IAnalyzeScriptPayload,\n  IEditorSelectionSummary,\n  TScriptDiagnosticSeverity,\n} from '@/types/editor';`,
    `import type { IEditorSelectionSummary } from '@/types/editor';`,
  );
  s = removeArrowFn(s, `const createEmptyAnalysis = (): IAnalyzeScriptPayload => ({`);
  s = cut(s, `const analysisState = computed(() => props.analysis ?? createEmptyAnalysis());`, `const contextMenuState = ref(`);
  s = dropLines(s, `analysis?: IAnalyzeScriptPayload;`, `analysis: undefined,`);
  s = cut(s, `const toDiagnosticSeverity = (level: TScriptDiagnosticSeverity): Diagnostic['severity'] => {`, `let lspDiagnostics: Diagnostic[] = [];`);
  s = removeArrowFn(s, `const syncDiagnostics = (): void => {`);
  s = dropLines(s, `syncDiagnostics();`, `watch(analysisDiagnosticsSignature, () => syncDiagnostics());`);
  s = replaceOnce(s, `const merged = [...shellcheckDiagnostics, ...lspDiagnostics]`, `const merged = [...lspDiagnostics]`);
  return s;
});

// ===========================================================================
// 3) AiWorkspaceSurface.vue —— 删除死掉的 analysis 透传链
// ===========================================================================
edit('src/components/business/ai/shell/AiWorkspaceSurface.vue', (s) =>
  dropLines(s, `IAnalyzeScriptPayload,`, `analysis: IAnalyzeScriptPayload;`, `:analysis="analysis"`),
);

// ===========================================================================
// 4) AiAssistantPanel.vue —— 删除死掉的 analysis prop / analysisRef / 入参
// ===========================================================================
edit('src/components/business/ai/shell/AiAssistantPanel.vue', (s) =>
  dropLines(
    s,
    `IAnalyzeScriptPayload,`,
    `analysis: IAnalyzeScriptPayload;`,
    `const analysisRef = computed(() => props.analysis);`,
    `analysis: analysisRef,`,
  ),
);

// ===========================================================================
// 5) store/editor.ts —— 删除 documentAnalysis 模型 + 全部派生 getter / setter
// ===========================================================================
edit('src/store/editor.ts', (s) => {
  s = dropLines(s, `IAnalyzeScriptPayload,`);
  s = removeArrowFn(s, `const createEmptyScriptAnalysis = (): IAnalyzeScriptPayload => ({`);
  s = dropLines(s, `const documentAnalysis = ref<Record<string, IAnalyzeScriptPayload>>({});`);
  s = removeArrowFn(s, `const clearDocumentAnalysis = (documentId: string): void => {`);
  s = removeArrowFn(s, `const setDocumentAnalysis = (documentId: string, payload: IAnalyzeScriptPayload): void => {`);
  s = cut(s, `const activeScriptAnalysis = computed<IAnalyzeScriptPayload>(`, `const canOpenMoreTabs = computed(`);
  s = dropLines(
    s,
    `clearDocumentAnalysis(targetDocument.id);`,
    `clearDocumentAnalysis(documentId);`,
    `documentAnalysis.value = {};`,
    `documentAnalysis,`,
    `activeScriptAnalysis,`,
    `activeDiagnostics,`,
    `activeDiagnosticErrors,`,
    `activeDiagnosticWarnings,`,
    `activeDiagnosticInfos,`,
    `setDocumentAnalysis,`,
    `clearDocumentAnalysis,`,
  );
  return s;
});

// ===========================================================================
// 6) useShellWorkbenchView.ts —— 删 analyze 入站 + 休眠的诊断面板脚手架
// ===========================================================================
edit('src/app/composables/useShellWorkbenchView.ts', (s) => {
  s = dropLines(s, `IAnalyzeScriptPayload,`, `rerunDiagnostics: () => void;`, `const isDiagnosticsPanelVisible = ref(false);`);
  s = removeCall(s, `const shouldRenderDiagnosticsPanel = computed(`);
  s = removeCall(s, `const canToggleDiagnosticsPanel = computed(`);
  s = removeCall(s, `const diagnosticIssueCount = computed(`);
  s = cut(s, `const handleDiagnosticsChange = (documentId: string, payload: IAnalyzeScriptPayload): void => {`, `const applyPrimaryMode = `);
  s = removeArrowFn(s, `const openDiagnosticsPanel = (): void => {`);
  s = removeArrowFn(s, `const toggleDiagnosticsPanel = async (): Promise<void> => {`);
  s = removeCall(s, `watch(\n    () => [workbench.editorStore.hasActiveDocument, workbench.editorStore.document.kind],`);
  s = dropLines(
    s,
    `closeDiagnosticsPanel();`,
    `isDiagnosticsPanelVisible,`,
    `shouldRenderDiagnosticsPanel,`,
    `canToggleDiagnosticsPanel,`,
    `diagnosticIssueCount,`,
    `handleDiagnosticsChange,`,
    `handleSelectDiagnostic,`,
    `handleRerunDiagnostics,`,
    `toggleDiagnosticsPanel,`,
  );
  return s;
});

// ===========================================================================
// 7) ShellWorkbenchView.vue —— 解绑 :analysis / @diagnostics-change / rerunDiagnostics 守卫
// ===========================================================================
edit('src/app/ShellWorkbenchView.vue', (s) =>
  dropLines(
    s,
    `:analysis="editorStore.activeScriptAnalysis"`,
    `@diagnostics-change="handleDiagnosticsChange"`,
    `handleDiagnosticsChange,`,
    `'rerunDiagnostics' in value &&`,
    `typeof value.rerunDiagnostics === 'function' &&`,
  ),
);

// ===========================================================================
// 8) useAiAssistant.patch.ts —— 删除指向已删文件的陈旧注释
// ===========================================================================
edit('src/composables/ai/useAiAssistant.patch.ts', (s) =>
  dropLines(s, `// ShellCheck analysis for applied patches lives in ./useAiAssistant.shellcheck.`),
);

// ===========================================================================
// 9) useAiAssistant.spec.ts —— 删 analyze mock / analysis 入参 / 类型
// ===========================================================================
edit('src/composables/ai/useAiAssistant.spec.ts', (s) => {
  s = replaceOnce(
    s,
    `import type { IAnalyzeScriptPayload, IEditorDocument } from '@/types/editor';`,
    `import type { IEditorDocument } from '@/types/editor';`,
  );
  s = removeCall(s, `analyzeScript: vi.fn(`);
  s = removeArrowFn(s, `const createAnalysis = (): IAnalyzeScriptPayload => ({`);
  s = dropLines(s, `analysis: ref(createAnalysis()),`);
  return s;
});

// ===========================================================================
// 10) AiAssistantPanel.spec.ts —— 删 analysis 类型 / 工厂 / mount prop
// ===========================================================================
edit('src/components/business/ai/shell/AiAssistantPanel.spec.ts', (s) => {
  s = dropLines(s, `IAnalyzeScriptPayload,`);
  s = removeArrowFn(s, `const createAnalysis = (): IAnalyzeScriptPayload => ({`);
  s = dropLines(s, `analysis: createAnalysis(),`);
  return s;
});

// ===========================================================================
// 写盘（到此说明所有结构性锚点均命中）
// ===========================================================================
for (const { file, content, eol } of pending) {
  writeFileSync(file, eol === '\r\n' ? content.replace(/\n/g, '\r\n') : content, 'utf8');
  console.log('✓ 修改', file);
}
console.log(`\n=== 完成：已修改 ${pending.length} 个文件 ===\n`);

// ===========================================================================
// 全量自检：确认第二引擎相关符号已彻底消失（生成产物单列）
// ===========================================================================
const TOKENS = [
  'IAnalyzeScriptPayload', 'analyzeScript', 'AnalyzeScript', 'ScriptDiagnostic',
  'TScriptDiagnosticSeverity', 'documentAnalysis', 'activeScriptAnalysis',
  'activeDiagnostics', 'activeDiagnosticErrors', 'activeDiagnosticWarnings',
  'activeDiagnosticInfos', 'activeDiagnosticCounts', 'setDocumentAnalysis',
  'clearDocumentAnalysis', 'createEmptyScriptAnalysis', 'createEmptyAnalysis',
  'analysisState', 'analysisDiagnosticsSignature', 'toDiagnosticSeverity',
  'syncDiagnostics', 'shellcheckDiagnostics', 'diagnosticIssueCount',
  'isDiagnosticsPanelVisible', 'shouldRenderDiagnosticsPanel',
  'canToggleDiagnosticsPanel', 'toggleDiagnosticsPanel', 'openDiagnosticsPanel',
  'closeDiagnosticsPanel', 'handleSelectDiagnostic', 'handleRerunDiagnostics',
  'rerunDiagnostics', 'diagnostics-change', 'runShellCheckForAppliedPatch',
  'useAiAssistant.shellcheck',
];
const isGen = (p) => /\/bindings\//.test(p) || p.endsWith('tauri.contracts.ts') || /\/generated\//.test(p);
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', 'dist', 'target', '.nuxt', 'coverage'].includes(name)) continue;
    const p = `${dir}/${name}`;
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(ts|tsx|vue|rs)$/.test(name)) files.push(p);
  }
};
for (const root of ['src', 'src-tauri/src']) {
  try { walk(root); } catch { /* 可能不存在 */ }
}
const action = [], generated = [];
for (const f of files) {
  const lines = norm(R(f)).split('\n');
  lines.forEach((line, idx) => {
    for (const t of TOKENS) {
      if (line.includes(t)) {
        (isGen(f) ? generated : action).push(`${f}:${idx + 1}: ${line.trim().slice(0, 110)}`);
        break;
      }
    }
  });
}
if (action.length === 0) {
  console.log('✅ 自检通过：源码中已无第二诊断引擎的任何残留引用。');
} else {
  console.log('⚠️ 仍需处理（贴回给我，我直接补）：');
  action.forEach((l) => console.log('  ' + l));
}
if (generated.length) {
  console.log('\n[生成产物残留：重跑 codegen 刷新即可，无需手改]');
  generated.forEach((l) => console.log('  ' + l));
}