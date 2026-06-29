// b1b-3-use-acp-plan-wire.mjs
// B1b 第三片：ACP-native plan 帧消费闭环。新增 useAcpPlan(与 useAcpUsage 同构,消费 from-acp-plan
// ACL),并接入宿主 useAiAssistant 的接收侧唯一路由 applyAcpReceiveSideEvents。不动 legacy
// useAiAgentPlan/aiAgent store(留待 D1 删除),先建后删、暂时共存、终态无兼容层。不提交。
// 运行：node b1b-3-use-acp-plan-wire.mjs

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()

function detectEol(raw) {
	const crlf = (raw.match(/\r\n/g) || []).length
	const lfOnly = (raw.match(/(?<!\r)\n/g) || []).length
	return { text: raw.replace(/\r\n/g, "\n"), eol: crlf > lfOnly ? "\r\n" : "\n" }
}
function replaceOnce(text, oldStr, newStr, label) {
	const idx = text.indexOf(oldStr)
	if (idx === -1) throw new Error(`[${label}] 未找到锚点：\n${oldStr}`)
	if (text.indexOf(oldStr, idx + oldStr.length) !== -1)
		throw new Error(`[${label}] 锚点出现多次，拒绝模糊替换：\n${oldStr}`)
	return text.slice(0, idx) + newStr + text.slice(idx + oldStr.length)
}
function writeNew(relPath, contentLf, eol) {
	const abs = join(ROOT, relPath)
	if (existsSync(abs)) throw new Error(`[${relPath}] 已存在，拒绝覆盖`)
	writeFileSync(abs, contentLf.replace(/\n/g, eol), "utf8")
	console.log(`+ ${relPath}`)
}

// 用宿主文件的 EOL 作为新文件 EOL，保持一致
const hostRel = "src/composables/ai/useAiAssistant.ts"
const hostAbs = join(ROOT, hostRel)
const { text: hostText0, eol } = detectEol(readFileSync(hostAbs, "utf8"))

// ── A) 新增 composable：useAcpPlan.ts ──────────────────────────────────────
const composableSource = `import { type ComputedRef, computed, ref } from 'vue';

import { mapAcpPlanToTaskSteps } from '@/components/business/ai/thread/projection/from-acp-plan';
import type { IAiTaskPlanStep } from '@/types/ai';
import type { TAcpPlan } from '@/types/ai/acp-tool-call';

/* ============================================================================
 * ACP-native 计划的前端闭环（ADR-20260617 · D7 接收侧）。
 *
 * 职责：消费 ACP session/update 的 plan UI 事件（acpUpdate: TAcpPlan，经 Rust 逐字透传），
 * 经 ACL from-acp-plan 归一为线程 plan 步骤 VM（IAiTaskPlanStep[]）。UI 只消费该结构，不
 * 直接触碰 ACP 原始 plan 负载。
 *
 * 设计取舍（与 useAcpUsage / useAcpSessionConfigOptions 一致，不自创）：
 * - 纯状态化、可在测试中脱离 .vue 单测；
 * - 不在此自订阅 sidecar 流：宿主（useAiAssistant）持唯一 onSidecarStream 并路由全部 UI
 *   事件，故由宿主在收到 plan 帧时调 applyPlanUpdate，避免重复订阅；
 * - ACP plan 为全量快照 → 整份替换（含空快照：agent 主动清空计划的合法态）；
 * - 坏帧（entries 非数组）no-op，保留既有快照，避免把已显示的计划清零回退。
 *
 * 与 legacy useAiAgentPlan + aiAgent store 计划字段（审批流）并行存在仅为先建后删过渡，
 * 终态由本 composable 承载 ACP-native 计划，legacy 审批管线在 D1 删除。
 * ========================================================================== */

export interface IUseAcpPlanReturn {
  /** 当前 ACP 计划步骤快照；空数组表示尚无 / 已清空计划。 */
  steps: ComputedRef<IAiTaskPlanStep[]>;
  hasPlan: ComputedRef<boolean>;
  /** 消费 plan 帧：全量快照整份替换；坏帧（entries 非数组）no-op 保留既有。 */
  applyPlanUpdate: (update: TAcpPlan) => void;
  /** 清空 VM（如切换 thread / 清空会话）。 */
  reset: () => void;
}

export const useAcpPlan = (): IUseAcpPlanReturn => {
  const steps = ref<IAiTaskPlanStep[]>([]);

  const applyPlanUpdate = (update: TAcpPlan): void => {
    // 坏帧防御：plan 负载逐字透传，entries 非数组视为坏帧 → no-op（保留既有，避免清零回退）。
    if (!Array.isArray((update as { entries?: unknown }).entries)) {
      return;
    }
    // 全量快照：整份替换（空数组为合法态——agent 主动清空计划）。
    steps.value = mapAcpPlanToTaskSteps(update);
  };

  const reset = (): void => {
    steps.value = [];
  };

  return {
    steps: computed(() => steps.value),
    hasPlan: computed(() => steps.value.length > 0),
    applyPlanUpdate,
    reset,
  };
};
`
writeNew("src/composables/ai/useAcpPlan.ts", composableSource, eol)

