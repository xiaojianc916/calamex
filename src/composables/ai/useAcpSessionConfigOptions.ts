import type { ComputedRef, Ref } from 'vue';
import { computed, ref } from 'vue';

import {
  applyAcpConfigOptionUpdate,
  parseAcpSessionConfigOptionsState,
} from '@/components/business/ai/thread/projection/from-acp-session-config-options';
import { aiService } from '@/services/ipc/ai.service';
import type { IAcpSessionConfigOption, IAcpSessionConfigOptionsState } from '@/types/ai/sidecar';

export interface IUseAcpSessionConfigOptionsReturn {
  state: Ref<IAcpSessionConfigOptionsState | null>;
  configOptions: ComputedRef<IAcpSessionConfigOption[]>;
  hasConfigOptions: ComputedRef<boolean>;
  isSwitching: Ref<boolean>;
  loadConfigOptions: (threadId: string) => Promise<void>;
  selectConfigOption: (threadId: string, configId: string, valueId: string) => Promise<boolean>;
  applyConfigOptionUpdate: (raw: unknown) => void;
  reset: () => void;
}

/**
 * ACP config_options 选择器 composable（镜像 useAcpSessionModes 的加载/乐观切换/回滚结构）。
 * - loadConfigOptions：拉取并解析，await 期间 thread 切换则丢弃过期结果。
 * - selectConfigOption：乐观更新 currentValue，IPC 返回 false 或抛错则回滚。
 * - applyConfigOptionUpdate：config_option_update 事件（完整快照）整体替换。
 */
export function useAcpSessionConfigOptions(): IUseAcpSessionConfigOptionsReturn {
  const state = ref<IAcpSessionConfigOptionsState | null>(null);
  const isSwitching = ref(false);

  // 最近一次 loadConfigOptions 的目标 thread：用于丢弃过期（thread 已切换）的异步结果。
  let activeThreadId: string | null = null;

  const configOptions = computed<IAcpSessionConfigOption[]>(() => state.value?.configOptions ?? []);
  const hasConfigOptions = computed(() => configOptions.value.length > 0);

  function withCurrentValue(
    current: IAcpSessionConfigOptionsState,
    configId: string,
    valueId: string,
  ): IAcpSessionConfigOptionsState {
    return {
      configOptions: current.configOptions.map((option) =>
        option.id === configId ? { ...option, currentValue: valueId } : option,
      ),
    };
  }

  async function loadConfigOptions(threadId: string): Promise<void> {
    activeThreadId = threadId;
    const payload = await aiService.getSessionConfigOptions({ threadId });
    // thread 在 await 期间被切换：丢弃过期结果。
    if (activeThreadId !== threadId) return;
    state.value = payload ? parseAcpSessionConfigOptionsState(payload.configOptions) : null;
  }

  async function selectConfigOption(
    threadId: string,
    configId: string,
    valueId: string,
  ): Promise<boolean> {
    const current = state.value;
    if (current === null) return false;
    const target = current.configOptions.find((option) => option.id === configId);
    if (target === undefined) return false;
    if (target.currentValue === valueId) return true;
    // 越界保护：valueId 必须是该选择器的合法候选值。
    if (!target.options.some((option) => option.value === valueId)) return false;

    const previous = current;
    state.value = withCurrentValue(current, configId, valueId);
    isSwitching.value = true;
    try {
      const ok = await aiService.setSessionConfigOption({ threadId, configId, valueId });
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

  function applyConfigOptionUpdate(raw: unknown): void {
    state.value = applyAcpConfigOptionUpdate(state.value, raw);
  }

  function reset(): void {
    state.value = null;
    isSwitching.value = false;
    activeThreadId = null;
  }

  return {
    state,
    configOptions,
    hasConfigOptions,
    isSwitching,
    loadConfigOptions,
    selectConfigOption,
    applyConfigOptionUpdate,
    reset,
  };
}
