import { isAppError } from '@/types/app-error';
import { toErrorMessage } from '@/utils/error';
import { ref } from 'vue';

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

export const setRuntimeError = (title: string, error: unknown): void => {
  runtimeErrorState.value = {
    title,
    message: toErrorMessage(error, '发生未知错误'),
    detail: normalizeErrorDetail(error),
    code: isAppError(error) ? error.code : undefined,
    traceId: isAppError(error) ? error.traceId : undefined,
  };
};

export const disposeRuntimeDiagnostics = (): void => {
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
