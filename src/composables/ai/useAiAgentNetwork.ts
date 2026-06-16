import { type ComputedRef, computed, type Ref, readonly, ref } from 'vue';

import { aiService } from '@/services/ipc/ai.service';
import { useAiAgentStore } from '@/store/aiAgent';
import type { TAiAgentNetworkPermission } from '@/types/ai';
import { toErrorMessage } from '@/utils/error/error';

const DEFAULT_ERROR_MESSAGE = '设置 AI Agent 网络权限失败。';

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

export interface IUseAiAgentNetworkReturn {
  /** 直接暴露的 Pinia store,与原实现保持一致。 */
  store: ReturnType<typeof useAiAgentStore>;
  /**
   * 是否正在进行 setNetworkPermission 调用(响应式,**只读**)。
   *
   * 语义:**last-initiated-wins** —— 多次并发调用时,只有"最新发起"
   * 的那次请求的完成会把 pending 置回 false;更早发起的请求即使后到也
   * 不再影响 pending,以匹配 store 写入策略。
   */
  pending: Readonly<Ref<boolean>>;
  /** store.errorMessage 的只读响应式视图,空字符串表示无错误。 */
  errorMessage: ComputedRef<string>;
  /**
   * 主动清空当前错误信息。
   * 不影响 `pending` —— 清错误时若仍有请求在飞,loading 视觉继续保留。
   */
  clearError: () => void;
  /**
   * 设置网络权限。签名与原 store action 一致。
   * 并发场景下,只有"最新发起"的请求允许写回 store(过期请求的成功/失败均被丢弃)。
   */
  setNetworkPermission: (
    permission: TAiAgentNetworkPermission,
  ) => Promise<TAiAgentNetworkPermission>;
}

export const useAiAgentNetwork = (): IUseAiAgentNetworkReturn => {
  const store = useAiAgentStore();

  // ── Race-protection counter ──────────────────────────
  //
  // 单调递增的请求序号。**注意**:这是 composable 实例级 —— 每次
  // useAiAgentNetwork() 调用都拿到独立计数器。
  //
  // 如果业务要求"全局只有一个 set network permission 写入者",把这个状态
  // 提到 store(参考 useAiStore.configWriteSeq 的模块级闭包写法)。
  // 目前假设每个组件实例独立调用,实例内部 race 即可。
  let requestSeq = 0;

  // ── Reactive state ─────────────────────────────────
  const pending = ref(false);
  const errorMessage = computed<string>(() => store.errorMessage);

  // ── Actions ────────────────────────────────────

  const clearError = (): void => {
    // 直接 mutate store state(Pinia setup store 允许)。
    // 写成 null 与 store 初始状态对齐,不引入新的 "" 哨兵。
    // 如果未来 useAiAgentStore 增加显式 clearError action,改用 action。
    store.errorMessage = '';
  };

  const setNetworkPermission = async (
    permission: TAiAgentNetworkPermission,
  ): Promise<TAiAgentNetworkPermission> => {
    const seq = ++requestSeq;
    pending.value = true;
    try {
      const payload = await aiService.setNetworkPermission({ permission });
      // 只有"最新发起"的请求才允许写回 store;过期请求的 payload 被丢弃。
      // 单线程场景下行为与原实现一致。
      if (seq === requestSeq) {
        store.setNetworkPermission(payload.permission);
        store.errorMessage = '';
      }
      return payload.permission;
    } catch (error) {
      if (seq === requestSeq) {
        store.errorMessage = toErrorMessage(error, DEFAULT_ERROR_MESSAGE);
      }
      throw error;
    } finally {
      // 仅当我们仍是"最新发起"时才重置 pending;
      // 否则交给后续更新的那次请求自己管理 —— 这是 last-initiated-wins 语义。
      if (seq === requestSeq) {
        pending.value = false;
      }
    }
  };

  return {
    store,
    pending: readonly(pending),
    errorMessage,
    clearError,
    setNetworkPermission,
  };
};
