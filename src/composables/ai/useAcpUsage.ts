import { type ComputedRef, computed, ref } from 'vue';

import { parseAcpUsage } from '@/components/business/ai/thread/projection/from-acp-usage';
import type { IAiLanguageModelUsage } from '@/types/ai';
import type { TJsonValue } from '@/types/ai/sidecar';

/* ============================================================================
 * ACP 回合用量的前端闭环（ADR-20260617 · D7-⑦）。
 *
 * 职责：消费 ACP usage_update UI 事件的原始 usage 对象（逐字透传，形状 unknown），经
 * ACL from-acp-usage safeParse 为共享 IAiLanguageModelUsage VM；UI（token 用量条等）
 * 只消费该结构，不直接触碰 ACP 原始负载。
 *
 * 设计取舍（与 useAcpAvailableCommands / useAcpSessionConfigOptions 一致，不自创）：
 * - 纯状态化、可在 effectScope 内单测，与 .vue 解耦；
 * - 不在此自订阅 sidecar 流：宿主（useAiAssistant）持有唯一 onSidecarStream 并路由全部
 *   UI 事件，故由宿主在收到 usage_update 时调 applyUsageUpdate，避免重复订阅；
 * - 整份替换（ACP 每次上报完整累计用量）；解析失败时 no-op（保留既有用量，避免把已
 *   显示的用量清零回退）。
 * ========================================================================== */

export interface IUseAcpUsageReturn {
  /** 最新回合用量 VM；null 表示尚无有效用量。 */
  usage: ComputedRef<IAiLanguageModelUsage | null>;
  hasUsage: ComputedRef<boolean>;
  /** 消费 usage_update：归一并整份替换；解析失败则 no-op（保留既有）。 */
  applyUsageUpdate: (rawUsage: TJsonValue) => void;
  /** 清空 VM（如切换 thread / 关闭会话）。 */
  reset: () => void;
}

export const useAcpUsage = (): IUseAcpUsageReturn => {
  const usage = ref<IAiLanguageModelUsage | null>(null);

  const applyUsageUpdate = (rawUsage: TJsonValue): void => {
    const parsed = parseAcpUsage(rawUsage);
    if (parsed === null) {
      return;
    }
    usage.value = parsed;
  };

  const reset = (): void => {
    usage.value = null;
  };

  return {
    usage: computed(() => usage.value),
    hasUsage: computed(() => usage.value !== null),
    applyUsageUpdate,
    reset,
  };
};
