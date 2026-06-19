#!/usr/bin/env node
/**
 * Slice 7 — plan_control reduce 侧补全(live 路径)。
 *
 * S6 已落地持久化 schema + legacy-adapter 映射 + 投影(thread-entries-to-timeline)。
 * 本片补上对称的 reduce 事件,使 live 线程也能经 reduce 构建 plan_control entry,
 * 与「每个 entry 类型都有其 reduce 事件」的既有约定对齐(对标 Slice 4 的 references)。
 *
 * 改动文件(2 源 + 1 spec):
 *  1) store/aiThread/events.ts      — 联合新增 plan_control_updated 事件 + import + 文档
 *  2) store/aiThread/reduce.ts      — upsertPlanControlEntry(按 id upsert,保留首次 createdAt)+ case
 *  3) store/aiThread/reduce.spec.ts — plan_control_updated 回放测试 + import
 *
 * 幂等:每文件 marker;每处 find/replace 命中==1;逐文件探测 EOL 按原样写回。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = process.cwd();
const log = (m) => process.stdout.write(`${m}\n`);

const detectEol = (s) => (/\r\n/.test(s) ? '\r\n' : '\n');
const toEol = (s, eol) => s.replace(/\r\n/g, '\n').replace(/\n/g, eol);

const readRel = (rel) => {
  const p = resolve(ROOT, rel);
  if (!existsSync(p)) throw new Error(`MISSING_FILE: ${rel}`);
  return readFileSync(p, 'utf8');
};
const writeRel = (rel, content) => {
  const p = resolve(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
};

const applyEdits = (rel, marker, edits) => {
  let src = readRel(rel);
  const eol = detectEol(src);
  if (src.includes(toEol(marker, eol))) {
    log(`SKIP (already applied): ${rel}`);
    return;
  }
  for (const [label, find, replace] of edits) {
    const f = toEol(find, eol);
    const r = toEol(replace, eol);
    const hits = src.split(f).length - 1;
    if (hits !== 1) throw new Error(`EXPECT_1_GOT_${hits} :: ${rel} :: ${label}`);
    src = src.split(f).join(r);
  }
  writeRel(rel, src);
  log(`PATCHED (${eol === '\r\n' ? 'CRLF' : 'LF'}): ${rel}`);
};

const J = (lines) => lines.join('\n');

/* ===== 1) events.ts ================================================= */
const EVENTS = 'src/store/aiThread/events.ts';
applyEdits(EVENTS, 'plan_control_updated', [
  [
    'doc: plan_control_updated semantics',
    J([
      ' * - `plan_updated` → 按 id upsert plan entry（整体替换 steps，位置稳定）',
      ' * - `context_compaction` → 追加 context_compaction entry',
    ]),
    J([
      ' * - `plan_updated` → 按 id upsert plan entry（整体替换 steps，位置稳定）',
      ' * - `plan_control_updated` → 按 id upsert plan_control entry（替换 goal/phase/references，位置稳定）',
      ' * - `context_compaction` → 追加 context_compaction entry',
    ]),
  ],
  [
    'import IAiThreadPlanControlEntry',
    J([
      'import type {',
      '  IAiThreadChangedFilesEntry,',
      '  IAiThreadContentBlock,',
      '  IAiThreadPlanEntry,',
      '  IAiThreadToolCallContent,',
      '  TAiThreadToolKind,',
      "} from '@/types/ai/thread';",
    ]),
    J([
      'import type {',
      '  IAiThreadChangedFilesEntry,',
      '  IAiThreadContentBlock,',
      '  IAiThreadPlanControlEntry,',
      '  IAiThreadPlanEntry,',
      '  IAiThreadToolCallContent,',
      '  TAiThreadToolKind,',
      "} from '@/types/ai/thread';",
    ]),
  ],
  [
    'add plan_control_updated to reduce-event union',
    J([
      '  | {',
      "      kind: 'plan_updated';",
      '      id: string;',
      '      createdAt: string;',
      "      steps: IAiThreadPlanEntry['steps'];",
      '    }',
      '  | {',
      "      kind: 'context_compaction';",
    ]),
    J([
      '  | {',
      "      kind: 'plan_updated';",
      '      id: string;',
      '      createdAt: string;',
      "      steps: IAiThreadPlanEntry['steps'];",
      '    }',
      '  | {',
      "      kind: 'plan_control_updated';",
      '      id: string;',
      '      createdAt: string;',
      '      goal: string;',
      '      references?: IAiContextReference[];',
      "      phase: IAiThreadPlanControlEntry['phase'];",
      '    }',
      '  | {',
      "      kind: 'context_compaction';",
    ]),
  ],
]);

