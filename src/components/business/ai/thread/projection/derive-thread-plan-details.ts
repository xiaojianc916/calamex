/**
 * 计划 store 快照 → 时间线 Plan 控制条目运行态明细(`IAiThreadPlanDetails`)的纯映射。
 *
 * 设计取向(对齐 Zed `agent_ui`:plan 作为会话中的一条 entry,其可交互状态由上层
 * 注入,投影层只描述“发生了 plan 这件事”):本函数把容器层(`AiAssistantPanel`)
 * 既有的 `plan*` 派生收敛成单一纯函数,渲染层与投影层都保持无状态、可单测。
 *
 * `canApprove` / `canEdit` 的判定逐条复刻 `AiAssistantPanel` 既有 computed
 * (`canApprovePlan` / `canEditPlan`)与计划编排层 `useAiAgentPlan` 的步骤数边界,
 * 仅做集中化,不改变语义、不发明新规则。
 */
import type { IAiTaskPlanStep } from '@/types/ai';
import type { TAgentPlanStatus } from '@/types/ai/sidecar';

import type { IAiThreadPlanDetails } from '../types';

/**
 * Plan 可批准的步骤数量边界。
 *
 * 与 `useAiAgentPlan`(MIN_PLAN_STEPS=2 / MAX_PLAN_STEPS=6)及
 * `AiAssistantPanel.canApprovePlan` 的既有判定保持一致。
 */
export const THREAD_PLAN_MIN_APPROVABLE_STEPS = 2;
export const THREAD_PLAN_MAX_APPROVABLE_STEPS = 6;

/** 派生 Plan 控制明细所需的计划 store 快照(容器层取值后原样传入)。 */
export interface IThreadPlanDetailsInput {
  summary: string | null;
  status: TAgentPlanStatus | null;
  steps: readonly IAiTaskPlanStep[];
  isPlanning: boolean;
  isApproving: boolean;
  isClassifying: boolean;
  approvedAt: string | null;
  /** 是否已存在活动 run(运行一旦开始,计划不再可批准 / 编辑)。 */
  hasActiveRun: boolean;
}

/** 草稿态(仍可继续编辑):显式 `draft` 或尚未定状态(`null`)。 */
const isDraftLikeStatus = (status: TAgentPlanStatus | null): boolean =>
  status === 'draft' || status === null;

/**
 * 把计划 store 快照映射为 `IAiThreadPlanDetails`。
 *
 * - 可批准:步骤数落在 [MIN, MAX]、无活动 run、未批准,且处于 `pending_approval`
 *   或草稿 / 未定状态。
 * - 可编辑:无活动 run、未批准,且不在分类 / 生成 / 批准中,处于草稿 / 未定状态。
 */
export const deriveThreadPlanDetails = (
  input: IThreadPlanDetailsInput,
): IAiThreadPlanDetails => {
  const steps = [...input.steps];
  const isApproved = Boolean(input.approvedAt);
  const draftLike = isDraftLikeStatus(input.status);

  const canApprove =
    steps.length >= THREAD_PLAN_MIN_APPROVABLE_STEPS &&
    steps.length <= THREAD_PLAN_MAX_APPROVABLE_STEPS &&
    !input.hasActiveRun &&
    !isApproved &&
    (input.status === 'pending_approval' || draftLike);

  const canEdit =
    !input.hasActiveRun &&
    !isApproved &&
    !input.isPlanning &&
    !input.isApproving &&
    !input.isClassifying &&
    draftLike;

  return {
    summary: input.summary,
    status: input.status,
    steps,
    isPlanning: input.isPlanning,
    isApproving: input.isApproving,
    canEdit,
    canApprove,
    approvedAt: input.approvedAt,
  };
};
