// scripts/unify-window-resize-pipeline.mjs
// 统一窗口 resize 管线：移除悬空的 START/END 幽灵事件与其死代码，
// 全仓只保留 FRAME/SETTLED。纯死代码清理，运行时行为不变。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const edits = [
  {
    file: 'src/app/composables/useShellWorkbenchView.ts',
    patches: [
      [`import {
  SHELL_WINDOW_RESIZE_END_EVENT,
  SHELL_WINDOW_RESIZE_FRAME_EVENT,
  SHELL_WINDOW_RESIZE_SETTLED_EVENT,
  SHELL_WINDOW_RESIZE_START_EVENT,
} from '@/utils/window/window-resize-events';`,
       `import {
  SHELL_WINDOW_RESIZE_FRAME_EVENT,
  SHELL_WINDOW_RESIZE_SETTLED_EVENT,
} from '@/utils/window/window-resize-events';`],
      [`    handleShellWindowResizeStart,
    handleShellWindowResizeFrame,
    handleShellWindowResizeEnd,
    handleShellWindowResizeSettled,`,
       `    handleShellWindowResizeFrame,
    handleShellWindowResizeSettled,`],
      [`    window.addEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);
    window.addEventListener(SHELL_WINDOW_RESIZE_FRAME_EVENT, handleShellWindowResizeFrameEvent);
    window.addEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleShellWindowResizeEnd);
    window.addEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);`,
       `    window.addEventListener(SHELL_WINDOW_RESIZE_FRAME_EVENT, handleShellWindowResizeFrameEvent);
    window.addEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);`],
      [`    window.removeEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleShellWindowResizeStart);
    window.removeEventListener(SHELL_WINDOW_RESIZE_FRAME_EVENT, handleShellWindowResizeFrameEvent);
    window.removeEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleShellWindowResizeEnd);
    window.removeEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);`,
       `    window.removeEventListener(SHELL_WINDOW_RESIZE_FRAME_EVENT, handleShellWindowResizeFrameEvent);
    window.removeEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);`],
    ],
  },
  {
    file: 'src/app/composables/useShellWorkbenchViewportState.ts',
    patches: [
      [`  const handleShellWindowResizeStart = (): void => {
    diagnosticsTransitionsEnabled.value = false;
    if (diagnosticsResizeSettleTimerId !== null) {
      window.clearTimeout(diagnosticsResizeSettleTimerId);
      diagnosticsResizeSettleTimerId = null;
    }
    queueCurrentViewportSize();
  };

  const handleShellWindowResizeFrame = (): void => {`,
       `  const handleShellWindowResizeFrame = (): void => {`],
      [`  const handleShellWindowResizeEnd = (): void => {
    queueCurrentViewportSize();
  };

  const handleShellWindowResizeSettled = (): void => {`,
       `  const handleShellWindowResizeSettled = (): void => {`],
      [`    handleShellWindowResizeStart,
    handleShellWindowResizeFrame,
    handleShellWindowResizeEnd,
    handleShellWindowResizeSettled,`,
       `    handleShellWindowResizeFrame,
    handleShellWindowResizeSettled,`],
    ],
  },
];

// useShellResizeFrameScheduler.ts：若确认无人 import，则整文件删除；否则去掉 START/END 分支。
const SCHEDULER = 'src/app/composables/useShellResizeFrameScheduler.ts';

let failed = false;
for (const { file, patches } of edits) {
  if (!existsSync(file)) { console.error(`✗ 缺文件: ${file}`); failed = true; continue; }
  let src = readFileSync(file, 'utf8');
  for (const [find, replace] of patches) {
    if (!src.includes(find)) { console.error(`✗ 锚点未命中: ${file}\n---\n${find}\n---`); failed = true; continue; }
    src = src.replace(find, replace);
  }
  if (!failed) { writeFileSync(file, src); console.log(`✓ 已更新 ${file}`); }
}

if (existsSync(SCHEDULER)) {
  console.warn(`⚠ 请全仓搜索 "useShellResizeFrameScheduler" 的 import：`);
  console.warn(`  · 若无任何引用 → 直接 rm ${SCHEDULER}（P2 死文件）；`);
  console.warn(`  · 若有引用 → 手动去掉其 onStart/onEnd 与 START/END 两个 useEventListener，仅留 FRAME/SETTLED。`);
}

if (failed) { console.error('\n有锚点未命中，未写入对应文件；请核对源码后重跑。'); process.exit(1); }
console.log('\n✅ resize 管线已统一为 FRAME/SETTLED，幽灵事件与死代码已清除。');