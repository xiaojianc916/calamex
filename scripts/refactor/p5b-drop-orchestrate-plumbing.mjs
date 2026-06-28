#!/usr/bin/env node
/*
 * P5b-1：删除 legacy orchestrate 前端管线的「叶子层」（一次性脚本）。
 *
 * 背景：sidecar-orchestrate.ts → aiService.sidecarOrchestrate(Resume) →
 * tauriService.agentSidecarOrchestrate(Resume) 这条链的最底层 tauri 方法已在 P5a
 * 随 orchestrate 扩展方法一并移除，故 ai.service.ts 当前已不可编译（调用不存在的方法）。
 * 本脚本顺链而上删除这条死链：
 *   1. 删除 src/composables/ai/sidecar-orchestrate.ts（整文件）
 *   2. src/services/ipc/ai.service.ts：删 sidecarOrchestrate / sidecarOrchestrateResume 两方法 + 3 个类型 import
 *   3. src/store/aiAgent.ts：删 orchestrationRunId（ref / zod / reset / setter / 两处 return / persist pick）
 *
 * 消费者 useAiAgentPlan.ts / useAiAgentRun.ts 改写为原生 session/prompt 流见后续单元。
 * 一次性：锁点为逐字匹配，任一缺失即 all-or-nothing 跳过该文件并报错；
 * 每个文件改完追加「残留断言」兼底。退出码：0 = 全部成功；1 = 出现错误。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const detectEol = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

let hadError = false;

// ---- 1. 删除 sidecar-orchestrate.ts ----
const orchestrateFile = join(ROOT, 'src/composables/ai/sidecar-orchestrate.ts');
if (existsSync(orchestrateFile)) {
  rmSync(orchestrateFile);
  console.log('已删除：src/composables/ai/sidecar-orchestrate.ts');
} else {
  console.log('跳过（已不存在）：src/composables/ai/sidecar-orchestrate.ts');
}

// ---- 通用：对单个文件应用一组 {find, replace}（all-or-nothing） ----
const applyEdits = (relPath, edits, assertCleanRe) => {
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) {
    console.error(`✗ 缺文件：${relPath}`);
    hadError = true;
    return;
  }
  const original = readFileSync(abs, 'utf8');
  const eol = detectEol(original);
  let content = original.replace(/\r\n/g, '\n');
  for (const edit of edits) {
    if (!content.includes(edit.find)) {
      console.error(`✗ ${relPath}：锁点缺失 — ${edit.label}`);
      hadError = true;
      return;
    }
    content = content.replace(edit.find, edit.replace);
    console.log(`  ✓ ${relPath}：${edit.label}`);
  }
  if (assertCleanRe && assertCleanRe.test(content)) {
    console.error(`✗ ${relPath}：仍残留 ${assertCleanRe}`);
    hadError = true;
    return;
  }
  const next = eol === '\r\n' ? content.replace(/\n/g, '\r\n') : content;
  writeFileSync(abs, next);
  console.log(`已写回：${relPath}`);
};

// ---- 2. ai.service.ts ----
applyEdits(
  'src/services/ipc/ai.service.ts',
  [
    {
      label: '删 3 个 orchestrate 类型 import',
      find: [
        '  IAgentSidecarHealthPayload,',
        '  IAgentSidecarOrchestratePayload,',
        '  IAgentSidecarOrchestrateRequest,',
        '  IAgentSidecarOrchestrateResumeRequest,',
        '  IAgentSidecarResponsePayload,',
      ].join('\n'),
      replace: ['  IAgentSidecarHealthPayload,', '  IAgentSidecarResponsePayload,'].join('\n'),
    },
    {
      label: '删 sidecarOrchestrate / sidecarOrchestrateResume 两方法',
      find: [
        '  sidecarOrchestrate(',
        '    payload: IAgentSidecarOrchestrateRequest,',
        '  ): Promise<IAgentSidecarOrchestratePayload> {',
        '    return tauriService.agentSidecarOrchestrate(payload);',
        '  },',
        '  sidecarOrchestrateResume(',
        '    payload: IAgentSidecarOrchestrateResumeRequest,',
        '  ): Promise<IAgentSidecarOrchestratePayload> {',
        '    return tauriService.agentSidecarOrchestrateResume(payload);',
        '  },',
        '',
      ].join('\n'),
      replace: '',
    },
  ],
  /orchestrate/i,
);

// ---- 3. store/aiAgent.ts ----
applyEdits(
  'src/store/aiAgent.ts',
  [
    {
      label: '删 zod 持久化字段 orchestrationRunId',
      find: [
        '    // 原生编排 (createWorkflow) 单条 run 的 runId,用于把计划阶段 (plan_ready) 的 run',
        '    // 一直带到执行阶段 (resume)。default(null) 兼容旧持久化数据与既有测试。',
        '    orchestrationRunId: nullablePersistedTextSchema.default(null),',
        '',
      ].join('\n'),
      replace: '',
    },
    {
      label: '删 ref orchestrationRunId',
      find: [
        '    // 原生编排单条 run 的 runId(计划阶段产生,执行阶段 resume 复用)。',
        '    const orchestrationRunId = ref<string | null>(null);',
        '',
      ].join('\n'),
      replace: '',
    },
    {
      label: '删 resetPlanScaffold 中的置空',
      find: ['      orchestrationRunId.value = null;', ''].join('\n'),
      replace: '',
    },
    {
      label: '删 setOrchestrationRunId setter',
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
      label: '删 return 中的 state 导出',
      find: ['      planVersions,', '      orchestrationRunId,', '      activeRunId,'].join('\n'),
      replace: ['      planVersions,', '      activeRunId,'].join('\n'),
    },
    {
      label: '删 return 中的 action 导出',
      find: ['      setPlan,', '      setOrchestrationRunId,', '      applyPlanMetadata,'].join('\n'),
      replace: ['      setPlan,', '      applyPlanMetadata,'].join('\n'),
    },
    {
      label: '删 persist pick 中的 orchestrationRunId',
      find: ["        'orchestrationRunId',", ''].join('\n'),
      replace: '',
    },
  ],
  /orchestrationRunId/i,
);

if (hadError) {
  console.error('\n【P5b-1：未完全成功】上方有锁点缺失 / 残留，请把输出发回。');
  process.exit(1);
}
console.log('\n✅ P5b-1 完成：orchestrate 叶子管线已删。接下来：');
console.log('  node scripts/refactor/residual-orchestrate-gate.mjs   # 计数应明显下降');
console.log('  （useAiAgentPlan/Run 仍会报错，是预期的，下一单元改写为原生流）');
