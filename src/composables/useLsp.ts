import { computed, type MaybeRefOrGetter, onScopeDispose, ref, toRef, watch } from 'vue';
import { type BridgeStateEvent, lspBridge } from '@/services/editor/lsp-bridge';
import { createRunOnceScheduler, createSequencer, type Sequencer } from '@/utils/async-lifecycle';

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

const status = ref<LspStatus>('idle');
const error = ref<string | null>(null);
const serverName = 'bash-language-server';

let activeWorkspaceRoot: string | null = null;
let lifecycleToken = 0;
let autoRestartCount = 0;
let operationSequencer: Sequencer = createSequencer();
let scheduledAutoRestart: { root: string; token: number } | null = null;
let scheduledStabilityToken: number | null = null;
let stateSubscribed = false;
let unsubscribeState: (() => void) | null = null;

const autoRestartScheduler = createRunOnceScheduler(() => {
  const scheduled = scheduledAutoRestart;
  scheduledAutoRestart = null;
  if (!scheduled || !isLifecycleCurrent(scheduled.token, scheduled.root)) return;
  void runExclusive(() => startLspInternal(scheduled.root, scheduled.token));
}, AUTO_RESTART_BASE_DELAY_MS);

const stabilityResetScheduler = createRunOnceScheduler(() => {
  const token = scheduledStabilityToken;
  scheduledStabilityToken = null;
  if (token !== null && isLifecycleCurrent(token) && status.value === 'running') {
    autoRestartCount = 0;
  }
}, STABILITY_RESET_MS);

const clearAutoRestartTimer = (): void => {
  scheduledAutoRestart = null;
  autoRestartScheduler.cancel();
};

const clearStabilityTimer = (): void => {
  scheduledStabilityToken = null;
  stabilityResetScheduler.cancel();
};

const isLifecycleCurrent = (token: number, root = activeWorkspaceRoot): boolean =>
  token === lifecycleToken && root === activeWorkspaceRoot;

const runExclusive = (operation: () => Promise<void>): Promise<void> => operationSequencer.queue(operation);

const startLspInternal = async (root: string, token: number): Promise<void> => {
  if (!isLifecycleCurrent(token, root)) return;
  status.value = 'starting';
  error.value = null;
  try {
    await lspBridge.start(root);
    if (!isLifecycleCurrent(token, root)) return;
    status.value = 'running';
  } catch (err) {
    if (!isLifecycleCurrent(token, root)) return;
    status.value = 'error';
    error.value = err instanceof Error ? err.message : String(err);
  }
};

const stopLspInternal = async (token: number, nextStatus: LspStatus = 'stopped'): Promise<void> => {
  clearAutoRestartTimer();
  clearStabilityTimer();
  try {
    await lspBridge.stop();
  } catch {
    // 停止失败忽略。
  } finally {
    if (token === lifecycleToken) {
      status.value = nextStatus;
      if (nextStatus === 'idle') {
        error.value = null;
      }
    }
  }
};

const scheduleAutoRestart = (): void => {
  const root = activeWorkspaceRoot;
  if (!root) return;
  if (autoRestartCount >= MAX_AUTO_RESTARTS) {
    return;
  }

  const token = lifecycleToken;
  const delay = AUTO_RESTART_BASE_DELAY_MS * 2 ** autoRestartCount;
  autoRestartCount += 1;
  clearAutoRestartTimer();
  scheduledAutoRestart = { root, token };
  autoRestartScheduler.schedule(delay);
};

const handleBridgeState = (event: BridgeStateEvent): void => {
  const token = lifecycleToken;
  switch (event.type) {
    case 'started':
      if (!activeWorkspaceRoot) return;
      status.value = 'running';
      error.value = null;
      clearStabilityTimer();
      scheduledStabilityToken = token;
      stabilityResetScheduler.schedule();
      break;
    case 'stopped':
      clearStabilityTimer();
      if (status.value === 'running' || status.value === 'starting') {
        status.value = activeWorkspaceRoot ? 'stopped' : 'idle';
      }
      break;
    case 'crashed':
      if (!activeWorkspaceRoot) return;
      clearStabilityTimer();
      status.value = 'error';
      error.value = event.exitStatus
        ? `bash-language-server 异常退出（${event.exitStatus}）`
        : 'bash-language-server 异常退出';
      scheduleAutoRestart();
      break;
  }
};

