// 让编辑器左侧行号 / gutter 文本不可被鼠标选中。
// 用法（在仓库根目录下）：
//   预演（不写盘）：node fix-gutter-userselect.mjs
//   实际写入：     node fix-gutter-userselect.mjs --write
// 可逆：git diff 查看；git checkout -- <file> 撤销。

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src/services/editor/codemirror-shiki-highlight.ts';

const ANCHOR = `    '.cm-gutters': {
      backgroundColor: SHIKI_BACKGROUND,
      color: '#6e7781',
      border: 'none',
    },`;

const REPLACEMENT = `    '.cm-gutters': {
      backgroundColor: SHIKI_BACKGROUND,
      color: '#6e7781',
      border: 'none',
      // 行号 / gutter 文本禁止鼠标选中（macOS WKWebView 需 -webkit- 前缀，故双写）。
      userSelect: 'none',
      WebkitUserSelect: 'none',
    },`;

const write = process.argv.includes('--write');
const src = readFileSync(FILE, 'utf8');

if (src.includes("WebkitUserSelect: 'none'")) {
  console.log('✅ 已包含 user-select 设置，无需修改。');
  process.exit(0);
}

const count = src.split(ANCHOR).length - 1;
if (count !== 1) {
  console.error(`❌ 预期精确匹配 1 处 .cm-gutters 锚点，实际 ${count} 处，已中止（文件可能已改动，请告知我重新对齐）。`);
  process.exit(1);
}

const out = src.replace(ANCHOR, REPLACEMENT);

if (!write) {
  console.log("—— 预演（未写盘）。将在 '.cm-gutters' 块内新增： ——");
  console.log("  userSelect: 'none',");
  console.log("  WebkitUserSelect: 'none',");
  console.log('确认无误后执行：node fix-gutter-userselect.mjs --write');
  process.exit(0);
}

writeFileSync(FILE, out);
console.log(`✅ 已写入 ${FILE}`);