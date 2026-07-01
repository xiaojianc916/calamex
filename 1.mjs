// scripts/drop-redundant-resize-bus-from-editors.mjs
// 目标：编辑器 relayout 只依赖各自容器的 ResizeObserver（专业范式），
// 移除对全局 window resize 事件总线的冗余订阅，并删除随之无人使用的 scheduler。
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';

const IMPORT_LINE =
  "import { useShellResizeFrameScheduler } from '@/app/composables/useShellResizeFrameScheduler';\n";

const edits = [
  {
    file: 'src/components/editor/CodeMirrorScriptEditor.vue',
    patches: [
      [IMPORT_LINE, ''],
      [
`const updatePreviousContainerSize = (): void => {
  if (!containerRef.value) return;
  previousContainerSize = {
    width: Math.round(containerRef.value.clientWidth),
    height: Math.round(containerRef.value.clientHeight),
  };
};

const handleShellWindowResizeStart = (): void => {
  updatePreviousContainerSize();
};

const handleShellWindowResizeSettled = (): void => {
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
        '',
      ],
    ],
  },
  {
    file: 'src/components/editor/GitDiffViewer.vue',
    patches: [
      [IMPORT_LINE, ''],
      [
`useShellResizeFrameScheduler({
  onFrame: scheduleLayout,
  onSettled: layoutDiffEditor,
});

`,
        '',
      ],
    ],
  },
];

// pass 1：全量校验并计算结果，任一锚点未命中则不落盘
const pending = [];
let ok = true;
for (const { file, patches } of edits) {
  if (!existsSync(file)) { console.error(`✗ 缺文件: ${file}`); ok = false; continue; }
  let src = readFileSync(file, 'utf8');
  for (const [find, replace] of patches) {
    if (!src.includes(find)) {
      console.error(`✗ 锚点未命中: ${file}\n----\n${find.slice(0, 80)}…\n----`);
      ok = false;
      break;
    }
    src = src.replace(find, replace);
  }
  pending.push({ file, src });
}
if (!ok) { console.error('\n存在未命中锚点，未做任何修改（请确认源码与本脚本基准一致）。'); process.exit(1); }

// pass 2：写回 + 删除随之无用的 scheduler
for (const { file, src } of pending) { writeFileSync(file, src); console.log(`✓ 已更新 ${file}`); }
const SCHEDULER = 'src/app/composables/useShellResizeFrameScheduler.ts';
if (existsSync(SCHEDULER)) { rmSync(SCHEDULER); console.log(`✓ 已删除无人引用的 ${SCHEDULER}`); }

console.log('\n✅ 两个编辑器改为仅依赖各自容器的 ResizeObserver；冗余总线订阅与 scheduler 已清除。');
console.log('   请运行：pnpm vue-tsc --noEmit && pnpm test，并手动拖拽窗口验证编辑器 / diff 跟手。');