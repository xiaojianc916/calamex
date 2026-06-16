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

// ---------------------------------------------------------------------------
// 自动埋点(automatic instrumentation)
//
// 设计目标:把「进入应用几秒后点击无反应 / 界面静默卡死」从黑盒变成事后可定位。
// 卡死时主线程被占满、点击无效,用户无法在现场操作控制台;且 WebView 可能并不会
// 真正 unload。因此这里维护一个常驻的内存事件时间线(环形缓冲),并在捕获到
// 「会钉死主线程的循环告警(递归更新 / ResizeObserver 回环)」或「页面隐藏」时,
// 自动把「肇事组件 + 最近事件时间线」落盘到 localStorage;下次启动自动读出并高亮
// 打印,然后清除。整个过程无需用户在卡死时做任何操作。
//
// 性能与安全约束:
// - 时间线为定长环形缓冲(DIAGNOSTIC_TIMELINE_LIMIT),连续相同事件合并计数,
//   即使循环高频触发埋点也不会无限增长、不会刷屏。
// - 落盘有节流:同一肇事组件只在首次出现时写一次 localStorage,避免在紧密循环中
//   反复同步写盘反而加剧卡顿。
// - 所有 localStorage / performance 访问都做了存在性与异常兜底,失败时静默忽略,
//   绝不影响主流程。
// ---------------------------------------------------------------------------

const DIAGNOSTIC_TIMELINE_LIMIT = 200;
const PERSISTED_DIAGNOSTIC_KEY = 'shell-ide.diagnostics.last-freeze';

interface IDiagnosticEvent {
  /** 相对启动的高精度毫秒数(performance.now,四舍五入)。 */
  at: number;
  /** 墙上时钟 ISO 时间,便于人读与跨重启对账。 */
  wall: string;
  category: string;
  detail?: string;
  /** 连续相同事件被合并的次数(>=2 时存在),用于在不刷屏的前提下表征循环强度。 */
  repeat?: number;
}

const diagnosticTimeline: IDiagnosticEvent[] = [];
const recursiveUpdateCulprits = new Set<string>();

const nowMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? Math.round(performance.now())
    : Date.now();

// 记录一次诊断事件。连续相同(category+detail)的事件会被合并计数,而非堆满缓冲,
// 这样即便某个自触发循环高频打点,也只占用一条记录并以 repeat 表征其强度。
export const recordDiagnosticEvent = (category: string, detail?: string): void => {
  const last = diagnosticTimeline[diagnosticTimeline.length - 1];
  if (last && last.category === category && last.detail === detail) {
    last.repeat = (last.repeat ?? 1) + 1;
    last.at = nowMs();
    return;
  }

  diagnosticTimeline.push({ at: nowMs(), wall: new Date().toISOString(), category, detail });

  if (diagnosticTimeline.length > DIAGNOSTIC_TIMELINE_LIMIT) {
    diagnosticTimeline.splice(0, diagnosticTimeline.length - DIAGNOSTIC_TIMELINE_LIMIT);
  }
};

const persistDiagnosticSnapshot = (reason: string): void => {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return;
  }

  try {
    const snapshot = {
      savedAt: new Date().toISOString(),
      reason,
      culprits: [...recursiveUpdateCulprits],
      loopCount: recoverableLoopCount,
      timeline: diagnosticTimeline.slice(-DIAGNOSTIC_TIMELINE_LIMIT),
    };
    window.localStorage.setItem(PERSISTED_DIAGNOSTIC_KEY, JSON.stringify(snapshot));
  } catch {
    // localStorage 配额 / 隐私模式 / 序列化失败时忽略:诊断落盘失败绝不能影响主流程。
  }
};

// 启动时读出上一次运行留存的卡死现场快照并高亮打印,然后清除。这是「自动埋点」闭环的
// 关键一步:静默卡死后用户只需重启,现场即自动呈现在控制台,无需在卡死时操作。
const flushPersistedDiagnosticToConsole = (): void => {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return;
  }

  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(PERSISTED_DIAGNOSTIC_KEY);
  } catch {
    return;
  }

  if (!raw) {
    return;
  }

  try {
    window.localStorage.removeItem(PERSISTED_DIAGNOSTIC_KEY);
  } catch {
    // 清除失败不影响打印;下次启动至多重复打印一次同一快照。
  }

  try {
    const snapshot: unknown = JSON.parse(raw);
    console.error(
      '[runtime-diagnostics] 检测到上次运行留存的「卡死现场」快照(自动埋点)。' +
        '其中 culprits 为自触发递归更新的肇事组件,timeline 为卡死前的事件时间线,' +
        '请将以下完整对象反馈以便定位:',
      snapshot,
    );
  } catch {
    console.error(
      '[runtime-diagnostics] 上次运行留存的卡死现场快照无法解析,原始内容如下:',
      raw,
    );
  }
};

