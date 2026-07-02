#!/usr/bin/env node
// fix-ts-highlight-viewport.mjs
// 把 tree-sitter 编辑器着色从「每次 publish 全文档 query」改为「仅视口 + overscan」。
// capture→class 逻辑不变，纯性能。幂等、带唯一锚点校验。
// 用法：node fix-ts-highlight-viewport.mjs [--dry-run]
// 前提：web-tree-sitter ^0.26（Query.captures 支持 { startIndex, endIndex } 选项，字节坐标）。
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DRY = process.argv.includes('--dry-run');
const FILE = join(process.cwd(), 'src/services/editor/codemirror-tree-sitter-highlight.ts');
let src = await readFile(FILE, 'utf8');
const original = src;

if (src.includes('TS_HIGHLIGHT_OVERSCAN_LINES')) {
  console.log('已应用过（检测到 TS_HIGHLIGHT_OVERSCAN_LINES），跳过。');
  process.exit(0);
}

const replace = (label, from, to) => {
  const n = src.split(from).length - 1;
  if (n === 0) throw new Error(`锚点未命中: ${label}（文件可能已改动，请人工核对后再跑）`);
  if (n > 1) throw new Error(`锚点不唯一(${n} 处): ${label}`);
  src = src.replace(from, to);
};

// 1) import 补 utf8ByteLengthOfRange（字符→UTF-8 字节换算，tree-sitter 用字节坐标）
replace(
  'import bash-runtime',
  `import { computeBashSourceEdit, type Point, type Tree } from './tree-sitter/bash-runtime';`,
  `import {\n  computeBashSourceEdit,\n  type Point,\n  type Tree,\n  utf8ByteLengthOfRange,\n} from './tree-sitter/bash-runtime';`,
);

// 2) overscan 常量
replace(
  'overscan 常量',
  `const MAX_TS_SOURCE_LENGTH = 2_000_000; // 超大文件跳过，避免主线程长任务`,
  `const MAX_TS_SOURCE_LENGTH = 2_000_000; // 超大文件跳过，避免主线程长任务\nconst TS_HIGHLIGHT_OVERSCAN_LINES = 100; // 视口上下额外着色的行数，滚动衔接缓冲`,
);

// 3) update() 响应视口变化：纯滚动不重解析，仅按新视口重建装饰
replace(
  'update 视口分支',
  `  update(update: ViewUpdate): void {\n    if (!update.docChanged) return;\n    const next = update.state.doc.toString();`,
  `  update(update: ViewUpdate): void {\n    if (!update.docChanged) {\n      // 纯滚动/视口变化：不重解析，仅按新视口重建装饰（着色视口化的关键）。\n      if (update.viewportChanged) this.schedulePublish();\n      return;\n    }\n    const next = update.state.doc.toString();`,
);

// 4) build() 只查可见视口 + overscan 的字节范围
replace(
  'build 视口化',
  `    const query = queryCache.get(this.langId);\n    if (!query || !this.tree) return Decoration.none;\n    const doc = this.view.state.doc;\n    const items: Array<{ from: number; to: number; span: number; deco: Decoration }> = [];\n    for (const capture of query.captures(this.tree.rootNode)) {`,
  `    const query = queryCache.get(this.langId);\n    if (!query || !this.tree) return Decoration.none;\n    const doc = this.view.state.doc;\n    const { visibleRanges } = this.view;\n    if (visibleRanges.length === 0) return Decoration.none;\n    // 只查可见视口 + overscan（对齐 Zed / CodeMirror 官方 highlighter）：字符范围换算为\n    // tree-sitter 期望的 UTF-8 字节范围，query 仅遍历与该范围相交的节点，成本随视口而非文件大小。\n    const firstLine = Math.max(\n      1,\n      doc.lineAt(visibleRanges[0].from).number - TS_HIGHLIGHT_OVERSCAN_LINES,\n    );\n    const lastLine = Math.min(\n      doc.lines,\n      doc.lineAt(visibleRanges[visibleRanges.length - 1].to).number +\n        TS_HIGHLIGHT_OVERSCAN_LINES,\n    );\n    const startIndex = utf8ByteLengthOfRange(this.source, 0, doc.line(firstLine).from);\n    const endIndex = utf8ByteLengthOfRange(this.source, 0, doc.line(lastLine).to);\n    const items: Array<{ from: number; to: number; span: number; deco: Decoration }> = [];\n    for (const capture of query.captures(this.tree.rootNode, { startIndex, endIndex })) {`,
);

if (src === original) {
  console.log('无改动。');
  process.exit(0);
}
if (DRY) {
  console.log('[dry-run] 4 处锚点均命中，未写盘。');
  process.exit(0);
}
await writeFile(FILE, src, 'utf8');
console.log('✔ 已改写 codemirror-tree-sitter-highlight.ts（视口化）。');
console.log('  验证：pnpm tsc --noEmit && pnpm test && 打开一个数千行文件，滚动看高亮无回归/无闪。');