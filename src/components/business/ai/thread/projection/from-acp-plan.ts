/* ============================================================================
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
    : `步骤 ${index + 1}`;
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
      id: `acp-plan-step:${index}`,
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
