// fix-ai-review-batch-7.mjs  (G4 + G5 + G6, 已对齐当前 main 树 3246641)
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const CHAT = 'builtin-agent/src/engines/modes/chat.ts';
const VALID = 'builtin-agent/src/engines/modes/validation.ts';

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
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === target) { count++; if (idx === -1) idx = i; }
  }
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

// 锚点 -> 停止行（不含停止行），无论中间多少行都精确删除
function removeUntil(f, label, startAnchor, stopLine) {
  const s = findUnique(f.lines, startAnchor);
  if (s.idx === -1) { console.log(`• 跳过(已删除): ${label}`); return; }
  if (s.count > 1) throw new Error(`起始锚点不唯一,已中止: ${label}\n锚点: ${JSON.stringify(startAnchor)}`);
  let stop = -1;
  for (let i = s.idx + 1; i < f.lines.length; i++) if (f.lines[i] === stopLine) { stop = i; break; }
  if (stop === -1) throw new Error(`未找到停止行,已中止: ${label}\n停止行: ${JSON.stringify(stopLine)}`);
  const n = stop - s.idx;
  f.lines.splice(s.idx, n);
  console.log(`✓ 删除 ${n} 行: ${label}`);
}

function replaceLine(f, label, oldLine, newLine) {
  const got = findUnique(f.lines, oldLine);
  if (got.idx === -1) {
    if (findUnique(f.lines, newLine).idx !== -1) { console.log(`• 跳过(已替换): ${label}`); return; }
    throw new Error(`未找到待替换行,已中止: ${label}\n行: ${JSON.stringify(oldLine)}`);
  }
  if (got.count > 1) throw new Error(`待替换行不唯一,已中止: ${label}`);
  f.lines[got.idx] = newLine;
  console.log(`✓ 替换: ${label}`);
}

function insertAfter(f, label, anchor, newLine) {
  const got = findUnique(f.lines, anchor);
  if (got.idx === -1) throw new Error(`未找到锚点(after),已中止: ${label}\n锚点: ${JSON.stringify(anchor)}`);
  if (got.count > 1) throw new Error(`锚点(after)不唯一,已中止: ${label}`);
  if (f.lines[got.idx + 1] === newLine) { console.log(`• 跳过(已插入): ${label}`); return; }
  f.lines.splice(got.idx + 1, 0, newLine);
  console.log(`✓ 插入(after): ${label}`);
}

function insertBefore(f, label, anchor, newLine) {
  const got = findUnique(f.lines, anchor);
  if (got.idx === -1) throw new Error(`未找到锚点(before),已中止: ${label}\n锚点: ${JSON.stringify(anchor)}`);
  if (got.count > 1) throw new Error(`锚点(before)不唯一,已中止: ${label}`);
  if (f.lines[got.idx - 1] === newLine) { console.log(`• 跳过(已插入): ${label}`); return; }
  f.lines.splice(got.idx, 0, newLine);
  console.log(`✓ 插入(before): ${label}`);
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

// ============ chat.ts：G4 删诊断 + G6 cleanup ============
const chat = load(CHAT);

// G4-a：删除 diagFullStream 包装（从注释一直删到 createRuntimeEvent，含 const diagStream 行）
removeUntil(
  chat,
  'G4-a chat.ts: 删除 diagFullStream 包装',
  '            // [diag] 临时诊断（只读、可回滚）：透传包装 fullStream，逐块打印 chunk 类型，',
  '            const createRuntimeEvent = createRuntimeEventFactory({',
);

// G4-b：consumeTextStream 改回消费原始 stream
replaceLine(
  chat,
  'G4-b chat.ts: consumeTextStream 改用原始 stream',
  '                diagStream,',
  '                stream,',
);

// G4-c：删除 streamSummary 诊断打印
removeUntil(
  chat,
  'G4-c chat.ts: 删除 streamSummary 诊断打印',
  '            // [diag] 临时诊断（只读、可回滚）：打印本回合汇总——总 chunk 数、正文长度/预览、',
  '            if (streamSummary.streamErrorMessage) {',
);

// G4-d：删除 result 诊断打印
removeUntil(
  chat,
  'G4-d chat.ts: 删除 result 诊断打印',
  '            // [diag] 临时诊断（只读、可回滚）：打印本回合最终 result——若此处非空但前端气泡为空，',
  '            return {',
);

// G6-1：声明 streamCleanup（若上次已落盘会自动跳过）
insertAfter(
  chat,
  'G6-1 chat.ts: 声明 streamCleanup',
  '        let shouldDisconnectBundle = true;',
  '        let streamCleanup: (() => void) | undefined;',
);

// G6-2：捕获 stream.cleanup（必须在 G4-a 之后，因为 G4-a 用 createRuntimeEvent 作停止行）
insertBefore(
  chat,
  'G6-2 chat.ts: 捕获 stream.cleanup',
  '            const createRuntimeEvent = createRuntimeEventFactory({',
  '            streamCleanup = stream.cleanup;',
);

// G6-3：finally 中、仅在 shouldDisconnectBundle 为真时释放 stream（挂起续跑路径不释放）
insertAfter(
  chat,
  'G6-3 chat.ts: finally 释放 stream',
  '            if (shouldDisconnectBundle) {',
  '                streamCleanup?.();',
);

save(chat);

// ============ validation.ts：G5 prepare 异常兜底 ============
const valid = load(VALID);

replaceBlock(
  valid,
  'G5-1 validation.ts: validatePlan 兜底 prepare 异常',
  [
    "            'mastra-plan-validator-run',",
    "            '计划验证需要 planId 和 planVersion。',",
    '        );',
  ],
  [
    "            'mastra-plan-validator-run',",
    "            '计划验证需要 planId 和 planVersion。',",
    '        ).catch(',
    '            (error): { ok: false; response: IAgentRuntimeResponse } => ({',
    '                ok: false,',
    '                response: createErrorResponse(',
    '                    sessionId,',
    '                    `计划验证准备失败：${normalizeMastraError(error)}`,',
    '                    events,',
    '                    options,',
    '                ),',
    '            }),',
    '        );',
  ],
);

replaceBlock(
  valid,
  'G5-2 validation.ts: replanPlan 兜底 prepare 异常',
  [
    "            'mastra-plan-replanner-run',",
    "            '重新规划需要 planId 和 planVersion。',",
    '        );',
  ],
  [
    "            'mastra-plan-replanner-run',",
    "            '重新规划需要 planId 和 planVersion。',",
    '        ).catch(',
    '            (error): { ok: false; response: IAgentRuntimeResponse } => ({',
    '                ok: false,',
    '                response: createErrorResponse(',
    '                    sessionId,',
    '                    `重新规划准备失败：${normalizeMastraError(error)}`,',
    '                    events,',
    '                    options,',
    '                ),',
    '            }),',
    '        );',
  ],
);

save(valid);

console.log('\n全部完成。请运行 typecheck/test/lint 复核。');