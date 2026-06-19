#!/usr/bin/env node
/**
 * Slice 6 — plan-control 投影 parity(持久化 entries ↔ 渲染 VM)。
 *
 * 渲染 VM 路径(build-thread-entries.ts)从 legacy message.agentConfirmation
 * 产出 plan-control 条目;而持久化 entries 模型之前根本没有承载。
 * 本片新增持久化 plan_control entry 类型,并打通 legacy-adapter 映射
 * 与 thread-entries-to-timeline 投影,使两条投影管线对齐。
 * (live reduce 事件 plan_control_updated 留到渲染路径切换那一片。)
 *
 * 改动文件(5 源 + 4 spec):
 *  1) types/ai/thread/constants.ts                 — AI_THREAD_ENTRY_TYPES + 'plan_control'
 *  2) types/ai/thread/entry.schema.ts              — aiThreadPlanControlEntrySchema + 并入联合
 *  3) types/ai/thread/index.ts                     — infer IAiThreadPlanControlEntry + import/export 转出
 *  4) store/aiThread/legacy-adapter.ts             — agentConfirmation -> plan_control entry
 *  5) .../projection/thread-entries-to-timeline.ts — plan_control case(typecheck 强制)
 *  6) types/ai/thread/entry.schema.spec.ts
 *  7) store/aiThread/legacy-adapter.spec.ts
 *  8) .../projection/thread-entries-to-timeline.spec.ts
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

/* ===== 1) constants.ts ============================================== */
const CONSTS = 'src/types/ai/thread/constants.ts';
applyEdits(CONSTS, "'plan_control'", [
  [
    'add plan_control to AI_THREAD_ENTRY_TYPES',
    J([
      "  'tool_call',",
      "  'plan',",
      "  'context_compaction',",
      "  'changed_files',",
      '] as const;',
    ]),
    J([
      "  'tool_call',",
      "  'plan',",
      "  'plan_control',",
      "  'context_compaction',",
      "  'changed_files',",
      '] as const;',
    ]),
  ],
]);

/* ===== 2) entry.schema.ts ========================================== */
const ENTRY_SCHEMA = 'src/types/ai/thread/entry.schema.ts';
applyEdits(ENTRY_SCHEMA, 'aiThreadPlanControlEntrySchema', [
  [
    'add aiThreadPlanControlEntrySchema definition',
    J([
      'export const aiThreadPlanEntrySchema = z.object({',
      "  type: z.literal('plan'),",
      '  id: z.string().min(1),',
      '  createdAt: z.string().min(1),',
      '  steps: z.array(aiTaskPlanStepSchema),',
      '});',
      '',
      '/** Context compaction entry（对标 `ContextCompaction`）。 */',
    ]),
    J([
      'export const aiThreadPlanEntrySchema = z.object({',
      "  type: z.literal('plan'),",
      '  id: z.string().min(1),',
      '  createdAt: z.string().min(1),',
      '  steps: z.array(aiTaskPlanStepSchema),',
      '});',
      '',
      '/**',
      ' * Plan 控制 entry（审批 / 运行控制，对标渲染层 plan-control）。承载目标与引用，',
      ' * phase 区分待批准 / 运行中。由 legacy-adapter 从 agentConfirmation 映射，',
      ' * 投影层据此把审批卡并入平铺时间线（非独立仪表盘）。',
      ' */',
      'export const aiThreadPlanControlEntrySchema = z.object({',
      "  type: z.literal('plan_control'),",
      '  id: z.string().min(1),',
      '  createdAt: z.string().min(1),',
      '  goal: z.string().min(1),',
      '  references: z.array(aiContextReferenceSchema).default([]),',
      "  phase: z.enum(['awaiting-approval', 'running']),",
      '});',
      '',
      '/** Context compaction entry（对标 `ContextCompaction`）。 */',
    ]),
  ],
  [
    'add to discriminatedUnion',
    J([
      '  aiThreadPlanEntrySchema,',
      '  aiThreadContextCompactionEntrySchema,',
      '  aiThreadChangedFilesEntrySchema,',
      ']);',
    ]),
    J([
      '  aiThreadPlanEntrySchema,',
      '  aiThreadPlanControlEntrySchema,',
      '  aiThreadContextCompactionEntrySchema,',
      '  aiThreadChangedFilesEntrySchema,',
      ']);',
    ]),
  ],
]);