const ensureStateSubscription = (): void => {
  if (stateSubscribed) return;
  unsubscribeState = lspBridge.onStateChange(handleBridgeState);
  stateSubscribed = true;
};

const setWorkspaceRoot = (root: string | null): Promise<void> => {
  ensureStateSubscription();
  if (root === activeWorkspaceRoot) {
    return operationSequencer.pending;
  }

  lifecycleToken += 1;
  const token = lifecycleToken;
  activeWorkspaceRoot = root;
  autoRestartCount = 0;
  clearAutoRestartTimer();
  clearStabilityTimer();

  return runExclusive(async () => {
    await stopLspInternal(token, root ? 'stopped' : 'idle');
    if (!isLifecycleCurrent(token, root)) return;
    if (root) {
      await startLspInternal(root, token);
    }
  });
};

const startLspShared = (root: string): Promise<void> => {
  ensureStateSubscription();
  lifecycleToken += 1;
  const token = lifecycleToken;
  activeWorkspaceRoot = root;
  autoRestartCount = 0;
  clearAutoRestartTimer();
  clearStabilityTimer();
  return runExclusive(() => startLspInternal(root, token));
};

const stopLspShared = (): Promise<void> => {
  ensureStateSubscription();
  lifecycleToken += 1;
  const token = lifecycleToken;
  activeWorkspaceRoot = null;
  return runExclusive(() => stopLspInternal(token, 'stopped'));
};

const restartLspShared = (): Promise<void> => {
  ensureStateSubscription();
  lifecycleToken += 1;
  const token = lifecycleToken;
  const root = activeWorkspaceRoot;
  autoRestartCount = 0;
  clearAutoRestartTimer();
  clearStabilityTimer();
  return runExclusive(async () => {
    await stopLspInternal(token, root ? 'stopped' : 'idle');
    if (!isLifecycleCurrent(token, root)) return;
    if (root) {
      await startLspInternal(root, token);
    }
  });
};

/**
 * Test-only reset for the module-level LSP lifecycle manager.
 * 不在生产代码中调用；用于避免单例状态跨测试污染。
 */
export const __resetLspLifecycleForTesting = (): void => {
  lifecycleToken += 1;
  activeWorkspaceRoot = null;
  autoRestartCount = 0;
  clearAutoRestartTimer();
  clearStabilityTimer();
  unsubscribeState?.();
  unsubscribeState = null;
  stateSubscribed = false;
  operationSequencer = createSequencer();
  status.value = 'idle';
  error.value = null;
};

/**
 * LSP 生命周期管理 composable。
 *
 * LSP 进程生命周期提升到模块级 manager：组件/侧栏切屏卸载时只释放本次订阅，
 * 不再停止 bash-language-server；只有 workspace root 变化、用户显式停止或应用级
 * root 清空时才停旧实例。这样可避免“切屏导致 LSP 停止/重启”的体验问题。
 */
export const useLsp = (workspaceRootPath: MaybeRefOrGetter<string | null>) => {
  const rootRef = toRef(workspaceRootPath);
  ensureStateSubscription();

  const isRunning = computed(() => status.value === 'running');
  const isStarting = computed(() => status.value === 'starting');
  const hasError = computed(() => status.value === 'error');
  const isActive = computed(() => isRunning.value || isStarting.value);

  const stopWatch = watch(
    rootRef,
    (newRoot) => {
      void setWorkspaceRoot(newRoot);
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    // 组件销毁不再停止 LSP；只取消这个 composable 实例的 root 监听。
    stopWatch();
  });

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
    startLsp: startLspShared,
    /** 手动停止 LSP */
    stopLsp: stopLspShared,
    /** 重启 LSP */
    restartLsp: restartLspShared,
  };
};
