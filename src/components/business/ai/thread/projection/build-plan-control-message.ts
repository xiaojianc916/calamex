/**
 * 构造承载 Plan 审批信息的合成 assistant 消息,经线程条目投影(legacy-adapter)呈现为
 * 时间线内联的 `plan-control` 条目(对齐 Zed 把 plan 作为会话 entry 的取向)。
 *
 * 仅在“等待用户批准计划”阶段产出;计划运行 / 终态不在时间线呈现审批卡(运行态由
 * composer 区状态条负责,见 `derive-run-status`)。这是对旧 `activeAgentFlowMessage`
 * 合成消息机制的替代:不再塞入工具调用,只承载审批所需的 `agentConfirmation`。
 */
import type { IAiAgentConfirmationState, IAiChatMessage } from '@/types/ai';
import type { IAiContextReference } from '@/types/ai/context';

/** 合成 Plan 控制消息的稳定 id(全程唯一,追加在时间线末尾)。 */
export const PLAN_CONTROL_MESSAGE_ID = 'thread-plan-control';

/** 构造 Plan 控制消息所需输入。 */
export interface IPlanControlMessageInput {
  /** 计划目标(空白时不产出消息)。 */
  goal: string;
  /** 计划关联的上下文引用。 */
  references: readonly IAiContextReference[];
  /** 是否处于“等待用户批准计划”阶段(对齐 `AiAssistantPanel.planConfirmationVisible`)。 */
  isAwaitingApproval: boolean;
  /** 消息时间戳(由容器层传入计划的更新 / 创建时间,保持本函数纯净)。 */
  createdAt: string;
}

/**
 * 在等待批准阶段产出承载 `agentConfirmation` 的合成消息;否则返回 null。
 *
 * `agentConfirmation.status` 固定为 `'pending'`(等待批准),线程条目投影(legacy-adapter)
 * 据此把条目阶段映射为 `awaiting-approval`。`content` 留空,投影时跳过 assistant
 * 文本条目,只产出 `plan-control` 条目。
 */
export const buildPlanControlMessage = (input: IPlanControlMessageInput): IAiChatMessage | null => {
  if (!input.isAwaitingApproval) {
    return null;
  }

  const goal = input.goal.trim();
  if (goal.length === 0) {
    return null;
  }

  const agentConfirmation: IAiAgentConfirmationState = {
    goal,
    references: [...input.references],
    status: 'pending',
  };

  return {
    id: PLAN_CONTROL_MESSAGE_ID,
    role: 'assistant',
    content: '',
    createdAt: input.createdAt,
    references: [],
    agentConfirmation,
  };
};
