#!/usr/bin/env node
// scripts/prefetch-editor-surface.mjs
// 目的：外壳首帧画出后，尽快把「编辑器」这个主 UI 加载出来，压缩“外壳已出、编辑器区还空着”的窗口。
// 用法：node scripts/prefetch-editor-surface.mjs        # 预览
//       node scripts/prefetch-editor-surface.mjs --apply # 写盘
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APPLY = process.argv.includes('--apply');
const FILE = resolve(process.cwd(), 'src/app/ShellWorkbenchView.vue');

const readText = (p) => {
  const raw = readFileSync(p, 'utf8');
  return { nl: raw.includes('\r\n') ? '\r\n' : '\n', text: raw.replace(/\r\n/g, '\n') };
};
const toEol = (text, nl) => (nl === '\r\n' ? text.replace(/\n/g, '\r\n') : text);

const APPLIED_MARKER = 'const prefetchEditorSurface';

const NEW_FN =
  '// 编辑器是首屏最先要看到的主 UI：initializeWorkbench 会先 await 运行时(~160ms)、再 restore 会话\n' +
  '// 重开文档才令 doc.kind=\'text\' 触发下面 DeferredSmartScriptEditor 的加载。趁「外壳已出、编辑器区\n' +
  '// 还空」这段空窗立即预取编辑器 chunk（CodeMirror/高亮），让 restore 到达时编辑器近乎即时挂载，\n' +
  '// 消除“外壳有了、编辑器区白着数百毫秒~数秒”的窗口。不 await、不挡首帧绘制。\n' +
  'const prefetchEditorSurface = (): void => {\n' +
  '  if (typeof window === \'undefined\') {\n' +
  '    return;\n' +
  '  }\n' +
  '\n' +
  '  void import(\'@/components/editor/SmartScriptEditor.vue\');\n' +
  '};\n';

const ANCHOR_FN = 'const prefetchAiSurfaceWhenIdle = (): void => {';
const ANCHOR_MOUNT = 'onMounted(() => {\n  prefetchAiSurfaceWhenIdle();\n});';
const NEXT_MOUNT = 'onMounted(() => {\n  prefetchEditorSurface();\n  prefetchAiSurfaceWhenIdle();\n});';

let src;
try {
  src = readText(FILE);
} catch {
  console.error(`✗ 找不到文件：${FILE}（请在仓库根目录运行）`);
  process.exit(1);
}

if (src.text.includes(APPLIED_MARKER)) {
  console.log('✓ 已预取编辑器，无需改动（幂等跳过）。');
  process.exit(0);
}

const countFn = src.text.split(ANCHOR_FN).length - 1;
const countMount = src.text.split(ANCHOR_MOUNT).length - 1;
if (countFn !== 1 || countMount !== 1) {
  console.error(`✗ 锚点命中异常（函数锚点 ${countFn}，onMounted 锚点 ${countMount}，均应为 1），中止。文件可能已变动，请人工核对。`);
  process.exit(1);
}

const nextText = src.text
  .replace(ANCHOR_FN, () => `${NEW_FN}\n${ANCHOR_FN}`)
  .replace(ANCHOR_MOUNT, () => NEXT_MOUNT);

if (nextText === src.text) {
  console.error('✗ 替换后内容无变化，中止。');
  process.exit(1);
}

if (!APPLY) {
  console.log('— DRY RUN（未写盘，加 --apply 生效）—');
  console.log('将新增 prefetchEditorSurface() 并在 onMounted 首行调用（AI 预取之前）。');
  process.exit(0);
}

writeFileSync(FILE, toEol(nextText, src.nl), 'utf8');
console.log(`✓ 已更新：${FILE}`);