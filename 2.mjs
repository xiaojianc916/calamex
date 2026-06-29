// fix-ai-review-batch-10.mjs  (J1: reproject CAS 落败后有界重投影重试)
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const STORE = 'builtin-agent/src/engines/plan/plan-workflow-store/store.ts';

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
function findBlock(lines, block, from = 0) {
  for (let i = from; i + block.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < block.length; j++) if (lines[i + j] !== block[j]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
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
function insertBefore(f, label, anchor, newLines) {
  if (findBlock(f.lines, newLines) !== -1) { console.log(`• 跳过(已插入): ${label}`); return; }
  let idx = -1, count = 0;
  for (let i = 0; i < f.lines.length; i++) if (f.lines[i] === anchor) { count++; if (idx === -1) idx = i; }
  if (idx === -1) throw new Error(`未找到锚点,已中止: ${label}`);
  if (count > 1) throw new Error(`锚点不唯一,已中止: ${label}`);
  f.lines.splice(idx, 0, ...newLines);
  console.log(`✓ 插入: ${label}`);
}

const f = load(STORE);

// 1) 新增有界重试常量（置于 class 之前）
insertBefore(
  f,
  'J1-const: REPROJECT_MAX_ATTEMPTS',
  'export class LibsqlAgentPlanWorkflowStore implements IAgentPlanWorkflowStore {',
  [
    '// reproject 的 CAS 乐观锁在并发落败时的有界重投影重试上限，防止陈旧投影覆盖较新投影。',
    'const REPROJECT_MAX_ATTEMPTS = 5;',
    '',
  ],
);

// 2) reproject 签名加 attempt 计数
replaceBlock(
  f,
  'J1-sig: reproject 增加 attempt 参数',
  [
    '    private async reproject(input: IPlanWorkflowVersionInput): Promise<TAgentPlanWorkflowRecord> {',
  ],
  [
    '    private async reproject(',
    '        input: IPlanWorkflowVersionInput,',
    '        attempt = 0,',
    '    ): Promise<TAgentPlanWorkflowRecord> {',
  ],
);

// 3) CAS 落败分支：重读事件流→重投影→重试（有界）
replaceBlock(
  f,
  'J1-retry: CAS 落败重投影重试',
  [
    '        if (updateResult.rowsAffected !== 1) {',
    '            // 另一个并发流程刚好抢先写了一版；重新读最新结果即可。事件流是单调追加，',
    '            // 任何并发的 reproject 最终都会收敛到同一状态。',
    '            return this.getWorkflow(input);',
    '        }',
    '        return this.getWorkflow(input);',
  ],
  [
    '        if (updateResult.rowsAffected !== 1) {',
    '            // CAS 落败：有并发 reproject 抢先写入。若直接返回，较旧（事件更少）的投影',
    '            // 可能已覆盖较新的投影，导致持久化状态落后于事件流；故重读事件流后重投影重试。',
    '            if (attempt + 1 < REPROJECT_MAX_ATTEMPTS) {',
    '                return this.reproject(input, attempt + 1);',
    '            }',
    '            return this.getWorkflow(input);',
    '        }',
    '        return this.getWorkflow(input);',
  ],
);

save(f);
console.log('\nbatch-10 (J1) 完成。请运行 typecheck/test/lint 复核。');