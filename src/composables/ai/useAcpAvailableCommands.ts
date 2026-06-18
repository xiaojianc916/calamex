import { type ComputedRef, computed, ref } from 'vue';

import { parseAcpAvailableCommands } from '@/components/business/ai/thread/projection/from-acp-available-commands';
import type {
  IAcpAvailableCommand,
  IAcpAvailableCommandsState,
  TJsonValue,
} from '@/types/ai/sidecar';

/* ============================================================================
 * ACP 可用斜杠命令面板的前端闭环（ADR-20260617 · D7-④）。
 *
 * 职责：消费 ACP available_commands_update UI 事件的原始 availableCommands 数组
 * （逐字透传，形状 unknown），经 ACL from-acp-available-commands 归一为命令面板
 * VM；UI 只消费该结构，不直接触碰 ACP 原始负载。
 *
 * 设计取舍（与 useAcpSessionModes 一致，不自创）：
 * - 纯状态化、可在 effectScope 内单测，与 .vue 解耦；
 * - 不在此自订阅 sidecar 流：宿主（useAiAssistant）持有唯一的 onSidecarStream 并路由
 *   全部 UI 事件，故由宿主在收到 available_commands_update 时调用 applyCommandsUpdate，
 *   避免重复订阅；
 * - 命令清单按整份替换（ACP 每次推送完整列表）；解析无有效命令时清空（面板隐藏）。
 *
 * 注：ACP 不提供「拉取可用命令」的方法，命令仅经 update 通知下发，故无 loadXxx。
 * ========================================================================== */

export interface IUseAcpAvailableCommandsReturn {
  /** 面板 VM；null 表示无可用命令，面板整体隐藏。 */
  state: ComputedRef<IAcpAvailableCommandsState | null>;
  /** 可用命令清单（无则空数组）。 */
  commands: ComputedRef<IAcpAvailableCommand[]>;
  hasCommands: ComputedRef<boolean>;
  /** 消费 available_commands_update：整份替换；无有效命令则清空。 */
  applyCommandsUpdate: (availableCommands: readonly TJsonValue[]) => void;
  /** 清空 VM（如切换 thread / 关闭会话）。 */
  reset: () => void;
}

export const useAcpAvailableCommands = (): IUseAcpAvailableCommandsReturn => {
  const state = ref<IAcpAvailableCommandsState | null>(null);

  const applyCommandsUpdate = (availableCommands: readonly TJsonValue[]): void => {
    state.value = parseAcpAvailableCommands(availableCommands);
  };

  const reset = (): void => {
    state.value = null;
  };

  return {
    state: computed(() => state.value),
    commands: computed(() => state.value?.commands ?? []),
    hasCommands: computed(() => (state.value?.commands.length ?? 0) > 0),
    applyCommandsUpdate,
    reset,
  };
};