/* ===== 3) types/ai/thread/index.ts ================================= */
const THREAD_BARREL = 'src/types/ai/thread/index.ts';
applyEdits(THREAD_BARREL, 'IAiThreadPlanControlEntry', [
  [
    'import type block + plan-control schema',
    J([
      'import type {',
      '  aiThreadAssistantChunkSchema,',
      '  aiThreadAssistantMessageEntrySchema,',
      '  aiThreadChangedFilesEntrySchema,',
      '  aiThreadContextCompactionEntrySchema,',
      '  aiThreadEntrySchema,',
      '  aiThreadPlanEntrySchema,',
      '  aiThreadSchema,',
      '  aiThreadUserMessageEntrySchema,',
      "} from '@/types/ai/thread/entry.schema';",
    ]),
    J([
      'import type {',
      '  aiThreadAssistantChunkSchema,',
      '  aiThreadAssistantMessageEntrySchema,',
      '  aiThreadChangedFilesEntrySchema,',
      '  aiThreadContextCompactionEntrySchema,',
      '  aiThreadEntrySchema,',
      '  aiThreadPlanControlEntrySchema,',
      '  aiThreadPlanEntrySchema,',
      '  aiThreadSchema,',
      '  aiThreadUserMessageEntrySchema,',
      "} from '@/types/ai/thread/entry.schema';",
    ]),
  ],
  [
    'infer IAiThreadPlanControlEntry',
    J([
      'export type IAiThreadPlanEntry = z.infer<typeof aiThreadPlanEntrySchema>;',
      'export type IAiThreadContextCompactionEntry = z.infer<typeof aiThreadContextCompactionEntrySchema>;',
    ]),
    J([
      'export type IAiThreadPlanEntry = z.infer<typeof aiThreadPlanEntrySchema>;',
      'export type IAiThreadPlanControlEntry = z.infer<typeof aiThreadPlanControlEntrySchema>;',
      'export type IAiThreadContextCompactionEntry = z.infer<typeof aiThreadContextCompactionEntrySchema>;',
    ]),
  ],
  [
    'export value block + plan-control schema',
    J([
      'export {',
      '  aiThreadAssistantChunkSchema,',
      '  aiThreadAssistantMessageEntrySchema,',
      '  aiThreadChangedFilesEntrySchema,',
      '  aiThreadContextCompactionEntrySchema,',
      '  aiThreadEntrySchema,',
      '  aiThreadPlanEntrySchema,',
      '  aiThreadSchema,',
      '  aiThreadUserMessageEntrySchema,',
      "} from '@/types/ai/thread/entry.schema';",
    ]),
    J([
      'export {',
      '  aiThreadAssistantChunkSchema,',
      '  aiThreadAssistantMessageEntrySchema,',
      '  aiThreadChangedFilesEntrySchema,',
      '  aiThreadContextCompactionEntrySchema,',
      '  aiThreadEntrySchema,',
      '  aiThreadPlanControlEntrySchema,',
      '  aiThreadPlanEntrySchema,',
      '  aiThreadSchema,',
      '  aiThreadUserMessageEntrySchema,',
      "} from '@/types/ai/thread/entry.schema';",
    ]),
  ],
]);

