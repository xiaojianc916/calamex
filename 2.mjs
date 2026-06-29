// fix-ai-review-batch-8.mjs  (H1 workspace.ts 去重 + H2 plan.ts catch 修正)
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const WS = 'builtin-agent/src/engines/workspace/workspace.ts';
const PLAN = 'builtin-agent/src/engines/modes/plan.ts';

const eolOf = (s) => (s.includes('\r\n') ? '\r\n' : '\n');

function load(rel) {
  const abs = resolve(ROOT, rel);
  const raw = readFileSync(abs, 'utf8');
  const eol = eolOf(raw);
  const hadTrailing = raw.endsWith(eol);
  const lines = raw.split(eol);
  if (hadTrailing) lines.pop();
  return { abs, eol, lines, hadTrailing };
}
function save(f) {
  writeFileSync(f.abs, f.lines.join(f.eol) + (f.hadTrailing ? f.eol : ''), 'utf8');
}
function findUnique(lines, target) {
  let idx = -1, count = 0;
  for (let i = 0; i < lines.length; i++) if (lines[i] === target) { count++; if (idx === -1) idx = i; }
  return { idx, count };
}
function findBlock(lines, block, from = 0) {
  for (let i = from; i + block.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < block.length; j++) if (lines[i + j] !== block[j]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}
function removeExactBlock(f, label, oldLines, signatureLine) {
  const at = findBlock(f.lines, oldLines);
  if (at !== -1) {
    if (findBlock(f.lines, oldLines, at + 1) !== -1) throw new Error(`待删除块不唯一,已中止: ${label}`);
    f.lines.splice(at, oldLines.length);
    console.log(`✓ 删除块: ${label}`);
    return;
  }
  if (signatureLine && findUnique(f.lines, signatureLine).idx === -1) {
    console.log(`• 跳过(已删除): ${label}`);
    return;
  }
  throw new Error(`未找到待删除块(形状可能已变),已中止: ${label}\n签名行: ${JSON.stringify(signatureLine)}`);
}
function replaceBlock(f, label, oldLines, newLines) {
  const at = findBlock(f.lines, oldLines);
  if (at === -1) {
    if (findBlock(f.lines, newLines) !== -1) { console.log(`• 跳过(已替换): ${label}`); return; }
    throw new Error(`未找到待替换块,已中止: ${label}`);
  }
  if (findBlock(f.lines, oldLines, at + 1) !== -1) throw new Error(`待替换块不唯一,已中止: ${label}`);
  f.lines.splice(at, oldLines.length, ...newLines);
  console.log(`✓ 替换块: ${label}`);
}

// ============ H1：workspace.ts 删除重复的本地 normalizeNewlines（保留顶部 import） ============
const ws = load(WS);
removeExactBlock(
  ws,
  'H1 workspace.ts: 删除重复声明的本地 normalizeNewlines',
  [
    'export const normalizeNewlines = (value: string): string =>',
    "    value.replace(/\\r\\n/gu, '\\n').replace(/\\r/gu, '\\n');",
    '',
  ],
  'export const normalizeNewlines = (value: string): string =>',
);
save(ws);

// ============ H2：plan.ts plan() catch 传 events 而非 [] ============
const plan = load(PLAN);
replaceBlock(
  plan,
  'H2 plan.ts: plan() catch 保留已累积事件',
  [
    '                `Mastra Plan 执行失败：${normalizeMastraError(error)}`,',
    '                [],',
  ],
  [
    '                `Mastra Plan 执行失败：${normalizeMastraError(error)}`,',
    '                events,',
  ],
);
save(plan);

console.log('\nbatch-8 完成。请运行 typecheck/test/lint 复核。');