import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = 'src/services/editor/';
let applied = 0;
let skipped = 0;

const edit = ({ file, find, replace, marker, label }) => {
  const path = ROOT + file;
  const src = readFileSync(path, 'utf8');
  if (marker && src.includes(marker)) {
    console.log('[skip] ' + label + '（已应用）');
    skipped += 1;
    return;
  }
  const n = src.split(find).length - 1;
  if (n !== 1) {
    throw new Error('[' + label + '] 期望唯一匹配，实际 ' + n + ' 处；请贴出来我来调整。');
  }
  writeFileSync(path, src.replace(find, () => replace), 'utf8');
  console.log('[ok]   ' + label);
  applied += 1;
};

const edits = [
  // W1：用下一行 startLine 锁定 tokenizeRange 内的那一处
  {
    file: 'shiki-tokenizer.worker.ts',
    label: 'W1 tokenizeRange 复用 highlighterInstance',
    marker: 'highlighterInstance ?? await ensureHighlighter()',
    find: `  const highlighter = await ensureHighlighter();
  const startLine = Math.max(1, req.startLine);`,
    replace: `  const highlighter = highlighterInstance ?? await ensureHighlighter();
  const startLine = Math.max(1, req.startLine);`,
  },
  // W2：edit 失效遍历去掉数组展开
  {
    file: 'shiki-tokenizer.worker.ts',
    label: 'W2 applyEdit 直接遍历 Map.keys()',
    marker: 'for (const blockIndex of session.blockEndState.keys())',
    find: `  for (const blockIndex of [...session.blockEndState.keys()]) {`,
    replace: `  for (const blockIndex of session.blockEndState.keys()) {`,
  },
];

for (const e of edits) {
  edit(e);
}
console.log('\n完成：应用 ' + applied + ' 处，跳过 ' + skipped + ' 处。');