/* ===== 2) reduce.ts ================================================= */
const REDUCE = 'src/store/aiThread/reduce.ts';
applyEdits(REDUCE, 'upsertPlanControlEntry', [
  [
    'add upsertPlanControlEntry function',
    J([
      '  const merged: IAiThreadEntry = {',
      "    type: 'plan',",
      '    id: event.id,',
      '    createdAt: current.createdAt,',
      '    steps: event.steps,',
      '  };',
      '  return { ...thread, entries: replaceAt(thread.entries, index, merged) };',
      '}',
      '',
      '/* ----- Context compaction (ContextCompaction) ----------------------------- */',
    ]),
    J([
      '  const merged: IAiThreadEntry = {',
      "    type: 'plan',",
      '    id: event.id,',
      '    createdAt: current.createdAt,',
      '    steps: event.steps,',
      '  };',
      '  return { ...thread, entries: replaceAt(thread.entries, index, merged) };',
      '}',
      '',
      '/* ----- Plan-control upsert (plan-control 审批/运行控制) -------------------- */',
      '/**',
      ' * plan_control 条目按 id upsert：首次出现追加到末尾；再次出现替换',
      ' * goal / phase / references，但保留首次出现的 createdAt 以稳定其在时间线',
      ' * 中的位置（对标 plan_updated 的位置稳定语义）。',
      ' */',
      'function upsertPlanControlEntry(',
      '  thread: IAiThread,',
      "  event: TAiThreadReduceEventByKind<'plan_control_updated'>,",
      '): IAiThread {',
      '  const index = thread.entries.findIndex(',
      "    (entry) => entry.type === 'plan_control' && entry.id === event.id,",
      '  );',
      '',
      '  if (index === -1) {',
      '    const entry: IAiThreadEntry = {',
      "      type: 'plan_control',",
      '      id: event.id,',
      '      createdAt: event.createdAt,',
      '      goal: event.goal,',
      '      references: event.references ?? [],',
      '      phase: event.phase,',
      '    };',
      '    return { ...thread, entries: [...thread.entries, entry] };',
      '  }',
      '',
      '  const current = thread.entries[index];',
      '  const merged: IAiThreadEntry = {',
      "    type: 'plan_control',",
      '    id: event.id,',
      '    createdAt: current.createdAt,',
      '    goal: event.goal,',
      '    references: event.references ?? [],',
      '    phase: event.phase,',
      '  };',
      '  return { ...thread, entries: replaceAt(thread.entries, index, merged) };',
      '}',
      '',
      '/* ----- Context compaction (ContextCompaction) ----------------------------- */',
    ]),
  ],
  [
    'add plan_control_updated case to reduceThread switch',
    J([
      "    case 'plan_updated':",
      '      return upsertPlanEntry(thread, event);',
      "    case 'context_compaction':",
    ]),
    J([
      "    case 'plan_updated':",
      '      return upsertPlanEntry(thread, event);',
      "    case 'plan_control_updated':",
      '      return upsertPlanControlEntry(thread, event);',
      "    case 'context_compaction':",
    ]),
  ],
]);

/* ===== 3) reduce.spec.ts =========================================== */
const REDUCE_SPEC = 'src/store/aiThread/reduce.spec.ts';
applyEdits(REDUCE_SPEC, 'plan_control_updated 创建', [
  [
    'import IAiThreadPlanControlEntry',
    J(['  IAiThreadContextCompactionEntry,', '  IAiThreadPlanEntry,']),
    J([
      '  IAiThreadContextCompactionEntry,',
      '  IAiThreadPlanControlEntry,',
      '  IAiThreadPlanEntry,',
    ]),
  ],
  [
    'add plan_control_updated reduce test',
    "  it('nextToolStatus 状态机', () => {",
    J([
      "  it('plan_control_updated 创建 plan_control entry；再次同 id 替换 goal/phase/references，保留 createdAt', () => {",
      '    let thread = createThread();',
      '    thread = reduceThread(thread, {',
      "      kind: 'plan_control_updated',",
      "      id: 'pc1',",
      '      createdAt: ISO,',
      "      goal: '迁移流式渲染',",
      "      phase: 'awaiting-approval',",
      '    });',
      "    expect(thread.entries.filter((e) => e.type === 'plan_control')).toHaveLength(1);",
      '    const first = thread.entries[0] as IAiThreadPlanControlEntry;',
      '    expect(first.references).toEqual([]);',
      "    expect(first.phase).toBe('awaiting-approval');",
      '',
      '    const ref: IAiContextReference = {',
      "      id: 'r1',",
      "      kind: 'current-file',",
      "      label: 'foo.ts',",
      "      path: 'src/foo.ts',",
      '      range: null,',
      "      contentPreview: '',",
      '      redacted: false,',
      '    };',
      '    thread = reduceThread(thread, {',
      "      kind: 'plan_control_updated',",
      "      id: 'pc1',",
      "      createdAt: '2026-06-14T09:07:00.000Z',",
      "      goal: '迁移流式渲染（运行中）',",
      '      references: [ref],',
      "      phase: 'running',",
      '    });',
      '',
      '    const controls = thread.entries.filter(',
      "      (e) => e.type === 'plan_control',",
      '    ) as IAiThreadPlanControlEntry[];',
      '    expect(controls).toHaveLength(1);',
      "    expect(controls[0].goal).toBe('迁移流式渲染（运行中）');",
      "    expect(controls[0].phase).toBe('running');",
      '    expect(controls[0].references).toEqual([ref]);',
      '    // 保留首次出现的 createdAt，位置稳定',
      '    expect(controls[0].createdAt).toBe(ISO);',
      '  });',
      '',
      "  it('nextToolStatus 状态机', () => {",
    ]),
  ],
]);

log('DONE');