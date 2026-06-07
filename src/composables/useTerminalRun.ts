import type { UnlistenFn } from '@tauri-apps/api/event';
import { type ComputedRef, onScopeDispose } from 'vue';
import { useMessage } from '@/composables/useMessage';
import { getTerminalEventBus } from '@/services/terminal/eventBus';
import { useTerminalFacade } from '@/services/terminal/facade';
import type { useEditorStore } from '@/store/editor';
import { useTerminalRunRoutingStore } from '@/store/terminalRunRouting';
import { useTerminalTabsStore } from '@/store/terminalTabs';
import { useTerminalRegistryStore } from '@/terminal/registry';
import type { IEditorDocument } from '@/types/editor';
import {
  DEFAULT_TERMINAL_SESSION_ID,
  type IDispatchTerminalScriptRequest,
  type ITerminalExitEvent,
  type ITerminalRunChunkPayload,
  type ITerminalRunCompletedPayload,
} from '@/types/terminal';
import { waitForDesktopRuntime } from '@/utils/desktop-runtime';
import { toErrorMessage } from '@/utils/error';
import { isShellScriptPath } from '@/utils/file-assets';
import { DEFAULT_EXECUTOR, getExecutorLabel } from '@/utils/templates';
import {
  buildDispatchedTerminalRunSummary,
  buildPendingTerminalRunSummary,
  buildTerminalRunCompletionDetail,
  buildTerminalRunHistoryEntry,
  buildTerminalRunResult,
  createActiveTerminalRunMeta,
  createTerminalRunId,
  type IActiveTerminalRunMeta,
  isTerminalRunFinalLog,
  TERMINAL_RUN_LOG_CODES,
  TERMINAL_RUN_LOG_TITLES,
} from '@/utils/terminal-run';

const TERMINAL_OUTPUT_BATCH_INTERVAL_MS = 120;
const TERMINAL_RUN_COMPLETION_TIMEOUT_MS = 30 * 60 * 1000;

type TEditorStore = ReturnType<typeof useEditorStore>;

type TUseTerminalRunOptions = {
  canRun: ComputedRef<boolean>;
  editorStore: TEditorStore;
};

const isTextDocument = (document: IEditorDocument): boolean => document.kind === 'text';

const isShellScriptDocument = (document: IEditorDocument): boolean =>
  isTextDocument(document) && isShellScriptPath(document.path ?? document.name);

const shouldDispatchDocumentContent = (document: IEditorDocument): boolean =>
  document.isDirty || !document.path;

const buildTerminalDispatchRequest = (
  document: IEditorDocument,
  runId: string,
  workspaceRootPath: string | null,
  sessionId: string,
): IDispatchTerminalScriptRequest => ({
  sessionId,
  path: document.path,
  workspaceRootPath,
  content: shouldDispatchDocumentContent(document) ? document.content : '',
  isDirty: document.isDirty,
  runId,
});

export const shouldKeepTerminalRunScopeAlive = (
  isRunning: boolean,
  currentRunId: string | null,
): boolean => isRunning || (currentRunId?.trim().length ?? 0) > 0;

