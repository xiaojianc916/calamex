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

/** 握手后短等 agent 首帧 config_option_update 的宽限窗口（ms）：到期判定为「已公示、空」。 */
const READY_GRACE_MS = 1200;

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
 * 取代 v2 的 get-工作区 + 乐观切换/回滚：
 * - ensureAcpSession：握手建立会话（void），置 discovering 并武装宽限计时器；配置项发现统一
 *   走事件通道（config_option_update）。
 * - applyConfigOptionUpdate：唯一写入点——完整快照整体替换为 ready；坏帧保留旧态。
 * - selectConfigOption：仅触发 set；权威新值由 agent 的 config_option_update 回推，不乐观、不回滚；
 *   set 响应若携带即时快照则并入（best-effort），最终仍以事件为准。
 */
export function useAcpSessionConfigOptions(): IUseAcpSessionConfigOptionsReturn {
  const state = ref<TAcpSessionConfigOptions>({ kind: 'idle' });
  const isSwitching = ref(false);

  let activeThreadId: string | null = null;
  let readyGraceTimer: ReturnType<typeof setTimeout> | null = null;

  const configOptions = computed<IAcpSessionConfigOption[]>(() =>
    state.value.kind === 'ready' ? state.value.configOptions : [],
  );
  const hasConfigOptions = computed(() => configOptions.value.length > 0);

  function clearReadyGrace(): void {
    if (readyGraceTimer !== null) {
      clearTimeout(readyGraceTimer);
      readyGraceTimer = null;
    }
  }

  function armReadyGrace(threadId: string): void {
    clearReadyGrace();
    readyGraceTimer = setTimeout(() => {
      readyGraceTimer = null;
      // 宽限到期仍停在 discovering（未收到任何 config_option_update）：判定无可切换配置项。
      if (activeThreadId === threadId && state.value.kind === 'discovering') {
        state.value = { kind: 'ready', configOptions: [] };
      }
    }, READY_GRACE_MS);
  }

  function applyConfigOptionUpdate(raw: unknown): void {
    clearReadyGrace();
    state.value = applyAcpConfigOptionUpdate(state.value, raw);
  }

  async function ensureAcpSession(
    threadId: string,
    backend: TAgentBackendKind,
    workspaceRootPath?: string | null,
  ): Promise<void> {
    activeThreadId = threadId;
    clearReadyGrace();
    state.value = { kind: 'discovering' };
    try {
      await aiService.ensureAcpSession({
        threadId,
        backend,
        ...(workspaceRootPath ? { workspaceRootPath } : {}),
      });
      if (activeThreadId !== threadId) return;
      // 握手只确保会话建立；配置项发现走事件通道，短等首帧 config_option_update 兜底。
      if (state.value.kind === 'discovering') {
        armReadyGrace(threadId);
      }
    } catch (error) {
      if (activeThreadId !== threadId) return;
      clearReadyGrace();
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
    clearReadyGrace();
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