/* ===== 4) legacy-adapter.ts ======================================== */
const LEGACY = 'src/store/aiThread/legacy-adapter.ts';
applyEdits(LEGACY, "type: 'plan_control'", [
  [
    'map agentConfirmation -> plan_control entry',
    J([
      '  if (message.content.trim().length > 0) {',
      '    entries.push({',
      "      type: 'assistant_message',",
      '      id: message.id,',
      '      createdAt: message.createdAt,',
      "      chunks: [{ type: 'message', block: { type: 'text', text: message.content } }],",
      '    });',
      '  }',
      '  if (message.changedFilesSummary) {',
    ]),
    J([
      '  if (message.content.trim().length > 0) {',
      '    entries.push({',
      "      type: 'assistant_message',",
      '      id: message.id,',
      '      createdAt: message.createdAt,',
      "      chunks: [{ type: 'message', block: { type: 'text', text: message.content } }],",
      '    });',
      '  }',
      '  if (message.agentConfirmation) {',
      '    entries.push({',
      "      type: 'plan_control',",
      "      id: `${message.id}:plan-control`,",
      '      createdAt: message.createdAt,',
      '      goal: message.agentConfirmation.goal,',
      '      references: message.agentConfirmation.references,',
      "      phase: message.agentConfirmation.status === 'running' ? 'running' : 'awaiting-approval',",
      '    });',
      '  }',
      '  if (message.changedFilesSummary) {',
    ]),
  ],
]);

/* ===== 5) thread-entries-to-timeline.ts ============================ */
const T2T = 'src/components/business/ai/thread/projection/thread-entries-to-timeline.ts';
applyEdits(T2T, "case 'plan_control'", [
  [
    'doc: plan-control now projected',
    J([
      ' * - plan 条目暂不进平铺时间线(计划步骤仍由 deriveThreadPlanDetails 的独立面板渲染;',
      ' *   plan-control 审批卡留待批准接线那一片),故此处跳过。',
    ]),
    J([
      ' * - plan 条目暂不进平铺时间线(计划步骤仍由 deriveThreadPlanDetails 的独立面板渲染),故跳过。',
      ' * - plan_control 审批卡投影为 plan-control 条目并入平铺时间线。',
    ]),
  ],
  [
    'add plan_control case',
    J([
      "      case 'plan': {",
      '        // 本片刻意跳过:plan 步骤由独立面板渲染,不进平铺时间线。',
      '        break;',
      '      }',
      "      case 'context_compaction': {",
    ]),
    J([
      "      case 'plan': {",
      '        // 本片刻意跳过:plan 步骤由独立面板渲染,不进平铺时间线。',
      '        break;',
      '      }',
      "      case 'plan_control': {",
      '        timeline.push({',
      "          kind: 'plan-control',",
      '          id: entry.id,',
      '          messageId: entry.id,',
      '          goal: entry.goal,',
      '          references: entry.references,',
      '          phase: entry.phase,',
      '        });',
      '        break;',
      '      }',
      "      case 'context_compaction': {",
    ]),
  ],
]);

/* ===== 6) entry.schema.spec.ts ===================================== */
const ENTRY_SCHEMA_SPEC = 'src/types/ai/thread/entry.schema.spec.ts';
applyEdits(ENTRY_SCHEMA_SPEC, 'plan_control 解析 goal/phase', [
  [
    'add plan_control schema tests',
    "  it('拒绝非法的工具调用状态', () => {",
    J([
      "  it('plan_control 解析 goal/phase, references 缺省兜底空数组', () => {",
      '    const parsed = aiThreadEntrySchema.parse({',
      "      type: 'plan_control',",
      "      id: 'pc1',",
      '      createdAt: ISO,',
      "      goal: '迁移流式渲染',",
      "      phase: 'awaiting-approval',",
      '    });',
      "    expect(parsed.type).toBe('plan_control');",
      "    if (parsed.type === 'plan_control') {",
      "      expect(parsed.goal).toBe('迁移流式渲染');",
      "      expect(parsed.phase).toBe('awaiting-approval');",
      '      expect(parsed.references).toEqual([]);',
      '    }',
      '  });',
      '',
      "  it('plan_control 拒绝非法 phase', () => {",
      '    expect(() =>',
      '      aiThreadEntrySchema.parse({',
      "        type: 'plan_control',",
      "        id: 'pc2',",
      '        createdAt: ISO,',
      "        goal: 'x',",
      "        phase: 'done',",
      '      }),',
      '    ).toThrow();',
      '  });',
      '',
      "  it('拒绝非法的工具调用状态', () => {",
    ]),
  ],
]);

