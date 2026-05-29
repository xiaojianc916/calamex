import { computed, type MaybeRefOrGetter, onScopeDispose, ref, toRef, watch } from 'vue';
import { type BridgeStateEvent, lspBridge } from '@/services/editor/lsp-bridge';

/**
 * LSP 状态枚举
 * - idle: 尚未尝试启动（无 workspace root）
 * - starting: 正在启动 bash-language-server
 * - running: LSP 正常运行中
 * - stopped: 已主动停止
 * - error: 启动失败或运行时异常
 */
export type LspStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'error';

/** 崩溃后最大自动重启次数（超过后保持 error，等用户手动重启） */
const MAX_AUTO_RESTARTS = 3;
/** 自动重启基础退避时间（毫秒），按 2^n 退避 */
const AUTO_RESTART_BASE_DELAY_MS = 1000;
/** 稳定运行超过此时长视为“健康”，重置自动重启计数（毫秒） */
const STABILITY_RESET_MS = 30_000;

/**
 * LSP 生命周期管理 composable。
 *
 * 入参 workspaceRootPath 为响应式值（ref / computed / getter），
 * 变化时自动停止旧实例并启动新实例。
 *
 * 同时订阅 bridge 状态事件：后端崩溃 / 外部停止会如实反映到状态栏，
 * 并在崩溃后做限次指数退避自动重启。
 *
 * 组件卸载时自动停止 LSP、取消订阅与定时器，无进程 / 监听泄漏。
 */
export const useLsp = (workspaceRootPath: MaybeRefOrGetter<string | null>) => {
  const rootRef = toRef(workspaceRootPath);

  const status = ref<LspStatus>('idle');
  const error = ref<string | null>(null);
  const serverName = 'bash-language-server';

  const isRunning = computed(() => status.value === 'running');
  const isStarting = computed(() => status.value === 'starting');
  const hasError = computed(() => status.value === 'error');
  const isActive = computed(() => isRunning.value || isStarting.value);

  let isDisposed = false;
  let autoRestartCount = 0;
  let autoRestartTimer: ReturnType<typeof setTimeout> | null = null;
  let stabilityTimer: ReturnType<typeof setTimeout> | null = null;

  const clearAutoRestartTimer = (): void => {
    if (autoRestartTimer !== null) {
      clearTimeout(autoRestartTimer);
      autoRestartTimer = null;
    }
  };
  const clearStabilityTimer = (): void => {
    if (stabilityTimer !== null) {
      clearTimeout(stabilityTimer);
      stabilityTimer = null;
    }
  };

  const startLsp = async (root: string): Promise<void> => {
    if (isDisposed) return;
    status.value = 'starting';
    error.value = null;
    try {
      await lspBridge.start(root);
      if (isDisposed) return;
      status.value = 'running';
    } catch (err) {
      if (isDisposed) return;
      status.value = 'error';
      error.value = err instanceof Error ? err.message : String(err);
    }
  };

  const stopLsp = async (): Promise<void> => {
    if (isDisposed) return;
    // 主动停止会取消任何待执行的自动重启
    clearAutoRestartTimer();
    clearStabilityTimer();
    try {
      await lspBridge.stop();
    } catch {
      // 停止失败忽略
    } finally {
      if (!isDisposed) {
        status.value = 'stopped';
      }
    }
  };

  /** 崩溃后按指数退避调度一次自动重启；超过上限则放弃。 */
  const scheduleAutoRestart = (): void => {
    if (isDisposed) return;
    const root = rootRef.value;
    if (!root) return;
    if (autoRestartCount >= MAX_AUTO_RESTARTS) {
      // 连续崩溃太多次，停止自动重启，保持 error 等用户手动重启
      return;
    }
    const delay = AUTO_RESTART_BASE_DELAY_MS * 2 ** autoRestartCount;
    autoRestartCount += 1;
    clearAutoRestartTimer();
    autoRestartTimer = setTimeout(() => {
      autoRestartTimer = null;
      if (isDisposed) return;
      const current = rootRef.value;
      if (!current) return;
      void startLsp(current);
    }, delay);
  };

  // 订阅 bridge 状态变化，让状态栏反映后端真实状态（包括后端自发的崩溃 / 停止）。
  const handleBridgeState = (e: BridgeStateEvent): void => {
    if (isDisposed) return;
    switch (e.type) {
      case 'started':
        status.value = 'running';
        error.value = null;
        // 稳定运行一段时间后重置重启计数，避免偏偏崩溃累加到上限后永久放弃
        clearStabilityTimer();
        stabilityTimer = setTimeout(() => {
          stabilityTimer = null;
          if (!isDisposed && status.value === 'running') {
            autoRestartCount = 0;
          }
        }, STABILITY_RESET_MS);
        break;
      case 'stopped':
        clearStabilityTimer();
        // 主动停止由 stopLsp 自己置位；这里只兜底外部停止
        if (status.value === 'running' || status.value === 'starting') {
          status.value = 'stopped';
        }
        break;
      case 'crashed':
        clearStabilityTimer();
        status.value = 'error';
        error.value = e.exitStatus
          ? `bash-language-server 异常退出（${e.exitStatus}）`
          : 'bash-language-server 异常退出';
        scheduleAutoRestart();
        break;
    }
  };

  const unsubscribeState = lspBridge.onStateChange(handleBridgeState);

  const restartLsp = async (): Promise<void> => {
    if (isDisposed) return;
    // 用户手动重启：重置退避计数，给予全新的重试预算
    autoRestartCount = 0;
    clearAutoRestartTimer();
    await stopLsp();
    const root = rootRef.value;
    if (root) {
      await startLsp(root);
    } else {
      status.value = 'idle';
      error.value = null;
    }
  };

  onScopeDispose(() => {
    isDisposed = true;
    clearAutoRestartTimer();
    clearStabilityTimer();
    unsubscribeState();
    void lspBridge.stop().catch(() => {});
  });

  watch(
    rootRef,
    async (newRoot, oldRoot) => {
      if (isDisposed) return;
      if (newRoot === oldRoot) return;

      // 切换工作区：重置退避计数，取消待执行重启
      autoRestartCount = 0;
      clearAutoRestartTimer();

      // 先停旧实例
      if (lspBridge.isStarted()) {
        await stopLsp();
      }

      if (newRoot) {
        await startLsp(newRoot);
      } else {
        status.value = 'idle';
        error.value = null;
      }
    },
    { immediate: true },
  );

  return {
    /** 当前 LSP 状态 */
    status,
    /** 最近一次错误消息 */
    error,
    /** 服务器名称 */
    serverName,
    /** LSP 是否正在运行 */
    isRunning,
    /** LSP 是否正在启动 */
    isStarting,
    /** LSP 是否处于错误状态 */
    hasError,
    /** LSP 是否处于活跃状态（启动中或运行中） */
    isActive,
    /** 手动启动 LSP */
    startLsp,
    /** 手动停止 LSP */
    stopLsp,
    /** 重启 LSP */
    restartLsp,
  };
};
