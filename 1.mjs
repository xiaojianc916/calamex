// scripts/dedupe-window-resize-state.mjs
// 将全局窗口 resize 态（<html>.is-resizing）收敛为唯一持有者：仅保留常驻根组件 App.vue 的
// useWindowResizeState()，移除 useWorkbench.ts 中的重复调用（避免 <html> 上叠加两个 ResizeObserver）。
// 用法：node scripts/dedupe-window-resize-state.mjs           (dry-run)
//       node scripts/dedupe-window-resize-state.mjs --apply   (写盘)
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APPLY = process.argv.includes('--apply');
const APP_MARKER = 'RESIZE_STATE_SINGLE_OWNER';

const WORKBENCH = resolve(process.cwd(), 'src/app/composables/useWorkbench.ts');
const APP = resolve(process.cwd(), 'src/app/App.vue');

// ── useWorkbench.ts：删除 import 行 + 调用行（保留 useTheme()）──
const WB_IMPORT = `import { useWindowResizeState } from '@/composables/useWindowResizeState';\n`;
const WB_CALL_CTX = `  useTheme();\n  useWindowResizeState();\n`;
const WB_CALL_CTX_NEW = `  useTheme();\n`;

// ── App.vue：在唯一保留的调用上方补不变量注释（含幂等 marker）──
const APP_CALL = `useWindowResizeState();`;
const APP_CALL_NEW =
  `// ${APP_MARKER}: 全局窗口 resize 态（<html>.is-resizing，见 assets/css/tailwind.css）的唯一持有点。\n` +
  `// App.vue 是常驻根组件；不要在下层 composable（如 useWorkbench）重复调用，否则会在 <html> 上\n` +
  `// 叠加多个 ResizeObserver + 多个 settle 计时器，每帧 resize 做重复功。\n` +
  `useWindowResizeState();`;

const edits = []; // { file, path, next }

// ---- useWorkbench.ts ----
let wb = readFileSync(WORKBENCH, 'utf8');
if (wb.includes('useWindowResizeState')) {
  for (const anchor of [WB_IMPORT, WB_CALL_CTX]) {
    const n = wb.split(anchor).length - 1;
    if (n !== 1) {
      console.error(`✗ useWorkbench.ts 锚点命中 ${n} 次（应为 1），中止：\n---\n${anchor}\n---`);
      process.exit(1);
    }
  }
  wb = wb.replace(WB_IMPORT, '').replace(WB_CALL_CTX, WB_CALL_CTX_NEW);
  if (wb.includes('useWindowResizeState')) {
    console.error('✗ useWorkbench.ts 仍残留 useWindowResizeState 引用，中止。');
    process.exit(1);
  }
  edits.push({ file: 'useWorkbench.ts', path: WORKBENCH, next: wb });
} else {
  console.log('· useWorkbench.ts 已无 useWindowResizeState，跳过。');
}

// ---- App.vue ----
let app = readFileSync(APP, 'utf8');
if (!app.includes(APP_MARKER)) {
  const n = app.split(APP_CALL).length - 1; // import 行以 "useWindowResizeState';" 结尾，不会命中此串
  if (n !== 1) {
    console.error(`✗ App.vue 调用锚点命中 ${n} 次（应为 1），中止：\n---\n${APP_CALL}\n---`);
    process.exit(1);
  }
  app = app.replace(APP_CALL, APP_CALL_NEW);
  edits.push({ file: 'App.vue', path: APP, next: app });
} else {
  console.log('· App.vue 已含单一持有者注释，跳过。');
}

if (edits.length === 0) {
  console.log('✓ 已是单一持有者状态，无需改动。');
  process.exit(0);
}
if (!APPLY) {
  console.log(`（dry-run）将修改 ${edits.length} 个文件：${edits.map((e) => e.file).join(', ')}。加 --apply 落盘。`);
  process.exit(0);
}
for (const e of edits) writeFileSync(e.path, e.next, 'utf8');
console.log(`✓ 已收敛 resize 态为单一持有者（改动：${edits.map((e) => e.file).join(', ')}）。`);