// 由 main.ts 的 app.config.warnHandler 在捕获到「Maximum recursive updates exceeded」时调用,
// 传入 Vue 点名的肇事组件。这里记录事件并(对每个新出现的组件)落盘一次现场快照。
// 节流:同一组件只在首次出现时写盘,避免紧密循环里反复同步写 localStorage 加剧卡顿。
export const recordRecursiveUpdateCulprit = (componentName: string): void => {
  recordDiagnosticEvent('vue:recursive-update', componentName);

  if (!recursiveUpdateCulprits.has(componentName)) {
    recursiveUpdateCulprits.add(componentName);
    persistDiagnosticSnapshot(`recursive-update@${componentName}`);
  }
};

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
  // 自动埋点:把可恢复回环计入时间线(连续相同事件会合并计数,不会刷爆缓冲)。
  recordDiagnosticEvent('recoverable-loop', readErrorLikeField(error, 'message') ?? String(error));

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
  // 首次检出即落盘一次现场快照:此时主线程虽被钉死,但本次同步调用仍能完成一次写盘,
  // 确保即使页面随后彻底无响应、也已留存可供下次启动读出的现场。
  persistDiagnosticSnapshot('recoverable-loop-first-detected');
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
  // 诊断埋点:打印究竟是哪段代码、携带什么错误把应用升级到致命错误界面。
  // 全局 handler(window error/unhandledrejection、Vue errorHandler)在卡死前一条都没捕获,
  // 说明 setRuntimeError 是被某段业务代码「直接」调用的。这里在置错误态之前(故意放在去重
  // 提前返回之前,确保每次调用都留痕)打印错误本身与完整调用栈,定位真正的触发源。
  console.error(
    `[runtime-diagnostics] setRuntimeError 被调用 → 即将置 runtimeErrorState。title=${title}`,
    error,
  );
  // eslint-disable-next-line no-console
  console.trace('[runtime-diagnostics] setRuntimeError 调用栈(谁升级了致命错误界面)');

  const next: IRuntimeErrorState = {
    title,
    message: toErrorMessage(error, '发生未知错误'),
    detail: normalizeErrorDetail(error),
    code: isAppError(error) ? error.code : undefined,
    traceId: isAppError(error) ? error.traceId : undefined,
  };

  // 自动埋点:升级为致命错误界面前先记一笔,便于在时间线里看到「错误界面」出现的时点。
  recordDiagnosticEvent('runtime-error', `${title}: ${next.message}`);

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

  // 自动埋点闭环:启动即读出并高亮打印上一次运行留存的卡死现场快照,然后清除。
  flushPersistedDiagnosticToConsole();

  const handleError = (event: ErrorEvent): void => {
    if (isIgnorableRuntimeError(event.error) || isIgnorableRuntimeError(event.message)) {
      const candidate = event.error ?? event.message;
      if (isRecoverableLoopWarning(candidate)) {
        logRecoverableLoopForDiagnosis(candidate);
      }
      event.preventDefault();
      return;
    }

    recordDiagnosticEvent('window:error', readErrorLikeField(event.error ?? event.message, 'message') ?? String(event.message));
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

    recordDiagnosticEvent('window:unhandledrejection', readErrorLikeField(event.reason, 'message') ?? String(event.reason));
    setRuntimeError('未处理的异步错误', event.reason);
  };

  // 页面隐藏 / 卸载时,若本次运行曾检出可恢复回环,补落一次现场快照作为兜底。
  const handlePageHide = (): void => {
    if (hasLoggedRecoverableLoop) {
      persistDiagnosticSnapshot('pagehide-after-loop');
    }
  };

  window.addEventListener('error', handleError);
  window.addEventListener('unhandledrejection', handleUnhandledRejection);
  window.addEventListener('pagehide', handlePageHide);

  const cleanup = (): void => {
    window.removeEventListener('error', handleError);
    window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    window.removeEventListener('pagehide', handlePageHide);
  };

  window.__SH_RUNTIME_DIAGNOSTICS_CLEANUP__ = cleanup;
};

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeRuntimeDiagnostics();
  });
}
