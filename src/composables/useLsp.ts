import { computed, type MaybeRefOrGetter, onScopeDispose, ref, toRef, watch } from 'vue';
import { lspBridge } from '@/services/editor/lsp-bridge';

/**
 * LSP 状态枚举
 * - idle: 尚未尝试启动（无 workspace root）
 * - starting: 正在启动 bash-language-server
 * - running: LSP 正常运行中
 * - stopped: 已主动停止
 * - error: 启动失败或运行时异常
 */
export type LspStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'error';

/**
 * LSP 生命周期管理 composable。
 *
 * 入参 workspaceRootPath 为响应式值（ref / computed / getter），
 * 变化时自动停止旧实例并启动新实例。
 *
 * 组件卸载时自动停止 LSP，无进程泄漏。
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

  onScopeDispose(() => {
    isDisposed = true;
    void lspBridge.stop().catch(() => {});
  });

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

  const restartLsp = async (): Promise<void> => {
    if (isDisposed) return;
    await stopLsp();
    const root = rootRef.value;
    if (root) {
      await startLsp(root);
    } else {
      status.value = 'idle';
      error.value = null;
    }
  };

  watch(
    rootRef,
    async (newRoot, oldRoot) => {
      if (isDisposed) return;
      if (newRoot === oldRoot) return;

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
