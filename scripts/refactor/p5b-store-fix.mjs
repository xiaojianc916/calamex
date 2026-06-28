#!/usr/bin/env node
/*
 * P5b-2：从 src/store/aiAgent.ts 移除 orchestrationRunId（ref / zod / reset / setter /
 * 两处 return / persist pick）。
 *
 * 为何单独一脚本：p5b-drop-orchestrate-plumbing.mjs 的 zod 锁点误用 4 空格缩进（实际
 * zod 对象字面量内层为 2 空格），首锁点失配 → all-or-nothing 回退了整个 store。
 * ai.service.ts / sidecar-orchestrate.ts 那两处已本地改对，不能重跑，故本脚本只动 store。
 * 锁点均按当前 main 的精确字节（含真实缩进）核对。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const detectEol = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

const relPath = 'src/store/aiAgent.ts';
const abs = join(ROOT, relPath);
if (!existsSync(abs)) {
  console.error(`✗ 缺文件：${relPath}`);
  process.exit(1);
}

const edits = [
  {
    label: '删 zod 持久化字段 orchestrationRunId（2 空格缩进）',
    find: [
      '  // 原生编排 (createWorkflow) 单条 run 的 runId,用于把计划阶段 (plan_ready) 的 run',
      '  // 一直带到执行阶段 (resume)。default(null) 兼容旧持久化数据与既有测试。',
      '  orchestrationRunId: nullablePersistedTextSchema.default(null),',
      '',
    ].join('\n'),
    replace: '',
  },
  {
    label: '删 ref orchestrationRunId（4 空格）',
    find: [
      '    // 原生编排单条 run 的 runId(计划阶段产生,执行阶段 resume 复用)。',
      '    const orchestrationRunId = ref<string | null>(null);',
      '',
    ].join('\n'),
    replace: '',
  },
  {
    label: '删 resetPlanScaffold 中的置空（6 空格）',
    find: ['      orchestrationRunId.value = null;', ''].join('\n'),
    replace: '',
  },
  {
    label: '删 setOrchestrationRunId setter（4 空格）',
    find: [
      '    // 原生编排:把计划阶段拿到的 runId 写入 store,供执行阶段 resume 复用。',
      '    const setOrchestrationRunId = (runId: string | null): void => {',
      '      orchestrationRunId.value = runId;',
      '    };',
      '',
      '',
    ].join('\n'),
    replace: '',
  },
  {
    label: '删 return 中的 state 导出（6 空格）',
    find: ['      planVersions,', '      orchestrationRunId,', '      activeRunId,'].join('\n'),
    replace: ['      planVersions,', '      activeRunId,'].join('\n'),
  },
  {
    label: '删 return 中的 action 导出（6 空格）',
    find: ['      setPlan,', '      setOrchestrationRunId,', '      applyPlanMetadata,'].join('\n'),
    replace: ['      setPlan,', '      applyPlanMetadata,'].join('\n'),
  },
  {
    label: '删 persist pick 中的 orchestrationRunId（8 空格）',
    find: ["        'orchestrationRunId',", ''].join('\n'),
    replace: '',
  },
];

const original = readFileSync(abs, 'utf8');
const eol = detectEol(original);
let content = original.replace(/\r\n/g, '\n');

for (const edit of edits) {
  if (!content.includes(edit.find)) {
    console.error(`✗ ${relPath}：锁点缺失 — ${edit.label}`);
    console.error('【P5b-2：未写回】请把输出发回。');
    process.exit(1);
  }
  content = content.replace(edit.find, edit.replace);
  console.log(`  ✓ ${edit.label}`);
}

if (/orchestrationRunId/i.test(content)) {
  console.error(`✗ ${relPath}：仍残留 orchestrationRunId`);
  process.exit(1);
}

const next = eol === '\r\n' ? content.replace(/\n/g, '\r\n') : content;
writeFileSync(abs, next);
console.log(`已写回：${relPath}`);
console.log('\n✅ P5b-2 完成：store 中 orchestrationRunId 已清。接下来：');
console.log('  node scripts/refactor/residual-orchestrate-gate.mjs');
