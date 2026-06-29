// fix-ai-review-batch-9.mjs  (I1 完整版：删死分支 + 折叠 resumeStream/approve 别名链)
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const CLIENT = 'builtin-agent/src/engines/approval/client.ts';

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
  if (signatureLine && findUnique(f.lines, signatureLine).count === 0) {
    console.log(`• 跳过(已删除): ${label}`);
    return;
  }
  throw new Error(`未找到待删除块(形状可能已变),已中止: ${label}\n签名行: ${JSON.stringify(signatureLine)}`);
}
function replaceLine(f, label, oldLine, newLine) {
  const { idx, count } = findUnique(f.lines, oldLine);
  if (idx !== -1) {
    if (count > 1) throw new Error(`待替换行不唯一,已中止: ${label}`);
    f.lines[idx] = newLine;
    console.log(`✓ 替换行: ${label}`);
    return;
  }
  if (findUnique(f.lines, newLine).count >= 1) {
    console.log(`• 跳过(已替换): ${label}`);
    return;
  }
  throw new Error(`未找到待替换行,已中止: ${label}\n期望: ${JSON.stringify(oldLine)}`);
}

const f = load(CLIENT);

// —— 1) 删除 kind==='approval' 不可达防御块（被 canContinue 完全覆盖）——
removeExactBlock(
  f,
  "I1-A: kind==='approval' 死分支",
  [
    "        if (",
    "            pending.kind === 'approval' &&",
    "            typeof resumeContinueStream !== 'function' &&",
    "            typeof approvalContinueStream !== 'function'",
    "        ) {",
    "            await pending.bundle.disconnectAll();",
    "            await destroyMastraWorkspace(pending.workspace);",
    "            await destroyMastraBrowser(pending.browser);",
    "            return this.createFallbackApprovalResponse(input, sessionId, options);",
    "        }",
  ],
  "            pending.kind === 'approval' &&",
);

// —— 2) 删除 kind==='suspended' 不可达防御块 ——
removeExactBlock(
  f,
  "I1-B: kind==='suspended' 死分支",
  [
    "        if (pending.kind === 'suspended' && typeof continueSuspendedStream !== 'function') {",
    "            await pending.bundle.disconnectAll();",
    "            await destroyMastraWorkspace(pending.workspace);",
    "            await destroyMastraBrowser(pending.browser);",
    "            return this.createFallbackApprovalResponse(input, sessionId, options);",
    "        }",
  ],
  "        if (pending.kind === 'suspended' && typeof continueSuspendedStream !== 'function') {",
);

// —— 3) 删除 4 行冗余别名（删完死分支后它们已相邻）——
removeExactBlock(
  f,
  "I1-C: resumeStream/approve 冗余别名链",
  [
    "        const continueSuspendedStream = resumeContinueStream;",
    "        const resumeSuspendedTool = continueSuspendedStream;",
    "        const resumeApprovalRun = resumeContinueStream;",
    "        const resumeApprovalTool = approvalContinueStream;",
  ],
  "        const continueSuspendedStream = resumeContinueStream;",
);

// —— 4) 调用点改用语义名（每条原文本唯一，逐条替换）——
replaceLine(f, "I1-D1: suspended 守卫改名",
  "                if (typeof resumeSuspendedTool !== 'function') {",
  "                if (typeof resumeContinueStream !== 'function') {");
replaceLine(f, "I1-D2: suspended 调用改名",
  "                stream = await resumeSuspendedTool({",
  "                stream = await resumeContinueStream({");
replaceLine(f, "I1-D3: approval-resume 分支改名",
  "            } else if (typeof resumeApprovalRun === 'function') {",
  "            } else if (typeof resumeContinueStream === 'function') {");
replaceLine(f, "I1-D4: approval-resume 调用改名",
  "                stream = await resumeApprovalRun({",
  "                stream = await resumeContinueStream({");
replaceLine(f, "I1-D5: approve/decline 守卫改名",
  "                if (typeof resumeApprovalTool !== 'function') {",
  "                if (typeof approvalContinueStream !== 'function') {");
replaceLine(f, "I1-D6: approve/decline 调用改名",
  "                stream = await resumeApprovalTool(resumeOptions);",
  "                stream = await approvalContinueStream(resumeOptions);");

save(f);
console.log('\nbatch-9 (I1 完整) 完成。请运行 typecheck/test/lint 复核。');