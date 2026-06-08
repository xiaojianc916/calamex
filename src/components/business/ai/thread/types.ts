import type { IAiTaskPlanStep } from '@/types/ai';
import type { TAgentPlanStatus } from '@/types/ai/sidecar';

/**
 * Plan 控制条目渲染所需的运行态明细。
 *
 * 时间线投影本身只持有“Plan 这件事发生了”（`plan-control` 条目），具体的步骤 /
 * 审批 / 运行状态由上层（assistant panel）按当前 run 注入，以保持投影层纯净、
 * 渲染层无状态。缺省时渲染层使用全空兜底，仅展示目标。
 */
export interface IAiThreadPlanDetails {
  summary: string | null;
  status: TAgentPlanStatus | null;
  steps: IAiTaskPlanStep[];
  isPlanning: boolean;
  isApproving: boolean;
  canEdit: boolean;
  canApprove: boolean;
  approvedAt: string | null;
}