export const useTerminalRun = ({ canRun, editorStore }: TUseTerminalRunOptions) => {
  const notifier = useMessage();
  const terminalRegistryStore = useTerminalRegistryStore();
  const terminalFacade = useTerminalFacade();
  const terminalEventBus = getTerminalEventBus();
  const runRoutingStore = useTerminalRunRoutingStore();
  const tabsStore = useTerminalTabsStore();

  let bufferedTerminalOutputChunks: string[] = [];
  let bufferedTerminalOutputTimerId: number | null = null;
  let terminalRunFallbackTimerId: number | null = null;
  let isDisposed = false;
  let isDetachedDuringActiveRun = false;
  let activeTerminalRunMeta: IActiveTerminalRunMeta | null = null;
  let hasEnsuredTerminalSession = false;
  let terminalRunChunkUnlisten: UnlistenFn | null = null;
  let terminalRunCompletedUnlisten: UnlistenFn | null = null;
  let terminalExitUnlisten: UnlistenFn | null = null;
  let terminalRunListenerRegistration: Promise<void> | null = null;
  let terminalRunListenerVersion = 0;

  const clearBufferedTerminalOutputTimer = (): void => {
    if (bufferedTerminalOutputTimerId === null) {
      return;
    }

    window.clearTimeout(bufferedTerminalOutputTimerId);
    bufferedTerminalOutputTimerId = null;
  };

  const clearTerminalRunFallbackTimer = (): void => {
    if (terminalRunFallbackTimerId === null) {
      return;
    }

    window.clearTimeout(terminalRunFallbackTimerId);
    terminalRunFallbackTimerId = null;
  };

  const flushBufferedTerminalOutput = (): void => {
    clearBufferedTerminalOutputTimer();

    if (bufferedTerminalOutputChunks.length === 0) {
      return;
    }

    const output = bufferedTerminalOutputChunks.join('');
    bufferedTerminalOutputChunks = [];

    if (isDisposed) {
      return;
    }

    editorStore.appendTerminalOutput(output);
  };

  const resetBufferedTerminalOutput = (): void => {
    clearBufferedTerminalOutputTimer();
    bufferedTerminalOutputChunks = [];
  };

  const clearActiveTerminalRunState = (): void => {
    editorStore.setPendingTerminalRunId(null);
    editorStore.setActiveRunSummary(null);
    runRoutingStore.setActiveRunSessionId(null);
    editorStore.isRunning = false;
    activeTerminalRunMeta = null;
  };

  const clearTerminalRunEventListeners = (): void => {
    terminalRunChunkUnlisten?.();
    terminalRunCompletedUnlisten?.();
    terminalExitUnlisten?.();
    terminalRunChunkUnlisten = null;
    terminalRunCompletedUnlisten = null;
    terminalExitUnlisten = null;
  };

  const disposeTerminalRunResources = (): void => {
    terminalRunListenerVersion += 1;
    clearTerminalRunEventListeners();
    terminalFacade.dispose();
    resetBufferedTerminalOutput();
    clearTerminalRunFallbackTimer();
  };

  const disposeDetachedTerminalRunScopeIfNeeded = (): void => {
    if (!isDetachedDuringActiveRun) {
      return;
    }
    isDisposed = true;
    isDetachedDuringActiveRun = false;
    disposeTerminalRunResources();
  };

  const appendRunLifecycleLog = (
    level: 'info' | 'success' | 'error',
    title: string,
    detail: string,
    runId: string | null,
    code: string,
  ): void => {
    editorStore.appendLog(level, title, detail, {
      scope: 'run',
      runId,
      code,
    });
  };

  const getCurrentTerminalRunId = (): string | null =>
    activeTerminalRunMeta?.runId ?? editorStore.currentRunId;

  // 运行路由以「当前运行归属会话」为准：优先取本次运行记录的会话编号，
  // 其次回退到当前选中的终端，最后才是默认主会话。
  const resolveRunSessionId = (): string =>
    runRoutingStore.activeRunSessionId ?? tabsStore.activeSessionId ?? DEFAULT_TERMINAL_SESSION_ID;

  const isActiveRunSession = (sessionId: string): boolean => sessionId === resolveRunSessionId();

  const resolveTerminalRunId = (runId: string | null | undefined): string | null => {
    const normalizedRunId = typeof runId === 'string' ? runId.trim() : '';
    if (
      normalizedRunId &&
      (editorStore.pendingTerminalRunId === normalizedRunId ||
        activeTerminalRunMeta?.runId === normalizedRunId ||
        editorStore.activeRunSummary?.runId === normalizedRunId)
    ) {
      return normalizedRunId;
    }

    if (!normalizedRunId) {
      return getCurrentTerminalRunId();
    }

    return null;
  };

  const isCurrentTerminalRun = (runId: string | null | undefined): boolean =>
    resolveTerminalRunId(runId) !== null;

  const hasFinalizedTerminalRun = (runId: string | null | undefined): boolean => {
    if (!runId) {
      return false;
    }

    if (editorStore.lastRunResult?.runId === runId) {
      return true;
    }

    return editorStore.runLogs.some((item) => item.runId === runId && isTerminalRunFinalLog(item));
  };

  const failTerminalRun = (
    title: string,
    errorOrMessage: unknown,
    fallbackMessage: string,
    logCode: string,
    options: {
      writeMessageToTerminalOutput?: boolean;
    } = {},
  ): void => {
    const message =
      typeof errorOrMessage === 'string'
        ? errorOrMessage
        : toErrorMessage(errorOrMessage, fallbackMessage);
    const failedRunId = getCurrentTerminalRunId();

    if (hasFinalizedTerminalRun(failedRunId)) {
      return;
    }

    resetBufferedTerminalOutput();
    clearTerminalRunFallbackTimer();
    clearActiveTerminalRunState();

    if (options.writeMessageToTerminalOutput) {
      editorStore.setTerminalOutput(message);
    }

    appendRunLifecycleLog('error', title, message, failedRunId, logCode);
    notifier.error(message);
    disposeDetachedTerminalRunScopeIfNeeded();
  };

  const scheduleTerminalRunCompletionTimeout = (runId: string): void => {
    clearTerminalRunFallbackTimer();
    terminalRunFallbackTimerId = window.setTimeout(() => {
      terminalRunFallbackTimerId = null;

      if (isDisposed || !isCurrentTerminalRun(runId)) {
        return;
      }

      failTerminalRun(
        TERMINAL_RUN_LOG_TITLES.timeout,
        '终端运行超时，已停止等待完成事件，请检查终端状态。',
        TERMINAL_RUN_LOG_TITLES.timeout,
        TERMINAL_RUN_LOG_CODES.timeout,
      );
    }, TERMINAL_RUN_COMPLETION_TIMEOUT_MS);
  };

  const ensureIntegratedTerminalSession = async (): Promise<void> => {
    await terminalFacade.ensureView();
    hasEnsuredTerminalSession = true;
  };

  const ensureIntegratedTerminalEventBridge = async (sessionId: string): Promise<void> => {
    const session = terminalRegistryStore.get(sessionId);
    if (!session) {
      return;
    }

    await session.registerEventListeners();
  };

  const ensureIntegratedTerminalSessionBeforeDispatch = async (
    sessionId: string,
  ): Promise<void> => {
    await ensureIntegratedTerminalEventBridge(sessionId);

    if (hasEnsuredTerminalSession) {
      return;
    }

    await ensureIntegratedTerminalSession();
  };

  const shouldReconnectIntegratedTerminal = (error: unknown): boolean => {
    const message = toErrorMessage(error, '');
    return message.includes('目标终端会话不存在');
  };

  const dispatchScriptToIntegratedTerminal = async (
    document: IEditorDocument,
    runId: string,
    sessionId: string,
  ) => {
    const dispatchRequest = buildTerminalDispatchRequest(
      document,
      runId,
      editorStore.workspaceRootPath,
      sessionId,
    );

    try {
      return await terminalFacade.dispatchScript(dispatchRequest);
    } catch (error) {
      if (!shouldReconnectIntegratedTerminal(error)) {
        throw error;
      }

      hasEnsuredTerminalSession = false;
      await ensureIntegratedTerminalSessionBeforeDispatch(sessionId);
      return terminalFacade.dispatchScript(dispatchRequest);
    }
  };

  const primeTerminalRun = (document: IEditorDocument): string => {
    const runId = createTerminalRunId();
    const startedAt = new Date().toISOString();
    const usedTempFile = document.isDirty || !document.path;

    editorStore.setPendingTerminalRunId(runId);
    editorStore.setActiveRunSummary(
      buildPendingTerminalRunSummary(document, runId, startedAt, DEFAULT_EXECUTOR, usedTempFile),
    );
    resetBufferedTerminalOutput();
    editorStore.lastRunResult = null;
    editorStore.setTerminalOutput('');
    activeTerminalRunMeta = createActiveTerminalRunMeta(runId, startedAt, 'bash', usedTempFile);
    appendRunLifecycleLog(
      'info',
      TERMINAL_RUN_LOG_TITLES.start,
      `当前脚本将使用 ${getExecutorLabel(DEFAULT_EXECUTOR)} 执行。`,
      runId,
      TERMINAL_RUN_LOG_CODES.start,
    );
    scheduleTerminalRunCompletionTimeout(runId);

    return runId;
  };

  const runScriptInIntegratedTerminal = async (document: IEditorDocument): Promise<void> => {
    if (!isShellScriptDocument(document)) {
      throw new Error('当前文件不是脚本文件，仅支持运行 .sh / .bash 脚本。');
    }

    // 路由到当前选中的终端：使用其唯一会话编号（自动生成），而非固定主会话或终端序号。
    const sessionId = tabsStore.activeSessionId || DEFAULT_TERMINAL_SESSION_ID;
    runRoutingStore.setActiveRunSessionId(sessionId);

    await ensureIntegratedTerminalSessionBeforeDispatch(sessionId);
    const runId = primeTerminalRun(document);

    try {
      const dispatchResult = await dispatchScriptToIntegratedTerminal(document, runId, sessionId);
      if (isDisposed || !isCurrentTerminalRun(runId)) {
        return;
      }

      activeTerminalRunMeta = createActiveTerminalRunMeta(
        runId,
        dispatchResult.startedAt,
        dispatchResult.commandLine,
        dispatchResult.usedTempFile,
      );
      editorStore.setActiveRunSummary(
        buildDispatchedTerminalRunSummary(document, activeTerminalRunMeta, DEFAULT_EXECUTOR),
      );
      appendRunLifecycleLog(
        'success',
        TERMINAL_RUN_LOG_TITLES.dispatched,
        dispatchResult.commandLine,
        runId,
        TERMINAL_RUN_LOG_CODES.dispatched,
      );

      if (dispatchResult.usedTempFile) {
        appendRunLifecycleLog(
          'info',
          TERMINAL_RUN_LOG_TITLES.tempFile,
          '当前内容已写入临时 shell 脚本文件后执行。',
          runId,
          TERMINAL_RUN_LOG_CODES.tempFile,
        );
      }

      notifier.success('脚本已发送到集成终端。');
    } catch (error) {
      if (isDisposed || !isCurrentTerminalRun(runId)) {
        return;
      }

      failTerminalRun('脚本执行失败', error, '脚本执行失败', TERMINAL_RUN_LOG_CODES.failed, {
        writeMessageToTerminalOutput: true,
      });
    }
  };

  const handleIntegratedTerminalExit = (payload: ITerminalExitEvent): void => {
    if (isDisposed || !isActiveRunSession(payload.sessionId)) {
      return;
    }

    hasEnsuredTerminalSession = false;

    const activeRunId = getCurrentTerminalRunId();
    if (!activeRunId) {
      return;
    }

    finalizeTerminalRun({
      sessionId: payload.sessionId,
      runId: activeRunId,
      exitCode: payload.exitCode,
      finishedAt: new Date().toISOString(),
    });
  };

  const ensureTerminalRunEventListeners = async (): Promise<void> => {
    if (terminalRunChunkUnlisten && terminalRunCompletedUnlisten && terminalExitUnlisten) {
      return;
    }

    if (terminalRunListenerRegistration) {
      return terminalRunListenerRegistration;
    }

    const version = terminalRunListenerVersion;
    terminalRunListenerRegistration = (async () => {
      const runtimeReady = await waitForDesktopRuntime();
      if (!runtimeReady || isDisposed) {
        return;
      }

      const runChunkUnlisten = terminalEventBus.onRunChunk((payload: ITerminalRunChunkPayload) => {
        appendStructuredTerminalOutput(payload);
      });
      const runCompletedUnlisten = terminalEventBus.onRunCompleted(
        (payload: ITerminalRunCompletedPayload) => {
          handleIntegratedTerminalRunCompleted(payload);
        },
      );
      const exitUnlisten = terminalEventBus.onInteractiveExited((payload: ITerminalExitEvent) => {
        handleIntegratedTerminalExit(payload);
      });

      if (isDisposed || terminalRunListenerVersion !== version) {
        runChunkUnlisten();
        runCompletedUnlisten();
        exitUnlisten();
        return;
      }

      try {
        await terminalEventBus.start();
      } catch (error) {
        runChunkUnlisten();
        runCompletedUnlisten();
        exitUnlisten();
        throw error;
      }

      terminalRunChunkUnlisten = runChunkUnlisten;
      terminalRunCompletedUnlisten = runCompletedUnlisten;
      terminalExitUnlisten = exitUnlisten;
    })().finally(() => {
      terminalRunListenerRegistration = null;
    });

    return terminalRunListenerRegistration;
  };

  const finalizeTerminalRun = (payload: ITerminalRunCompletedPayload): void => {
    if (!isActiveRunSession(payload.sessionId)) {
      return;
    }
    const resolvedRunId = resolveTerminalRunId(payload.runId);
    if (isDisposed || !resolvedRunId) {
      return;
    }

    if (hasFinalizedTerminalRun(resolvedRunId)) {
      if (activeTerminalRunMeta?.runId === resolvedRunId) {
        clearActiveTerminalRunState();
      }
      disposeDetachedTerminalRunScopeIfNeeded();
      return;
    }

    const normalizedPayload =
      payload.runId === resolvedRunId ? payload : { ...payload, runId: resolvedRunId };
    const activeRunSummary = editorStore.activeRunSummary;

    clearTerminalRunFallbackTimer();
    flushBufferedTerminalOutput();

    const runResult = buildTerminalRunResult({
      output: editorStore.getTerminalOutputSnapshot(),
      exitCode: normalizedPayload.exitCode,
      finishedAt: normalizedPayload.finishedAt,
      executor: DEFAULT_EXECUTOR,
      activeRunMeta: activeTerminalRunMeta,
      activeRunSummary,
    });

    editorStore.lastRunResult = runResult;
    editorStore.appendRunHistory(
      buildTerminalRunHistoryEntry(runResult, activeRunSummary, editorStore.document),
    );
    clearActiveTerminalRunState();

    appendRunLifecycleLog(
      runResult.success ? 'success' : 'error',
      runResult.success ? TERMINAL_RUN_LOG_TITLES.completed : TERMINAL_RUN_LOG_TITLES.failed,
      buildTerminalRunCompletionDetail(runResult),
      runResult.runId,
      runResult.success ? TERMINAL_RUN_LOG_CODES.completed : TERMINAL_RUN_LOG_CODES.failed,
    );

    if (runResult.success) {
      notifier.success('脚本执行完成。');
    } else {
      notifier.error('脚本执行失败，请检查终端输出。');
    }

    disposeDetachedTerminalRunScopeIfNeeded();
  };

  const handleIntegratedTerminalRunCompleted = (payload: ITerminalRunCompletedPayload): void => {
    finalizeTerminalRun(payload);
  };

  const runScript = async (): Promise<void> => {
    if (editorStore.isRunning) {
      notifier.warning('已有脚本正在运行，请等待完成或先停止当前运行。');
      return;
    }

    if (!canRun.value) {
      notifier.warning(
        isShellScriptDocument(editorStore.document)
          ? '请先提供可执行脚本内容，并确认当前系统存在可用的 WSL2 运行环境。'
          : '当前文件不是脚本文件，仅支持运行 .sh / .bash 脚本。',
      );
      return;
    }

    if (!editorStore.environment.hasAny) {
      notifier.error('当前系统不可用：WSL2。');
      return;
    }

    editorStore.isRunning = true;

    try {
      await ensureTerminalRunEventListeners();
      await runScriptInIntegratedTerminal(editorStore.document);
    } catch (error) {
      failTerminalRun('脚本执行失败', error, '脚本执行失败', TERMINAL_RUN_LOG_CODES.failed, {
        writeMessageToTerminalOutput: true,
      });
    }
  };

  const appendTerminalOutput = (payload: ITerminalRunChunkPayload): void => {
    if (
      isDisposed ||
      !isActiveRunSession(payload.sessionId) ||
      !payload.data ||
      !isCurrentTerminalRun(payload.runId)
    ) {
      return;
    }

    bufferedTerminalOutputChunks.push(payload.data);
    if (bufferedTerminalOutputTimerId !== null) {
      return;
    }

    bufferedTerminalOutputTimerId = window.setTimeout(() => {
      flushBufferedTerminalOutput();
    }, TERMINAL_OUTPUT_BATCH_INTERVAL_MS);
  };

  const appendStructuredTerminalOutput = (payload: ITerminalRunChunkPayload): void => {
    if (
      isDisposed ||
      !isActiveRunSession(payload.sessionId) ||
      !payload.data ||
      !isCurrentTerminalRun(payload.runId)
    ) {
      return;
    }

    appendTerminalOutput(payload);
  };

  onScopeDispose(() => {
    if (shouldKeepTerminalRunScopeAlive(editorStore.isRunning, getCurrentTerminalRunId())) {
      // 运行中的脚本是应用级后台任务，不属于当前 Vue 组件实例。
      // 页面/面板切换导致作用域卸载时，继续保留事件监听、输出缓冲和完成兜底计时器；
      // 等 run 正常完成/失败后再由 finalize/fail 路径释放本作用域资源。
      isDetachedDuringActiveRun = true;
      return;
    }

    isDisposed = true;
    disposeTerminalRunResources();
    clearActiveTerminalRunState();
  });

  return {
    runScript,
    appendTerminalOutput,
    handleIntegratedTerminalRunCompleted,
  };
};