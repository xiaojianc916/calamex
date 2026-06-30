import type { ComputedRef, Ref } from 'vue';
import { computed, ref } from 'vue';

import {
  applyAcpConfigOptionUpdate,
  parseAcpSessionConfigOptions,
} from '@/components/business/ai/thread/projection/from-acp-session-config-options';
import { aiService } from '@/services/ipc/ai.service';
import type {
  IAcpSessionConfigOption,
  TAcpSessionConfigOptions,
  TAgentBackendKind,
} from '@/types/ai/sidecar';
import { toErrorMessage } from '@/utils/error/error';

export interface IUseAcpSessionConfigOptionsReturn {
  state: Ref<TAcpSessionConfigOptions>;
  configOptions: ComputedRef<IAcpSessionConfigOption[]>;
  hasConfigOptions: ComputedRef<boolean>;
  isSwitching: Ref<boolean>;
  ensureAcpSession: (
    threadId: string,
    backend: TAgentBackendKind,
    workspaceRootPath?: string | null,
  ) => Promise<void>;
  selectConfigOption: (threadId: string, configId: string, valueId: string) => Promise<boolean>;
  applyConfigOptionUpdate: (raw: unknown) => void;
  reset: () => void;
}

/**
 * ACP config_options 选择器 composable（v3 · 唯一标准管线 / 判别式状态机）。
 *
 * 完全按 ACP 规范：配置项发现的唯一来源是 session/new 响应公示的 config_options。
 * - ensureAcpSession：握手建立/复用会话，直接以握手返回的快照落 ready（无快照即 ready-空）。
 * - applyConfigOptionUpdate：增量写入点——agent 在标准回合内主动下发 config_option_update（完整
 *   快照）时整体替换；坏帧保留旧态。
 * - selectConfigOption：仅触发 set；set 响应携带的切换后完整快照即并入，最终仍可被后续
 *   config_option_update 覆盖。不乐观、不回滚。
 */
export function useAcpSessionConfigOptions(): IUseAcpSessionConfigOptionsReturn {
  const state = ref<TAcpSessionConfigOptions>({ kind: 'idle' });
  const isSwitching = ref(false);

  let activeThreadId: string | null = null;

  const configOptions = computed<IAcpSessionConfigOption[]>(() =>
    state.value.kind === 'ready' ? state.value.configOptions : [],
  );
  const hasConfigOptions = computed(() => configOptions.value.length > 0);

  function applyConfigOptionUpdate(raw: unknown): void {
    state.value = applyAcpConfigOptionUpdate(state.value, raw);
  }

  async function ensureAcpSession(
    threadId: string,
    backend: TAgentBackendKind,
    workspaceRootPath?: string | null,
  ): Promise<void> {
    activeThreadId = threadId;
    state.value = { kind: 'discovering' };
    try {
      const payload = await aiService.ensureAcpSession({
        threadId,
        backend,
        ...(workspaceRootPath ? { workspaceRootPath } : {}),
      });
      if (activeThreadId !== threadId) return;
      // 配置项发现的唯一来源：握手回传 agent 在 session/new 公示的 config_options 快照。
      // 无快照（agent 未公示）即视为「已公示、空」，落 ready-空。
      const snapshot = payload ? parseAcpSessionConfigOptions(payload.configOptions) : null;
      state.value = snapshot ?? { kind: 'ready', configOptions: [] };
    } catch (error) {
      if (activeThreadId !== threadId) return;
      state.value = {
        kind: 'unavailable',
        reason: 'handshake_failed',
        message: toErrorMessage(error, 'ACP 会话握手失败'),
      };
    }
  }

  async function selectConfigOption(
    threadId: string,
    configId: string,
    valueId: string,
  ): Promise<boolean> {
    if (state.value.kind !== 'ready') return false;
    const target = state.value.configOptions.find((option) => option.id === configId);
    if (target === undefined) return false;
    if (target.currentValue === valueId) return true;
    // 越界保护：valueId 必须是该选择器的合法候选值。
    if (!target.options.some((option) => option.value === valueId)) return false;

    isSwitching.value = true;
    try {
      const payload = await aiService.setSessionConfigOption({ threadId, configId, valueId });
      if (activeThreadId === threadId && payload) {
        applyConfigOptionUpdate(payload.configOptions);
      }
      return true;
    } finally {
      isSwitching.value = false;
    }
  }

  function reset(): void {
    activeThreadId = null;
    isSwitching.value = false;
    state.value = { kind: 'idle' };
  }

  return {
    state,
    configOptions,
    hasConfigOptions,
    isSwitching,
    ensureAcpSession,
    selectConfigOption,
    applyConfigOptionUpdate,
    reset,
  };
}