// ── B) 配套 spec ───────────────────────────────────────────────────────────
const specSource = `import { describe, expect, it } from 'vitest';

import type { TAcpPlan } from '@/types/ai/acp-tool-call';

import { useAcpPlan } from './useAcpPlan';

const makePlan = (entries: unknown): TAcpPlan =>
  ({ sessionUpdate: 'plan', entries }) as unknown as TAcpPlan;

describe('useAcpPlan', () => {
  it('全量快照整份替换（后到覆盖前者）', () => {
    const plan = useAcpPlan();
    plan.applyPlanUpdate(
      makePlan([
        { content: 'A', status: 'completed' },
        { content: 'B', status: 'in_progress' },
      ]),
    );
    expect(plan.hasPlan.value).toBe(true);
    expect(plan.steps.value.map((step) => [step.title, step.status])).toEqual([
      ['A', 'done'],
      ['B', 'running'],
    ]);

    plan.applyPlanUpdate(makePlan([{ content: 'C', status: 'pending' }]));
    expect(plan.steps.value.map((step) => step.title)).toEqual(['C']);
  });

  it('空快照合法清空（agent 主动清计划）', () => {
    const plan = useAcpPlan();
    plan.applyPlanUpdate(makePlan([{ content: 'A', status: 'pending' }]));
    plan.applyPlanUpdate(makePlan([]));
    expect(plan.steps.value).toEqual([]);
    expect(plan.hasPlan.value).toBe(false);
  });

  it('坏帧（entries 非数组）no-op，保留既有快照', () => {
    const plan = useAcpPlan();
    plan.applyPlanUpdate(makePlan([{ content: 'A', status: 'pending' }]));
    plan.applyPlanUpdate(makePlan(undefined));
    plan.applyPlanUpdate(makePlan('nope' as unknown));
    expect(plan.steps.value.map((step) => step.title)).toEqual(['A']);
  });

  it('reset 清空', () => {
    const plan = useAcpPlan();
    plan.applyPlanUpdate(makePlan([{ content: 'A', status: 'pending' }]));
    plan.reset();
    expect(plan.steps.value).toEqual([]);
    expect(plan.hasPlan.value).toBe(false);
  });
});
`
writeNew("src/composables/ai/useAcpPlan.spec.ts", specSource, eol)

// ── C) 宿主 useAiAssistant.ts 五处接线 ──────────────────────────────────────
let host = hostText0

// C1) import（字母序：AvailableCommands < Plan < SessionConfigOptions）
host = replaceOnce(
	host,
	"import { useAcpAvailableCommands } from '@/composables/ai/useAcpAvailableCommands';\n",
	"import { useAcpAvailableCommands } from '@/composables/ai/useAcpAvailableCommands';\nimport { useAcpPlan } from '@/composables/ai/useAcpPlan';\n",
	"host/import",
)

// C2) 实例化
host = replaceOnce(
	host,
	"  const acpAvailableCommands = useAcpAvailableCommands();\n",
	"  const acpAvailableCommands = useAcpAvailableCommands();\n  const acpPlan = useAcpPlan();\n",
	"host/instantiate",
)

// C3) 接收侧路由新增 case 'plan'
host = replaceOnce(
	host,
	"          acpSessionConfigOptions.applyConfigOptionUpdate(event.configOptions);\n          break;\n        default:\n",
	"          acpSessionConfigOptions.applyConfigOptionUpdate(event.configOptions);\n          break;\n        case 'plan':\n          acpPlan.applyPlanUpdate(event.acpUpdate);\n          break;\n        default:\n",
	"host/switch-case",
)

// C4) 会话重置时一并清空 ACP 计划 VM
host = replaceOnce(
	host,
	"    acpAvailableCommands.reset();\n",
	"    acpAvailableCommands.reset();\n    acpPlan.reset();\n",
	"host/reset",
)

// C5) 公共 surface 导出
host = replaceOnce(
	host,
	"    agentPlan,\n    acpAvailableCommands,\n",
	"    agentPlan,\n    acpAvailableCommands,\n    acpPlan,\n",
	"host/return",
)

// 自检：5 处接线全部命中
for (const probe of [
	"import { useAcpPlan }",
	"const acpPlan = useAcpPlan();",
	"acpPlan.applyPlanUpdate(event.acpUpdate);",
	"acpPlan.reset();",
]) {
	if (!host.includes(probe)) throw new Error(`[host] 自检失败，缺少：${probe}`)
}

writeFileSync(hostAbs, host.replace(/\n/g, eol), "utf8")
console.log(`✓ ${hostRel}（import / 实例化 / case 'plan' / reset / 导出）`)

console.log("\nB1b 第三片（useAcpPlan + 接收侧接线）完成。")
console.log("建议：pnpm vitest run src/composables/ai/useAcpPlan.spec.ts && pnpm typecheck")