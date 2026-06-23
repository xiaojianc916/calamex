// polish-comments-batch4.mjs
// 用法: node polish-comments-batch4.mjs  (在仓库根目录)
// 纯注释整理，零逻辑/零 UX 改动；每处自校验“唯一精确匹配”，命中数≠1 即跳过并告警。
import { readFileSync, writeFileSync } from 'node:fs';

const L = (...lines) => lines.join('\n');

const edits = [
  {
    file: 'src/components/editor/CodeMirrorScriptEditor.vue',
    find: L(
      '// 编辑器底部预留约 5 行空白：替代 scrollPastEnd()（其会预留近一屏空白、',
      '// 可把最后一行滚到顶部）。改为固定 5 行更贴近常规编辑器手感。',
      '// CM6 默认行高约为字号的 1.6 倍，故 15 行 = 24em。',
    ),
    replace: L(
      '// 编辑器底部预留约 15 行空白：不使用 scrollPastEnd()（它会预留近一屏空白，可把最后一行顶到屏幕最上沿），',
      '// 固定高度更贴近常规编辑器手感。CM6 默认行高约为字号的 1.6 倍，故 24em ≈ 15 行。',
    ),
  },
];

let skipped = 0;
const byFile = new Map();
for (const e of edits) {
  if (!byFile.has(e.file)) byFile.set(e.file, readFileSync(e.file, 'utf8'));
}

for (const e of edits) {
  let text = byFile.get(e.file);
  const count = text.split(e.find).length - 1;
  if (count !== 1) {
    skipped += 1;
    console.warn(`[skip] ${e.file}: 命中 ${count} 次（期望 1），未修改`);
    continue;
  }
  byFile.set(e.file, text.replace(e.find, e.replace));
  console.log(`[ok]   ${e.file}`);
}

for (const [file, text] of byFile) writeFileSync(file, text, 'utf8');
process.exit(skipped > 0 ? 1 : 0);