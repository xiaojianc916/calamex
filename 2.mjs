// b1b-2-from-acp-plan-acl.mjs
// B1b 第二片：新增 from-acp-plan ACL，把 ACP-native plan 帧(TAcpPlan)归一为线程 plan
// 步骤 VM(IAiTaskPlanStep[])，与 Mastra 信封经 mapSidecarPlanToTaskSteps 的产物同型，
// 复用同一渲染/派生链路(derive-thread-plan-details)。新增 2 文件 + 改 1 barrel，不提交。
// 运行：node b1b-2-from-acp-plan-acl.mjs

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()
const DIR = "src/components/business/ai/thread/projection"

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

// 用 barrel 的 EOL 作为新文件 EOL，保持一致
const indexAbs = join(ROOT, DIR, "index.ts")
const { text: indexText, eol } = detectEol(readFileSync(indexAbs, "utf8"))

// ── A) 新增 ACL：from-acp-plan.ts ──────────────────────────────────────────
const aclSource = `/* ============================================================================
 * ACP-native 计划 ACL（ADR-20260617 · D2）
 *
 * 把 ACP session/update 的 plan 快照（TAcpPlan）归一为线程 plan 步骤 VM
 * （IAiTaskPlanStep[]），与 Mastra 信封 plan_ready 经 mapSidecarPlanToTaskSteps
 * 产出的步骤同型，复用同一渲染 / 派生链路（derive-thread-plan-details）。
 *
 * ACP 标准 plan 是「粗粒度清单」：每条 entry 仅 { content, priority, status }
 * （见 @agentclientprotocol/sdk PlanEntry，与 sidecar from-runtime-event 投影同源）。
 * 富计划字段（goal / tools / files / risks / acceptanceCriteria / 逐步审批）不在标准
 * plan 帧内 —— 按 α 取向有意舍弃为 Mastra 信封专属，逐步审批安全性独立由
 * session/request_permission 保障。priority 语义 ≠ riskLevel，不臆造映射。
 *
 * 纯函数、防御式读取（plan 负载经 Rust 逐字透传，形状按 unknown 处理）：非法 entry
 * 跳过，整体非法返回空步骤数组，不抛错、不伪造。
 * ========================================================================== */
import type { IAiTaskPlanStep, TAiAgentPlanStepStatus } from '@/types/ai';
import type { TAcpPlan } from '@/types/ai/acp-tool-call';

/** ACP PlanEntry.status（pending | in_progress | completed）→ 线程步骤状态。 */
const ACP_PLAN_STATUS_TO_STEP_STATUS: Readonly<Record<string, TAiAgentPlanStepStatus>> = {
  pending: 'pending',
  in_progress: 'running',
  completed: 'done',
};

const mapAcpPlanStatus = (status: unknown): TAiAgentPlanStepStatus =>
  (typeof status === 'string' ? ACP_PLAN_STATUS_TO_STEP_STATUS[status] : undefined) ?? 'pending';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** entry.content 为空白时回退到稳定占位标题，避免渲染空步骤。 */
const readEntryContent = (entry: Record<string, unknown>, index: number): string => {
  const content = entry.content;
  return typeof content === 'string' && content.trim().length > 0
    ? content.trim()
    : \`步骤 \${index + 1}\`;
};

/**
 * ACP plan 快照 → 线程 plan 步骤 VM。entries 为全量快照，按出现顺序映射；
 * 无 entries / 非数组时返回空数组。
 */
export const mapAcpPlanToTaskSteps = (update: TAcpPlan): IAiTaskPlanStep[] => {
  const entries: unknown = (update as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.filter(isRecord).map((entry, index): IAiTaskPlanStep => {
    const content = readEntryContent(entry, index);
    return {
      id: \`acp-plan-step:\${index}\`,
      index,
      title: content,
      goal: content,
      kind: 'inspect',
      status: mapAcpPlanStatus(entry.status),
      expectedOutput: '',
      tools: [],
      requiresUserApproval: false,
      riskLevel: 'medium',
    };
  });
};
`
writeNew(`${DIR}/from-acp-plan.ts`, aclSource, eol)

// ── B) 配套 spec（覆盖顺序 / 状态映射 / 占位 / 非法输入分支） ─────────────────
const specSource = `import { describe, expect, it } from 'vitest';

import type { TAcpPlan } from '@/types/ai/acp-tool-call';

import { mapAcpPlanToTaskSteps } from './from-acp-plan';

const makePlan = (entries: unknown): TAcpPlan =>
  ({ sessionUpdate: 'plan', entries }) as unknown as TAcpPlan;

describe('mapAcpPlanToTaskSteps', () => {
  it('按顺序把 ACP plan entries 归一为线程步骤（含状态映射）', () => {
    const steps = mapAcpPlanToTaskSteps(
      makePlan([
        { content: '读取代码', priority: 'high', status: 'completed' },
        { content: '修改实现', priority: 'medium', status: 'in_progress' },
        { content: '运行测试', priority: 'low', status: 'pending' },
      ]),
    );

    expect(steps.map((step) => [step.index, step.title, step.status])).toEqual([
      [0, '读取代码', 'done'],
      [1, '修改实现', 'running'],
      [2, '运行测试', 'pending'],
    ]);
    expect(steps[0]?.id).toBe('acp-plan-step:0');
    expect(steps[0]?.tools).toEqual([]);
    expect(steps[0]?.requiresUserApproval).toBe(false);
  });

  it('content 空白时回退占位标题', () => {
    const steps = mapAcpPlanToTaskSteps(makePlan([{ content: '   ', status: 'pending' }]));
    expect(steps[0]?.title).toBe('步骤 1');
  });

  it('entries 缺失 / 非数组时返回空数组', () => {
    expect(mapAcpPlanToTaskSteps(makePlan(undefined))).toEqual([]);
    expect(mapAcpPlanToTaskSteps(makePlan('nope' as unknown))).toEqual([]);
  });

  it('跳过非对象 entry', () => {
    expect(mapAcpPlanToTaskSteps(makePlan([null, 42, 'x']))).toEqual([]);
  });

  it('未知 status 兜底为 pending', () => {
    const steps = mapAcpPlanToTaskSteps(makePlan([{ content: 'x', status: 'weird' }]));
    expect(steps[0]?.status).toBe('pending');
  });
});
`
writeNew(`${DIR}/from-acp-plan.spec.ts`, specSource, eol)

// ── C) barrel 导出（字母序：events < plan < terminal） ───────────────────────
const nextIndex = replaceOnce(
	indexText,
	"export * from './from-acp-events';\n",
	"export * from './from-acp-events';\nexport * from './from-acp-plan';\n",
	"index/barrel",
)
if (!nextIndex.includes("export * from './from-acp-plan';"))
	throw new Error("[index.ts] 自检失败：barrel 未写入 from-acp-plan 导出")
writeFileSync(indexAbs, nextIndex.replace(/\n/g, eol), "utf8")
console.log(`✓ ${DIR}/index.ts`)

console.log("\nB1b 第二片（ACL + spec + barrel）完成。")
console.log("建议：pnpm vitest run src/components/business/ai/thread/projection/from-acp-plan.spec.ts")