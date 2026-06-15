import { ref } from 'vue';
import { isAppError } from '@/types/app-error';
import { toErrorMessage } from '@/utils/error';

export interface IRuntimeErrorState {
  title: string;
  message: string;
  detail: string;
  code?: string;
  traceId?: string;
}

declare global {
  interface Window {
    __SH_RUNTIME_DIAGNOSTICS_CLEANUP__?: (() => void) | undefined;
  }
}

export const runtimeErrorState = ref<IRuntimeErrorState | null>(null);

const readErrorLikeField = (error: unknown, field: 'name' | 'message'): string | null => {
  if (error instanceof Error) {
    return error[field];
  }

  if (typeof error === 'object' && error !== null && field in error) {
    const value = (error as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : null;
  }

  return typeof error === 'string' ? error : null;
};

const isExpectedCancellationError = (error: unknown): boolean => {
  const name = readErrorLikeField(error, 'name');
  const message = readErrorLikeField(error, 'message');

  return (
    (name === 'Canceled' && message === 'Canceled') ||
    name === 'AbortError' ||
    message === 'AbortError'
  );
};

const isBenignResizeObserverError = (error: unknown): boolean => {
  const errorMessage = readErrorLikeField(error, 'message') ?? '';
  const errorName = readErrorLikeField(error, 'name') ?? '';
  const mergedText = `${errorName}\n${errorMessage}\n${String(error)}`.toLowerCase();

  return (
    mergedText.includes('resizeobserver loop completed with undelivered notifications') ||
    mergedText.includes('resizeobserver loop limit exceeded')
  );
};

// Vue 在开发模式下的递归更新保护(checkRecursiveUpdates)抛出的告警是可恢复的:
// 它表示某次重渲染在一轮调度内被触发过多次,Vue 会自行中断该轮 flush,应用并未崩溃。
// 绝不能把它升级为致命错误界面 —— 否则 setRuntimeError 会替换整个 router-view,
// 而这次替换又落在同一轮超预算 flush 中再次抛出同样的告警,形成
// 「设错误态 → 重渲染 → 再抛错」的死循环,最终界面全白卡死。
const isRecoverableSchedulerWarning = (error: unknown): boolean => {
  const errorMessage = readErrorLikeField(error, 'message') ?? '';
  const mergedText = `${errorMessage}\n${String(error)}`.toLowerCase();

  return mergedText.includes('maximum recursive updates exceeded');
};

const normalizeErrorDetail = (error: unknown): string => {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    // 循环引用或宿主对象 stringify 失败时，退回 String(error) 仍能保留基本上下文。
    return String(error);
  }
};

const isSameRuntimeError = (
  current: IRuntimeErrorState | null,
  next: IRuntimeErrorState,
): boolean => {
  return (
    current !== null &&
    current.title === next.title &&
    current.message === next.message &&
    current.detail === next.detail &&
    current.code === next.code &&
    current.traceId === next.traceId
  );
};

export const setRuntimeError = (title: string, error: unknown): void => {
  const next: IRuntimeErrorState = {
    title,
    message: toErrorMessage(error, '发生未知错误'),
    detail: normalizeErrorDetail(error),
    code: isAppError(error) ? error.code : undefined,
    traceId: isAppError(error) ? error.traceId : undefined,
  };

  // 重复上报同一错误时保持引用不变,避免反复触发重渲染并叠加成递归更新风暴。
  if (isSameRuntimeError(runtimeErrorState.value, next)) {
    return;
  }

  runtimeErrorState.value = next;
};

const disposeRuntimeDiagnostics = (): void => {
  if (typeof window === 'undefined') {
    return;
  }

  const cleanup = window.__SH_RUNTIME_DIAGNOSTICS_CLEANUP__;
  if (!cleanup) {
    return;
  }

  cleanup();
  if (window.__SH_RUNTIME_DIAGNOSTICS_CLEANUP__ === cleanup) {
    window.__SH_RUNTIME_DIAGNOSTICS_CLEANUP__ = undefined;
  }
};

export const registerRuntimeDiagnostics = (): void => {
  if (typeof window === 'undefined') {
    return;
  }

  disposeRuntimeDiagnostics();

  const handleError = (event: ErrorEvent): void => {
    if (isBenignResizeObserverError(event.error) || isBenignResizeObserverError(event.message)) {
      event.preventDefault();
      return;
    }

    if (isRecoverableSchedulerWarning(event.error) || isRecoverableSchedulerWarning(event.message)) {
      event.preventDefault();
      return;
    }

    setRuntimeError('应用运行时错误', event.error ?? event.message);
  };

  const handleUnhandledRejection = (event: PromiseRejectionEvent): void => {
    if (isExpectedCancellationError(event.reason)) {
      event.preventDefault();
      return;
    }

    if (isBenignResizeObserverError(event.reason)) {
      event.preventDefault();
      return;
    }

    if (isRecoverableSchedulerWarning(event.reason)) {
      event.preventDefault();
      return;
    }

    setRuntimeError('未处理的异步错误', event.reason);
  };

  window.addEventListener('error', handleError);
  window.addEventListener('unhandledrejection', handleUnhandledRejection);

  const cleanup = (): void => {
    window.removeEventListener('error', handleError);
    window.removeEventListener('unhandledrejection', handleUnhandledRejection);
  };

  window.__SH_RUNTIME_DIAGNOSTICS_CLEANUP__ = cleanup;
};

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeRuntimeDiagnostics();
  });
}
