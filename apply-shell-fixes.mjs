#!/usr/bin/env node
// apply-shell-fixes.mjs — AppShellLayout.vue 壳层精读修复 (S1/S2/S3)
// 用法:
//   node apply-shell-fixes.mjs "D:\\com.xiaojianc\\my_desktop_app" --dry
//   node apply-shell-fixes.mjs "D:\\com.xiaojianc\\my_desktop_app"
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

const root = process.argv[2];
const dry = process.argv.includes('--dry');
if (!root) {
  console.error('用法: node apply-shell-fixes.mjs <仓库根目录> [--dry]');
  process.exit(1);
}

const FILE = 'src/layouts/AppShellLayout.vue';
const L = (arr) => arr.join('\n');

const edits = [
  // S1 — 删除死 prop activityVisible(类型声明 + 默认值,无任何引用,ShellWorkbenchView 也未传入)
  {
    id: 'S1-prop-type',
    file: FILE,
    find: [
      '    isDesktopRuntime?: boolean;',
      '    activityVisible?: boolean;',
      '    sidebarVisible?: boolean;',
    ],
    replace: ['    isDesktopRuntime?: boolean;', '    sidebarVisible?: boolean;'],
  },
  {
    id: 'S1-prop-default',
    file: FILE,
    find: [
      '    isDesktopRuntime: false,',
      '    activityVisible: false,',
      '    sidebarVisible: true,',
    ],
    replace: ['    isDesktopRuntime: false,', '    sidebarVisible: true,'],
  },
  // S2 — shellThemeStyle 是全静态对象,无响应式依赖,computed 改为常量
  {
    id: 'S2-computed-open',
    file: FILE,
    find: ['const shellThemeStyle = computed(() => ({'],
    replace: ['const shellThemeStyle = {'],
  },
  {
    id: 'S2-computed-close',
    file: FILE,
    find: ["  '--surface-soft-strong': '#d1d9e0b3',", '}));'],
    replace: ["  '--surface-soft-strong': '#d1d9e0b3',", '} as const;'],
  },
  // S3 — startWindowResize 复用 getAppWindow() 辅助函数,去掉重复的动态 import
  {
    id: 'S3-reuse-get-app-window',
    file: FILE,
    find: [
      "    const { getCurrentWindow } = await import('@tauri-apps/api/window');",
      '    await getCurrentWindow().startResizeDragging(direction);',
    ],
    replace: [
      '    const appWindow = await getAppWindow();',
      '    await appWindow?.startResizeDragging(direction);',
    ],
  },
];

let hit = 0;
let fail = 0;
const byFile = new Map();
for (const e of edits) {
  if (!byFile.has(e.file)) byFile.set(e.file, []);
  byFile.get(e.file).push(e);
}

for (const [rel, list] of byFile) {
  const abs = isAbsolute(rel) ? rel : join(root, rel);
  if (!existsSync(abs)) {
    console.error(`✗ 文件不存在: ${rel}`);
    fail += list.length;
    continue;
  }
  const original = readFileSync(abs, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let working = eol === '\r\n' ? original.split('\r\n').join('\n') : original;
  let changed = false;
  for (const e of list) {
    const find = L(e.find);
    const replace = L(e.replace);
    const n = working.split(find).length - 1;
    if (n === 0) {
      console.error(`✗ [${e.id}] ${rel}: 未找到匹配`);
      fail += 1;
      continue;
    }
    if (n > 1 && !e.all) {
      console.error(`✗ [${e.id}] ${rel}: 匹配到 ${n} 处(预期唯一),跳过`);
      fail += 1;
      continue;
    }
    working = working.split(find).join(replace);
    changed = true;
    hit += 1;
    console.log(`✓ [${e.id}] ${rel}`);
  }
  if (changed && !dry) {
    const out = eol === '\r\n' ? working.split('\n').join('\r\n') : working;
    if (!existsSync(abs + '.bak')) writeFileSync(abs + '.bak', original, 'utf8');
    writeFileSync(abs, out, 'utf8');
  }
}

console.log(`\n${dry ? '[DRY] ' : ''}命中 ${hit} / 失败 ${fail}(共 ${edits.length} 块)`);
process.exit(fail ? 1 : 0);