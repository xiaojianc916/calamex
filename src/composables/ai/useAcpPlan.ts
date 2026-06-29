import { type ComputedRef, computed, ref } from 'vue';

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
