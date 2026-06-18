import { type ComputedRef, computed, ref } from 'vue';

import {
  applyAcpModeUpdate,
  parseAcpSessionModeState,
} from '@/components/business/ai/thread/projection/from-acp-session-modes';
import { aiService } from '@/services/ipc/ai.service';
import type { IAcpSessionModeOption, IAcpSessionModeState } from '@/types/ai/sidecar';

/* ============================================================================
 * ACP 会话模式选择器的前端闭环（ADR-20260617 · D7-③-c）。
 *
 * 职责：按 thread 维度加载 `ai_get_session_modes` 的原始 `modes`（ACP
 * SessionModeState，形状 unknown），经 ACL `from-acp-session-modes` 归一为选择器
 * VM；用户切换时乐观更新当前项并经 `aiService.setSessionMode` 回投 `modeId`
 * 原文，失败（抛错或返回 false）回滚；外部 agent 自行切换时经 `mode_update` UI
 * 事件更新高亮。
 *
 * 设计取舍（与已读源码 / useAcpApproval 一致，不自创）：
 * - 纯状态化、可在 effectScope 内单测，与 `.vue` 解耦；
 * - VM 与 ACP wire 解耦：UI 只消费 `IAcpSessionModeState`，不碰原始负载；
 * - `mode_update` 不在此自订阅 sidecar 流：宿主（useAiAssistant）已持有唯一的
 *   `onSidecarStream` 并路由全部 UI 事件（见 sidecar-stream-listener 的收敛注记），
 *   故由宿主在收到 `mode_update` 时调用 `applyModeUpdate`，避免重复订阅；
 * - `modeId` 逐字透传，跨层不做语义映射（对齐 ACP currentModeId 原值）；
 * - 切换前若 modeId 未知或已是当前项，不发 IPC（避免无谓 session 往返）。
 * ========================================================================== */

export interface IUseAcpSessionModesReturn {
  /** 选择器 VM；null 表示后端未提供会话模式，选择器整体隐藏。 */
  state: ComputedRef<IAcpSessionModeState | null>;
  /** 可用模式清单（无则空数组）。 */
  availableModes: ComputedRef<IAcpSessionModeOption[]>;
  /** 当前高亮模式；无对应项时为 null。 */
  currentMode: ComputedRef<IAcpSessionModeOption | null>;
  hasModes: ComputedRef<boolean>;
  /** setSessionMode 回投进行中（用于禁用选择器交互）。 */
  isSwitching: ComputedRef<boolean>;
  /** 按 thread 加载并解析会话模式；线程在 await 期间被切走则丢弃过期结果。 */
  loadModes: (threadId: string) => Promise<void>;
  /** 用户切换模式：乐观更新 + 回投；失败回滚并（抛错时）重新抛出。 */
  selectMode: (modeId: string) => Promise<void>;
  /** 消费 `mode_update` UI 事件：命中既有模式才更新高亮，未知忽略。 */
  applyModeUpdate: (modeId: string) => void;
  /** 清空 VM（如切换 thread / 关闭会话）。 */
  reset: () => void;
}

export const useAcpSessionModes = (): IUseAcpSessionModesReturn => {
  const state = ref<IAcpSessionModeState | null>(null);
  const activeThreadId = ref<string | null>(null);
  const switching = ref(false);

  const reset = (): void => {
    state.value = null;
    activeThreadId.value = null;
    switching.value = false;
  };

  const loadModes = async (threadId: string): Promise<void> => {
    activeThreadId.value = threadId;
    const payload = await aiService.getSessionModes({ threadId });
    // 线程在 await 期间被切走：丢弃过期结果，避免覆盖新线程的 VM。
    if (activeThreadId.value !== threadId) {
      return;
    }
    state.value = payload ? parseAcpSessionModeState(payload.modes) : null;
  };

  const applyModeUpdate = (modeId: string): void => {
    if (state.value) {
      state.value = applyAcpModeUpdate(state.value, modeId);
    }
  };

  const selectMode = async (modeId: string): Promise<void> => {
    const current = state.value;
    const threadId = activeThreadId.value;
    if (!current || !threadId) {
      return;
    }
    // 已是当前模式或未知模式：不发 IPC。
    if (
      current.currentModeId === modeId ||
      !current.availableModes.some((mode) => mode.id === modeId)
    ) {
      return;
    }

    const previous = current;
    state.value = applyAcpModeUpdate(current, modeId);
    switching.value = true;
    try {
      const ok = await aiService.setSessionMode({ threadId, modeId });
      // 后端拒绝切换且 thread 未被切走：回滚乐观更新。
      if (!ok && activeThreadId.value === threadId) {
        state.value = previous;
      }
    } catch (error) {
      if (activeThreadId.value === threadId) {
        state.value = previous;
      }
      throw error;
    } finally {
      switching.value = false;
    }
  };

  return {
    state: computed(() => state.value),
    availableModes: computed(() => state.value?.availableModes ?? []),
    currentMode: computed(() => {
      const value = state.value;
      if (!value || value.currentModeId === null) {
        return null;
      }
      return value.availableModes.find((mode) => mode.id === value.currentModeId) ?? null;
    }),
    hasModes: computed(() => (state.value?.availableModes.length ?? 0) > 0),
    isSwitching: computed(() => switching.value),
    loadModes,
    selectMode,
    applyModeUpdate,
    reset,
  };
};
