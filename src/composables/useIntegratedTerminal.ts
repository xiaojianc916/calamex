/**
 * src/composables/useIntegratedTerminal.ts
 * UI 层薄封装：负责 Vue 生命周期 / DOM 挂载 / watcher。
 * 终端状态与事件编排收口在 TerminalSession（src/terminal/session.ts）。
 * R-18.4.1 / R-20.2.1 / R-20.2.3
 */

import { storeToRefs } from 'pinia';
import { nextTick, onBeforeUnmount, onMounted, type Ref, readonly, ref, watch } from 'vue';
import { tauriService } from '@/services/tauri';
import { useTerminalFacade } from '@/services/terminal/facade';
import { useEditorStore } from '@/store/editor';
import { useTerminalRunRoutingStore } from '@/store/terminalRunRouting';
import { useTerminalRuntimeStore } from '@/store/terminal';
import { useTerminalRegistryStore } from '@/terminal/registry';
import type { ITerminalSessionCallbacks } from '@/terminal/session';
import type { TThemeMode } from '@/types/app';
import type { ITerminalSettings } from '@/types/settings';
import type {
  ITerminalBufferDiagnostic,
  ITerminalDataEvent,
  ITerminalRunChunkPayload,
  ITerminalRunCompletedPayload,
  ITerminalStatusChangePayload,
  ITerminalVisualWritePayload,
} from '@/types/terminal';
import { DEFAULT_TERMINAL_SESSION_ID } from '@/types/terminal';
import { toErrorMessage } from '@/utils/error';

// --- 类型定义 ---

type TUseIntegratedTerminalOptions = {
  settings: Ref<ITerminalSettings>;
  visible: Ref<boolean>;
  theme: Ref<TThemeMode>;
  sessionId?: string;
  onStatusChange?: (payload: ITerminalStatusChangePayload) => void;
  onOutput?: (payload: ITerminalRunChunkPayload) => void;
  onRunCompleted?: (payload: ITerminalRunCompletedPayload) => void;
  onTerminalData?: (payload: ITerminalDataEvent) => void;
  onVisualWrite?: (payload: ITerminalVisualWritePayload) => void;
  onBufferDiagnostic?: (payload: ITerminalBufferDiagnostic) => void;
};

// --- 共享状态钩子 ---

/**
 * 返回集成终端连接状态。
 * registry 持有共享 ref，保证 session 创建前后读取同一份状态。
 */
export const useIntegratedTerminalStatus = () => {
  const registry = useTerminalRegistryStore();
  const { status, statusMessage } = registry.getStatusRefs(DEFAULT_TERMINAL_SESSION_ID);
  return {
    status: readonly(status),
    statusMessage: readonly(statusMessage),
  };
};

/**
 * 返回集成终端控制器。
 * status/statusMessage 始终来自 registry refs，actions 转发到当前 session。
 */
export const useIntegratedTerminalControls = () => {
  const registry = useTerminalRegistryStore();
  const editorStore = useEditorStore();
  const terminalFacade = useTerminalFacade();
  const { status, statusMessage } = registry.getStatusRefs(DEFAULT_TERMINAL_SESSION_ID);
  const shouldFallbackToInteractiveInterrupt = (error: unknown): boolean =>
    toErrorMessage(error, '').includes('不支持带外取消');

  return {
    status: readonly(status),
    statusMessage: readonly(statusMessage),
    // session payload 在 connect 前为 null，这是正常状态。
    get session() {
      const s = registry.get(DEFAULT_TERMINAL_SESSION_ID);
      return s ? readonly(s.session) : readonly(ref(null));
    },
    retry: async (): Promise<void> => {
      await registry.get(DEFAULT_TERMINAL_SESSION_ID)?.retry();
    },
    clearScreen: async (): Promise<void> => {
      await registry.get(DEFAULT_TERMINAL_SESSION_ID)?.clearScreen();
    },
    interrupt: async (): Promise<void> => {
      const runId = editorStore.currentRunId;
      if (editorStore.isRunning && runId) {
        try {
          await terminalFacade.cancelRun(runId, 'graceful');
          return;
        } catch (error) {
          if (!shouldFallbackToInteractiveInterrupt(error)) {
            throw error;
          }
        }
      }
      await registry.get(DEFAULT_TERMINAL_SESSION_ID)?.interrupt();
    },
    sendCommand: async (command: string): Promise<void> => {
      await registry.get(DEFAULT_TERMINAL_SESSION_ID)?.sendCommand(command);
    },
    sendInput: async (data: string): Promise<void> => {
      await registry.get(DEFAULT_TERMINAL_SESSION_ID)?.sendInput(data);
    },
    copySelection: async (): Promise<void> => {
      await registry.get(DEFAULT_TERMINAL_SESSION_ID)?.copySelection();
    },
    getSelectionText: (): string =>
      registry.get(DEFAULT_TERMINAL_SESSION_ID)?.getSelectionText() ?? '',
    pasteFromClipboard: async (): Promise<void> => {
      await registry.get(DEFAULT_TERMINAL_SESSION_ID)?.pasteFromClipboard();
    },
    selectAll: (): void => {
      registry.get(DEFAULT_TERMINAL_SESSION_ID)?.selectAll();
    },
  };
};

