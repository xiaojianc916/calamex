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

// 汇总「不应升级为致命错误界面」的可忽略错误:取消类错误、良性 ResizeObserver 噪声、
// 以及可恢复的调度器递归告警。集中判定,确保 window 监听器与 Vue 的
// app.config.errorHandler 走完全一致的过滤逻辑(后者此前漏过滤,导致一次可恢复的
// 递归告警就把整个工作台切到致命错误界面,表现为点击卡死、界面变白)。
const isIgnorableRuntimeError = (error: unknown): boolean => {
  return (
    isExpectedCancellationError(error) ||
    isBenignResizeObserverError(error) ||
    isRecoverableSchedulerWarning(error)
  );
};

// 「可恢复但会钉死主线程的循环告警」(递归更新 / ResizeObserver 回环)专属诊断:
//
// 设计缺陷修复 —— 此前这两类告警被 isIgnorableRuntimeError 直接静默 return:
// 既不升级致命界面(正确),也不留下任何痕迹(错误)。结果是「主线程被自触发重渲染/
// 布局回环占满」导致的卡死完全无从定位(控制台一片干净,正是用户反馈的现象)。
//
// 这里在「绝不升级致命界面」的前提下,把这类告警重新打印出来:Vue 会在
// 「Maximum recursive updates exceeded in component <X>」里点名是哪个组件在自触发
// 循环,从而把「静默卡死」变成「可定位」。循环会高频重复触发,故首条打印完整信息、
// 之后每累计 50 次汇总一次,避免刷屏又能证明它仍在持续空转。
let hasLoggedRecoverableLoop = false;
let recoverableLoopCount = 0;

const isRecoverableLoopWarning = (error: unknown): boolean =>
  isRecoverableSchedulerWarning(error) || isBenignResizeObserverError(error);

const logRecoverableLoopForDiagnosis = (error: unknown): void => {
  recoverableLoopCount += 1;

  if (hasLoggedRecoverableLoop) {
    if (recoverableLoopCount % 50 === 0) {
      console.warn(
        `[runtime-diagnostics] 可恢复循环告警已累计触发 ${recoverableLoopCount} 次:` +
          '主线程正被持续的自触发重渲染 / ResizeObserver 回环占用(界面卡死的直接原因)。',
      );
    }
    return;
  }

  hasLoggedRecoverableLoop = true;
  console.error(
    '[runtime-diagnostics] 捕获到可恢复但会钉死主线程的循环告警,' +
      '这是「进入应用几秒后点击无反应 / 界面卡死」的直接根因。' +
      '该告警未升级为致命错误界面,但下方信息会指出是哪个组件在自触发循环(请把这条连同其后的组件名/堆栈一并反馈):',
    error,
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

// 带过滤的运行时错误上报入口,供 Vue app.config.errorHandler 等调用方使用:在落入
// 致命错误界面前,先剔除可忽略/可恢复错误。Vue 调度器的「Maximum recursive updates
// exceeded」经由 app.config.errorHandler 上报(而非 window.onerror),因此必须在此过滤,
// 否则一次可恢复的递归告警会替换整个 router-view、让界面卡死变白。
//
// 注意:过滤 ≠ 静默丢弃。对「递归更新 / ResizeObserver 回环」这类虽可恢复、却会钉死
// 主线程的告警,这里在不升级致命界面的前提下仍打印诊断信息,以便定位自触发循环的来源。
export const reportRuntimeError = (title: string, error: unknown): void => {
  if (isIgnorableRuntimeError(error)) {
    if (isRecoverableLoopWarning(error)) {
      logRecoverableLoopForDiagnosis(error);
    }
    return;
  }

  setRuntimeError(title, error);
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
    if (isIgnorableRuntimeError(event.error) || isIgnorableRuntimeError(event.message)) {
      const candidate = event.error ?? event.message;
      if (isRecoverableLoopWarning(candidate)) {
        logRecoverableLoopForDiagnosis(candidate);
      }
      event.preventDefault();
      return;
    }

    setRuntimeError('应用运行时错误', event.error ?? event.message);
  };

  const handleUnhandledRejection = (event: PromiseRejectionEvent): void => {
    if (isIgnorableRuntimeError(event.reason)) {
      if (isRecoverableLoopWarning(event.reason)) {
        logRecoverableLoopForDiagnosis(event.reason);
      }
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
