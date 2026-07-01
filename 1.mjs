// fix-resize-events.mjs —— 补齐 window-resize-events 的 START/END 导出（幂等）
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TARGET = resolve('src/utils/window/window-resize-events.ts');

const CANONICAL = [
  "export const SHELL_WINDOW_RESIZE_START_EVENT = 'shell-window-resize-start';",
  "export const SHELL_WINDOW_RESIZE_FRAME_EVENT = 'shell-window-resize-frame';",
  "export const SHELL_WINDOW_RESIZE_END_EVENT = 'shell-window-resize-end';",
  "export const SHELL_WINDOW_RESIZE_SETTLED_EVENT = 'shell-window-resize-settled';",
  '',
].join('\n');

if (!existsSync(TARGET)) {
  console.error('[fix-resize-events] 找不到目标文件:', TARGET);
  process.exit(1);
}

const original = readFileSync(TARGET, 'utf8');

// 锚点校验：确认确实是这个文件（已含 FRAME/SETTLED），否则中止、绝不乱写
if (
  !original.includes('SHELL_WINDOW_RESIZE_FRAME_EVENT') ||
  !original.includes('SHELL_WINDOW_RESIZE_SETTLED_EVENT')
) {
  console.error('[fix-resize-events] 缺少 FRAME/SETTLED 锚点，内容不符预期，已中止，未改动。');
  process.exit(1);
}

// 幂等：START/END 都在就跳过
if (
  original.includes('SHELL_WINDOW_RESIZE_START_EVENT') &&
  original.includes('SHELL_WINDOW_RESIZE_END_EVENT')
) {
  console.log('[fix-resize-events] START/END 已存在，无需改动（幂等跳过）。');
  process.exit(0);
}

const bak = TARGET + '.bak';
if (!existsSync(bak)) {
  copyFileSync(TARGET, bak);
  console.log('[fix-resize-events] 已备份原文件 ->', bak);
}

writeFileSync(TARGET, CANONICAL, 'utf8');
console.log('[fix-resize-events] 已补齐 START/END，四拍常量（start→frame→end→settled）写入完成。');