// --- 主 composable ---

export const useIntegratedTerminal = ({
  settings,
  visible,
  theme,
  sessionId = DEFAULT_TERMINAL_SESSION_ID,
  onStatusChange,
  onOutput,
  onRunCompleted,
  onTerminalData,
  onVisualWrite,
  onBufferDiagnostic,
}: TUseIntegratedTerminalOptions) => {
  const editorStore = useEditorStore();
  const runtimeStore = useTerminalRuntimeStore();
  const runRoutingStore = useTerminalRunRoutingStore();
  const { showRunSeparator, deepDiagnosticsEnabled } = storeToRefs(runtimeStore);
  const registry = useTerminalRegistryStore();
  const hostRef = ref<HTMLElement | null>(null);
  const buildSessionCallbacks = (): ITerminalSessionCallbacks => ({
    onStatusChange,
    onOutput,
    onRunCompleted,
    onInputRoute: (payload) => {
      runtimeStore.recordInputRoute(payload.route, payload.data);
    },
    onTerminalData: (payload) => {
      runtimeStore.recordTerminalData(payload);
      onTerminalData?.(payload);
    },
    onVisualWrite: (payload) => {
      runtimeStore.recordVisualWrite(payload);
      onVisualWrite?.(payload);
    },
    onBufferDiagnostic: deepDiagnosticsEnabled.value
      ? (payload) => {
          runtimeStore.recordBufferDiagnostic(payload);
          onBufferDiagnostic?.(payload);
        }
      : undefined,
  });

  // 同步创建/获取会话，使 setup 阶段即可被 useIntegratedTerminalStatus 读取。
  const session = registry.getOrCreate({
    sessionId,
    tauriService,
    resetOrphanedBackendSession: !editorStore.isRunning,
    ...buildSessionCallbacks(),
  });
  // 每次 composable 被调用时更新回调，覆盖组件重挂载场景。
  session.updateCallbacks({
    ...buildSessionCallbacks(),
  });
  session.setRunSeparatorVisible(showRunSeparator.value);

  // --- 生命周期 ---

  onMounted(async () => {
    const el = hostRef.value;
    if (!el) return;
    session.setVisible(visible.value);
    session.initWithHost(el, theme.value, settings.value);
    session.bindRenderRecoveryListeners();
    await session.registerEventListeners();
    await session.ensureConnect();
  });

  onBeforeUnmount(() => {
    session.detach();
  });

  // --- Watchers ---

  watch(
    () => ({ settings: settings.value, theme: theme.value }),
    () => {
      session.applySettings(theme.value, settings.value);
    },
    { deep: true },
  );

  watch(
    () => visible.value,
    async (nextVisible) => {
      session.setVisible(nextVisible);
      if (!nextVisible) return;
      await nextTick();
      session.handleBecomeVisible();
    },
  );

  // 运行管线（dispatchScript / run-chunk / trackRun）路由到「发起运行时选中的终端」：
  // 仅当当前运行归属于本会话（按唯一会话编号匹配，而非主会话 / 终端序号）时才跟踪 run，
  // 避免在未发起运行的终端里误抑制其交互输出。
  watch(
    () =>
      runRoutingStore.activeRunSessionId === sessionId ? editorStore.pendingTerminalRunId : null,
    (nextRunId) => {
      session.trackRun(nextRunId);
    },
    { flush: 'sync', immediate: true },
  );

  watch(
    showRunSeparator,
    (visibleSeparator) => {
      session.setRunSeparatorVisible(visibleSeparator);
    },
    { flush: 'sync' },
  );

  watch(
    deepDiagnosticsEnabled,
    () => {
      session.updateCallbacks(buildSessionCallbacks());
    },
    { flush: 'sync' },
  );

  // --- 对外 API ---

  return {
    hostRef,
    status: readonly(session.status),
    statusMessage: readonly(session.statusMessage),
    retry: async (): Promise<void> => session.retry(),
    focusTerminal: (): void => session.focusTerminal(),
  };
};