/* ===== 7) legacy-adapter.spec.ts =================================== */
const LEGACY_SPEC = 'src/store/aiThread/legacy-adapter.spec.ts';
applyEdits(LEGACY_SPEC, 'agentConfirmation.status=running -> phase=running', [
  [
    'add agentConfirmation -> plan_control tests',
    "  it('inferToolKind 启发式', () => {",
    J([
      "  it('assistant + agentConfirmation -> plan_control(在 assistant_message 之后)', () => {",
      '    const ref: IAiContextReference = {',
      "      id: 'r1',",
      "      kind: 'selection',",
      "      label: 'sel',",
      "      path: 'src/a.ts',",
      '      range: { startLine: 1, endLine: 2 },',
      "      contentPreview: 'x',",
      '      redacted: false,',
      '    };',
      '    const entries = legacyMessageToEntries({',
      "      id: 'a1',",
      "      role: 'assistant',",
      "      content: '方案如下',",
      '      createdAt: ISO,',
      '      references: [],',
      "      agentConfirmation: { goal: '迁移流式渲染', references: [ref], status: 'pending' },",
      '    });',
      "    expect(entries.map((e) => e.type)).toEqual(['assistant_message', 'plan_control']);",
      '    const control = entries[1];',
      "    if (control.type === 'plan_control') {",
      "      expect(control.id).toBe('a1:plan-control');",
      "      expect(control.goal).toBe('迁移流式渲染');",
      "      expect(control.phase).toBe('awaiting-approval');",
      '      expect(control.references).toEqual([ref]);',
      '    }',
      '  });',
      '',
      "  it('agentConfirmation.status=running -> phase=running', () => {",
      '    const entries = legacyMessageToEntries({',
      "      id: 'a2',",
      "      role: 'assistant',",
      "      content: '',",
      '      createdAt: ISO,',
      '      references: [],',
      "      agentConfirmation: { goal: 'g', references: [], status: 'running' },",
      '    });',
      "    expect(entries.map((e) => e.type)).toEqual(['plan_control']);",
      '    const control = entries[0];',
      "    if (control.type === 'plan_control') {",
      "      expect(control.phase).toBe('running');",
      '    }',
      '  });',
      '',
      "  it('inferToolKind 启发式', () => {",
    ]),
  ],
]);

/* ===== 8) thread-entries-to-timeline.spec.ts ====================== */
const T2T_SPEC = 'src/components/business/ai/thread/projection/thread-entries-to-timeline.spec.ts';
applyEdits(T2T_SPEC, 'plan_control 投影为 plan-control', [
  [
    'add plan_control projection test',
    "  it('混合 entries 保持输入顺序', () => {",
    J([
      "  it('plan_control 投影为 plan-control 条目', () => {",
      '    const reference: IAiContextReference = {',
      "      id: 'r1',",
      "      kind: 'current-file',",
      "      label: 'foo.ts',",
      "      path: 'src/foo.ts',",
      '      range: null,',
      "      contentPreview: '',",
      '      redacted: false,',
      '    };',
      '    const entries: IAiThreadEntry[] = [',
      '      {',
      "        type: 'plan_control',",
      "        id: 'pc1',",
      '        createdAt: ISO,',
      "        goal: '迁移流式渲染',",
      '        references: [reference],',
      "        phase: 'awaiting-approval',",
      '      },',
      '    ];',
      '    const timeline = threadEntriesToTimeline(entries);',
      '    expect(timeline).toHaveLength(1);',
      '    const entry = timeline[0];',
      "    expect(entry.kind).toBe('plan-control');",
      "    if (entry.kind === 'plan-control') {",
      "      expect(entry.id).toBe('pc1');",
      "      expect(entry.goal).toBe('迁移流式渲染');",
      '      expect(entry.references).toEqual([reference]);',
      "      expect(entry.phase).toBe('awaiting-approval');",
      '    }',
      '  });',
      '',
      "  it('混合 entries 保持输入顺序', () => {",
    ]),
  ],
]);

log('DONE');