// finish-window-chrome-cleanup.mjs
// #2 收尾（半 A）：原生 wndproc resize 已实测全通过 → 删除已死的 DOM resize handle 旧路径
// + 边缘 box-shadow 残留 + 两条临时规则。保留 data-tauri-drag-region（半 B 再换原生 HTCAPTION）。
// 幂等：若 window-resize-handles.css 已删除则视为已应用，直接退出。CRLF 自动保持。
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';

const HANDLES_CSS = 'src/styles/window-resize-handles.css';
if (!existsSync(HANDLES_CSS)) {
  console.log('✓ 已应用过（window-resize-handles.css 不存在），跳过。');
  process.exit(0);
}

function edit(path, edits) {
  const raw = readFileSync(path, 'utf8');
  const crlf = raw.includes('\r\n');
  let s = crlf ? raw.replace(/\r\n/g, '\n') : raw;
  for (const { old, neu, label } of edits) {
    const n = s.split(old).length - 1;
    if (n !== 1) throw new Error(`[校验失败] ${path} :: ${label} — 锚点出现 ${n} 次（应为 1）`);
    s = s.replace(old, () => neu);
    console.log(`  · ${label}`);
  }
  writeFileSync(path, crlf ? s.replace(/\n/g, '\r\n') : s, 'utf8');
  console.log(`✓ ${path}`);
}

console.log('AppShellLayout.vue');
edit('src/layouts/AppShellLayout.vue', [
  {
    label: '删除 8 个 DOM resize handle（保留 drag-region）',
    old: `            <template v-if="isDesktopRuntime">
                <div
                    v-for="handle in resizeHandles" :key="handle.direction" class="window-resize-handle"
                    :class="handle.className" @mousedown.prevent.stop="startWindowResize(handle.direction, $event)" />
                <div class="app-window-drag-region" data-tauri-drag-region />
            </template>`,
    neu: `            <template v-if="isDesktopRuntime">
                <div class="app-window-drag-region" data-tauri-drag-region />
            </template>`,
  },
  {
    label: '收窄 import：去掉 TWindowResizeDirection',
    old: `import { type TWindowResizeDirection, windowChromeService } from '@/services/tauri/window';`,
    neu: `import { windowChromeService } from '@/services/tauri/window';`,
  },
  {
    label: '删除 resizeHandles 数组',
    old: `const resizeHandles: Array<{ direction: TWindowResizeDirection; className: string }> = [
  { direction: 'North', className: 'is-top' },
  { direction: 'South', className: 'is-bottom' },
  { direction: 'East', className: 'is-right' },
  { direction: 'West', className: 'is-left' },
  { direction: 'NorthEast', className: 'is-top-right' },
  { direction: 'NorthWest', className: 'is-top-left' },
  { direction: 'SouthEast', className: 'is-bottom-right' },
  { direction: 'SouthWest', className: 'is-bottom-left' },
];

`,
    neu: ``,
  },
  {
    label: '删除 startWindowResize 函数',
    old: `// useWindowResizeState 已改由 ResizeObserver 直接响应 <html> 的渲染尺寸变化，
// 不再需要这里手动派发 START/END 事件、也不需要用 mouseup 给它们“强行配对”
// ——那一整套配对逻辑的唯一目的就是喂给已被移除的手写 resize 状态机。
const startWindowResize = async (
  direction: TWindowResizeDirection,
  event: MouseEvent,
): Promise<void> => {
  if (!props.isDesktopRuntime || event.button !== 0) {
    return;
  }

  try {
    await windowChromeService.startResizeDragging(direction);
  } catch (error) {
    console.warn('窗口边缘拉伸失败', error);
  }
};

`,
    neu: ``,
  },
]);

console.log('services/tauri/window.ts');
edit('src/services/tauri/window.ts', [
  {
    label: '删除 TWindowResizeDirection 类型',
    old: `export type TWindowResizeDirection =
  | 'North'
  | 'South'
  | 'East'
  | 'West'
  | 'NorthEast'
  | 'NorthWest'
  | 'SouthEast'
  | 'SouthWest';

`,
    neu: ``,
  },
  {
    label: '删除 startResizeDragging 方法',
    old: `  /** 从指定边缘/角落开始一次原生交互式缩放拖拽；非桌面运行时为 no-op。 */
  startResizeDragging: async (direction: TWindowResizeDirection): Promise<void> => {
    const appWindow = await getMainWindow();
    await appWindow?.startResizeDragging(direction);
  },

`,
    neu: ``,
  },
]);

console.log('styles.css');
edit('src/styles.css', [
  {
    label: '删除 window-resize-handles.css 的 @import',
    old: `@import './styles/window-resize-handles.css';
`,
    neu: ``,
  },
]);

console.log('styles/app-shell.css');
edit('src/styles/app-shell.css', [
  {
    label: '.app-window-shell 去掉被裁剪的 box-shadow（交给 DWM 原生边缘）',
    old: `.app-window-shell {
  background: var(--app-bg);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--shell-divider) 46%, transparent),
    0 8px 20px -16px color-mix(in srgb, var(--text-quaternary) 42%, transparent);
}`,
    neu: `.app-window-shell {
  background: var(--app-bg);
}`,
  },
  {
    label: '删除末尾两条临时规则（handle 禁用 + box-shadow:none 覆盖）',
    old: `

.window-resize-handle {
  pointer-events: none !important;
}

.app-window-shell {
  box-shadow: none !important;
}
`,
    neu: `
`,
  },
]);

console.log('删除文件');
rmSync(HANDLES_CSS);
console.log(`✓ 已删除 ${HANDLES_CSS}`);

console.log('\n完成。请运行：pnpm vue-tsc --noEmit && pnpm test');