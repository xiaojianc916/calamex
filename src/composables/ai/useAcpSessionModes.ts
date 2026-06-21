import type { ComputedRef, Ref } from 'vue';
import { computed, ref } from 'vue';

import {
  applyAcpCurrentModeUpdate,
  parseAcpSessionModesState,
} from '@/components/business/ai/thread/projection/from-acp-session-modes';
import { aiService } from '@/services/ipc/ai.service';
import type { IAcpSessionMode, IAcpSessionModesState } from '@/types/ai/sidecar';

export interface IUseAcpSessionModesReturn {
  state: Ref<IAcpSessionModesState | null>;
  modes: ComputedRef<IAcpSessionMode[]>;
  currentModeId: ComputedRef<string | null>;
  hasModes: ComputedRef<boolean>;
  isSwitching: Ref<boolean>;
  loadModes: (threadId: string) => Promise<void>;
  selectMode: (threadId: string, modeId: string) => Promise<boolean>;
  applyCurrentModeUpdate: (currentModeId: string | null) => void;
  reset: () => void;
}

/**
 * ACP session modes 选择器 composable（镜像 useAcpSessionConfigOptions 的加载/乐观切换/回滚结构）。
 * - loadModes：拉取并解析，await 期间 thread 切换则丢弃过期结果。
 * - selectMode：乐观更新 currentModeId，IPC 返回 false 或抛错则回滚。
 * - applyCurrentModeUpdate：current_mode_update 事件仅回灌 currentModeId。
 * 复用 Kimi 内置模式语义（绝不本地伪造 chat/agent/plan）。
 */
export function useAcpSessionModes(): IUseAcpSessionModesReturn {
  const state = ref<IAcpSessionModesState | null>(null);
  const isSwitching = ref(false);

  // 最近一次 loadModes 的目标 thread：用于丢弃过期（thread 已切换）的异步结果。
  let activeThreadId: string | null = null;

  const modes = computed<IAcpSessionMode[]>(() => state.value?.availableModes ?? []);
  const currentModeId = computed<string | null>(() => state.value?.currentModeId ?? null);
  const hasModes = computed(() => modes.value.length > 0);

  async function loadModes(threadId: string): Promise<void> {
    activeThreadId = threadId;
    const payload = await aiService.getSessionModes({ threadId });
    if (activeThreadId !== threadId) return;
    state.value = payload ? parseAcpSessionModesState(payload.modes) : null;
  }

  async function selectMode(threadId: string, modeId: string): Promise<boolean> {
    const current = state.value;
    if (current === null) return false;
    if (current.currentModeId === modeId) return true;
    // 越界保护：modeId 必须是 agent 公示的合法模式。
    if (!current.availableModes.some((mode) => mode.id === modeId)) return false;

    const previous = current;
    state.value = { ...current, currentModeId: modeId };
    isSwitching.value = true;
    try {
      const ok = await aiService.setSessionMode({ threadId, modeId });
      if (!ok) {
        state.value = previous;
        return false;
      }
      return true;
    } catch (error) {
      state.value = previous;
      throw error;
    } finally {
      isSwitching.value = false;
    }
  }

  function applyCurrentModeUpdate(currentModeId: string | null): void {
    state.value = applyAcpCurrentModeUpdate(state.value, currentModeId);
  }

  function reset(): void {
    state.value = null;
    isSwitching.value = false;
    activeThreadId = null;
  }

  return {
    state,
    modes,
    currentModeId,
    hasModes,
    isSwitching,
    loadModes,
    selectMode,
    applyCurrentModeUpdate,
    reset,
  };
}
