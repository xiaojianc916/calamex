import type { ComputedRef } from 'vue';
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
import { waitForDesktopRuntime } from '@/utils/platform/desktop-runtime';
import { createDisposableBag, createMutableDisposable } from '@/utils/core/disposable';
import { requestDisposableTimeout } from '@/utils/platform/dom-lifecycle';
import { toErrorMessage } from '@/utils/error/error';
import { isShellScriptPath } from '@/utils/file/file-assets';
import { DEFAULT_EXECUTOR, getExecutorLabel } from '@/utils/core/templates';
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
} from '@/utils/terminal/terminal-run';

const TERMINAL_OUTPUT_BATCH_INTERVAL_MS = 120;
const TERMINAL_RUN_COMPLETION_TIMEOUT_MS = 30 * 60 * 1000;

type TEditorStore = ReturnType<typeof useEditorStore>;

export type TTerminalRunNotifier = {
  success(message: string): void;
  warning(message: string): void;
  error(message: string): void;
};

export type TTerminalRunOrchestratorBinding = {
  canRun: ComputedRef<boolean>;
  editorStore: TEditorStore;
  notifier: TTerminalRunNotifier;
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

/**
 * Application-level terminal/script run lifecycle.
 *
 * A run is a background task owned by the application, not by the current Vue
 * route, terminal panel, or composable instance. Keeping the event listeners,
 * output buffer, completion timeout and active-run metadata in this singleton
 * prevents view switches from tearing down a still-running task.
 */
export class TerminalRunOrchestrator {
  private binding: TTerminalRunOrchestratorBinding | null = null;
  private readonly terminalRegistryStore = useTerminalRegistryStore();
  private readonly terminalFacade = useTerminalFacade();
  private readonly terminalEventBus = getTerminalEventBus();
  private readonly runRoutingStore = useTerminalRunRoutingStore();
  private readonly tabsStore = useTerminalTabsStore();

  private bufferedTerminalOutputChunks: string[] = [];
  private readonly bufferedTerminalOutputTimer = createMutableDisposable();
  private readonly terminalRunFallbackTimer = createMutableDisposable();
  private readonly terminalRunListeners = createMutableDisposable();
  private activeTerminalRunMeta: IActiveTerminalRunMeta | null = null;
  private hasEnsuredTerminalSession = false;
  private terminalRunListenerRegistration: Promise<void> | null = null;
  private terminalRunListenerVersion = 0;

  bind(binding: TTerminalRunOrchestratorBinding): void {
    this.binding = binding;
  }

  async runScript(): Promise<void> {
    const { canRun, editorStore, notifier } = this.requireBinding();

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
      await this.ensureTerminalRunEventListeners();
      await this.runScriptInIntegratedTerminal(editorStore.document);
    } catch (error) {
      this.failTerminalRun('脚本执行失败', error, '脚本执行失败', TERMINAL_RUN_LOG_CODES.failed, {
        writeMessageToTerminalOutput: true,
      });
    }
  }

  appendTerminalOutput(payload: ITerminalRunChunkPayload): void {
    if (
      !this.isActiveRunSession(payload.sessionId) ||
      !payload.data ||
      !this.isCurrentTerminalRun(payload.runId)
    ) {
      return;
    }

    this.bufferedTerminalOutputChunks.push(payload.data);
    if (this.bufferedTerminalOutputTimer.value !== null) {
      return;
    }

    this.bufferedTerminalOutputTimer.set(
      requestDisposableTimeout(() => {
        this.bufferedTerminalOutputTimer.clearAndLeak();
        this.flushBufferedTerminalOutput();
      }, TERMINAL_OUTPUT_BATCH_INTERVAL_MS),
    );
  }

  handleIntegratedTerminalRunCompleted(payload: ITerminalRunCompletedPayload): void {
    this.finalizeTerminalRun(payload);
  }

  /**
   * Explicit user/system reset path.
   *
   * This is different from Vue scope disposal: reset means the current run should
   * be forgotten by the app-level orchestrator, so late run-completed events from
   * a cancelled/stale backend process cannot recreate history or reopen the run
   * gate after the user already chose Stop/Reset.
   */
  resetActiveRunLifecycle(): void {
    this.resetBufferedTerminalOutput();
    this.clearTerminalRunFallbackTimer();
    if (this.binding) {
      this.clearActiveTerminalRunState();
      return;
    }
    this.activeTerminalRunMeta = null;
  }

  dispose(): void {
    this.terminalRunListenerVersion += 1;
    this.clearTerminalRunEventListeners();
    this.terminalFacade.dispose();
    this.hasEnsuredTerminalSession = false;
    this.resetActiveRunLifecycle();
    if (this.binding) {
      this.clearActiveTerminalRunState();
    }
    this.binding = null;
  }

  private requireBinding(): TTerminalRunOrchestratorBinding {
    if (!this.binding) {
      throw new Error('终端运行编排器尚未绑定编辑器上下文。');
    }
    return this.binding;
  }

  private get editorStore(): TEditorStore {
    return this.requireBinding().editorStore;
  }

  private get notifier(): TTerminalRunNotifier {
    return this.requireBinding().notifier;
  }

  private clearBufferedTerminalOutputTimer(): void {
    this.bufferedTerminalOutputTimer.clear();
  }

  private clearTerminalRunFallbackTimer(): void {
    this.terminalRunFallbackTimer.clear();
  }

  private flushBufferedTerminalOutput(): void {
    this.clearBufferedTerminalOutputTimer();

    if (this.bufferedTerminalOutputChunks.length === 0) {
      return;
    }

    const output = this.bufferedTerminalOutputChunks.join('');
    this.bufferedTerminalOutputChunks = [];
    this.editorStore.appendTerminalOutput(output);
  }

  private resetBufferedTerminalOutput(): void {
    this.clearBufferedTerminalOutputTimer();
    this.bufferedTerminalOutputChunks = [];
  }

  private clearActiveTerminalRunState(): void {
    this.editorStore.setPendingTerminalRunId(null);
    this.editorStore.setActiveRunSummary(null);
    this.runRoutingStore.setActiveRunSessionId(null);
    this.editorStore.isRunning = false;
    this.activeTerminalRunMeta = null;
  }

  private clearTerminalRunEventListeners(): void {
    this.terminalRunListeners.clear();
  }

  private appendRunLifecycleLog(
    level: 'info' | 'success' | 'error',
    title: string,
    detail: string,
    runId: string | null,
    code: string,
  ): void {
    this.editorStore.appendLog(level, title, detail, {
      scope: 'run',
      runId,
      code,
    });
  }

  private getCurrentTerminalRunId(): string | null {
    return this.activeTerminalRunMeta?.runId ?? this.editorStore.currentRunId;
  }

  private resolveRunSessionId(): string {
    return (
      this.runRoutingStore.activeRunSessionId ??
      this.tabsStore.activeSessionId ??
      DEFAULT_TERMINAL_SESSION_ID
    );
  }

  private isActiveRunSession(sessionId: string): boolean {
    return sessionId === this.resolveRunSessionId();
  }

  private resolveTerminalRunId(runId: string | null | undefined): string | null {
    const normalizedRunId = typeof runId === 'string' ? runId.trim() : '';
    if (
      normalizedRunId &&
      (this.editorStore.pendingTerminalRunId === normalizedRunId ||
        this.activeTerminalRunMeta?.runId === normalizedRunId ||
        this.editorStore.activeRunSummary?.runId === normalizedRunId)
    ) {
      return normalizedRunId;
    }

    if (!normalizedRunId) {
      return this.getCurrentTerminalRunId();
    }

    return null;
  }

  private isCurrentTerminalRun(runId: string | null | undefined): boolean {
    return this.resolveTerminalRunId(runId) !== null;
  }

  private hasFinalizedTerminalRun(runId: string | null | undefined): boolean {
    if (!runId) {
      return false;
    }

    if (this.editorStore.lastRunResult?.runId === runId) {
      return true;
    }

    return this.editorStore.runLogs.some(
      (item) => item.runId === runId && isTerminalRunFinalLog(item),
    );
  }

  private failTerminalRun(
    title: string,
    errorOrMessage: unknown,
    fallbackMessage: string,
    logCode: string,
    options: {
      writeMessageToTerminalOutput?: boolean;
    } = {},
  ): void {
    const message =
      typeof errorOrMessage === 'string'
        ? errorOrMessage
        : toErrorMessage(errorOrMessage, fallbackMessage);
    const failedRunId = this.getCurrentTerminalRunId();

    if (this.hasFinalizedTerminalRun(failedRunId)) {
      return;
    }

    this.resetBufferedTerminalOutput();
    this.clearTerminalRunFallbackTimer();
    this.clearActiveTerminalRunState();

    if (options.writeMessageToTerminalOutput) {
      this.editorStore.setTerminalOutput(message);
    }

    this.appendRunLifecycleLog('error', title, message, failedRunId, logCode);
    this.notifier.error(message);
  }

  private scheduleTerminalRunCompletionTimeout(runId: string): void {
    this.clearTerminalRunFallbackTimer();
    this.terminalRunFallbackTimer.set(
      requestDisposableTimeout(() => {
        this.terminalRunFallbackTimer.clearAndLeak();

        if (!this.isCurrentTerminalRun(runId)) {
          return;
        }

        this.failTerminalRun(
          TERMINAL_RUN_LOG_TITLES.timeout,
          '终端运行超时，已停止等待完成事件，请检查终端状态。',
          TERMINAL_RUN_LOG_TITLES.timeout,
          TERMINAL_RUN_LOG_CODES.timeout,
        );
      }, TERMINAL_RUN_COMPLETION_TIMEOUT_MS),
    );
  }

  private async ensureIntegratedTerminalSession(): Promise<void> {
    await this.terminalFacade.ensureView();
    this.hasEnsuredTerminalSession = true;
  }

  private async ensureIntegratedTerminalEventBridge(sessionId: string): Promise<void> {
    const session = this.terminalRegistryStore.get(sessionId);
    if (!session) {
      return;
    }

    await session.registerEventListeners();
  }

  private async ensureIntegratedTerminalSessionBeforeDispatch(sessionId: string): Promise<void> {
    await this.ensureIntegratedTerminalEventBridge(sessionId);

    if (this.hasEnsuredTerminalSession) {
      return;
    }

    await this.ensureIntegratedTerminalSession();
  }

  private shouldReconnectIntegratedTerminal(error: unknown): boolean {
    const message = toErrorMessage(error, '');
    return message.includes('目标终端会话不存在');
  }

  private async dispatchScriptToIntegratedTerminal(
    document: IEditorDocument,
    runId: string,
    sessionId: string,
  ) {
    const dispatchRequest = buildTerminalDispatchRequest(
      document,
      runId,
      this.editorStore.workspaceRootPath,
      sessionId,
    );

    try {
      return await this.terminalFacade.dispatchScript(dispatchRequest);
    } catch (error) {
      if (!this.shouldReconnectIntegratedTerminal(error)) {
        throw error;
      }

      this.hasEnsuredTerminalSession = false;
      await this.ensureIntegratedTerminalSessionBeforeDispatch(sessionId);
      return this.terminalFacade.dispatchScript(dispatchRequest);
    }
  }

  private primeTerminalRun(document: IEditorDocument): string {
    const runId = createTerminalRunId();
    const startedAt = new Date().toISOString();
    const usedTempFile = document.isDirty || !document.path;

    this.editorStore.setPendingTerminalRunId(runId);
    this.editorStore.setActiveRunSummary(
      buildPendingTerminalRunSummary(document, runId, startedAt, DEFAULT_EXECUTOR, usedTempFile),
    );
    this.resetBufferedTerminalOutput();
    this.editorStore.lastRunResult = null;
    this.editorStore.setTerminalOutput('');
    this.activeTerminalRunMeta = createActiveTerminalRunMeta(
      runId,
      startedAt,
      'bash',
      usedTempFile,
    );
    this.appendRunLifecycleLog(
      'info',
      TERMINAL_RUN_LOG_TITLES.start,
      `当前脚本将使用 ${getExecutorLabel(DEFAULT_EXECUTOR)} 执行。`,
      runId,
      TERMINAL_RUN_LOG_CODES.start,
    );
    this.scheduleTerminalRunCompletionTimeout(runId);

    return runId;
  }

  private async runScriptInIntegratedTerminal(document: IEditorDocument): Promise<void> {
    if (!isShellScriptDocument(document)) {
      throw new Error('当前文件不是脚本文件，仅支持运行 .sh / .bash 脚本。');
    }

    const sessionId = this.tabsStore.activeSessionId || DEFAULT_TERMINAL_SESSION_ID;
    this.runRoutingStore.setActiveRunSessionId(sessionId);

    await this.ensureIntegratedTerminalSessionBeforeDispatch(sessionId);
    const runId = this.primeTerminalRun(document);

    try {
      const dispatchResult = await this.dispatchScriptToIntegratedTerminal(
        document,
        runId,
        sessionId,
      );
      if (!this.isCurrentTerminalRun(runId)) {
        return;
      }

      this.activeTerminalRunMeta = createActiveTerminalRunMeta(
        runId,
        dispatchResult.startedAt,
        dispatchResult.commandLine,
        dispatchResult.usedTempFile,
      );
      this.editorStore.setActiveRunSummary(
        buildDispatchedTerminalRunSummary(document, this.activeTerminalRunMeta, DEFAULT_EXECUTOR),
      );
      this.appendRunLifecycleLog(
        'success',
        TERMINAL_RUN_LOG_TITLES.dispatched,
        dispatchResult.commandLine,
        runId,
        TERMINAL_RUN_LOG_CODES.dispatched,
      );

      if (dispatchResult.usedTempFile) {
        this.appendRunLifecycleLog(
          'info',
          TERMINAL_RUN_LOG_TITLES.tempFile,
          '当前内容已写入临时 shell 脚本文件后执行。',
          runId,
          TERMINAL_RUN_LOG_CODES.tempFile,
        );
      }

      this.notifier.success('脚本已发送到集成终端。');
    } catch (error) {
      if (!this.isCurrentTerminalRun(runId)) {
        return;
      }

      this.failTerminalRun('脚本执行失败', error, '脚本执行失败', TERMINAL_RUN_LOG_CODES.failed, {
        writeMessageToTerminalOutput: true,
      });
    }
  }

  private handleIntegratedTerminalExit(payload: ITerminalExitEvent): void {
    if (!this.isActiveRunSession(payload.sessionId)) {
      return;
    }

    this.hasEnsuredTerminalSession = false;

    const activeRunId = this.getCurrentTerminalRunId();
    if (!activeRunId) {
      return;
    }

    this.finalizeTerminalRun({
      sessionId: payload.sessionId,
      runId: activeRunId,
      exitCode: payload.exitCode,
      finishedAt: new Date().toISOString(),
    });
  }

  private async ensureTerminalRunEventListeners(): Promise<void> {
    if (this.terminalRunListeners.value !== null) {
      return;
    }

    if (this.terminalRunListenerRegistration) {
      return this.terminalRunListenerRegistration;
    }

    const version = this.terminalRunListenerVersion;
    this.terminalRunListenerRegistration = (async () => {
      const runtimeReady = await waitForDesktopRuntime();
      if (!runtimeReady) {
        return;
      }

      const listeners = createDisposableBag();
      const runChunkUnlisten = this.terminalEventBus.onRunChunk(
        (payload: ITerminalRunChunkPayload) => {
          this.appendTerminalOutput(payload);
        },
      );
      const runCompletedUnlisten = this.terminalEventBus.onRunCompleted(
        (payload: ITerminalRunCompletedPayload) => {
          this.handleIntegratedTerminalRunCompleted(payload);
        },
      );
      const exitUnlisten = this.terminalEventBus.onInteractiveExited(
        (payload: ITerminalExitEvent) => {
          this.handleIntegratedTerminalExit(payload);
        },
      );
      listeners.add(runChunkUnlisten);
      listeners.add(runCompletedUnlisten);
      listeners.add(exitUnlisten);

      if (this.terminalRunListenerVersion !== version) {
        void listeners.dispose();
        return;
      }

      try {
        await this.terminalEventBus.start();
      } catch (error) {
        void listeners.dispose();
        throw error;
      }

      if (this.terminalRunListenerVersion !== version) {
        void listeners.dispose();
        return;
      }

      this.terminalRunListeners.set(() => listeners.dispose());
    })().finally(() => {
      this.terminalRunListenerRegistration = null;
    });

    return this.terminalRunListenerRegistration;
  }

  private finalizeTerminalRun(payload: ITerminalRunCompletedPayload): void {
    if (!this.isActiveRunSession(payload.sessionId)) {
      return;
    }
    const resolvedRunId = this.resolveTerminalRunId(payload.runId);
    if (!resolvedRunId) {
      return;
    }

    if (this.hasFinalizedTerminalRun(resolvedRunId)) {
      if (this.activeTerminalRunMeta?.runId === resolvedRunId) {
        this.clearActiveTerminalRunState();
      }
      return;
    }

    const normalizedPayload =
      payload.runId === resolvedRunId ? payload : { ...payload, runId: resolvedRunId };
    const activeRunSummary = this.editorStore.activeRunSummary;

    this.clearTerminalRunFallbackTimer();
    this.flushBufferedTerminalOutput();

    const runResult = buildTerminalRunResult({
      output: this.editorStore.getTerminalOutputSnapshot(),
      exitCode: normalizedPayload.exitCode,
      finishedAt: normalizedPayload.finishedAt,
      executor: DEFAULT_EXECUTOR,
      activeRunMeta: this.activeTerminalRunMeta,
      activeRunSummary,
    });

    this.editorStore.lastRunResult = runResult;
    this.editorStore.appendRunHistory(
      buildTerminalRunHistoryEntry(runResult, activeRunSummary, this.editorStore.document),
    );
    this.clearActiveTerminalRunState();

    this.appendRunLifecycleLog(
      runResult.success ? 'success' : 'error',
      runResult.success ? TERMINAL_RUN_LOG_TITLES.completed : TERMINAL_RUN_LOG_TITLES.failed,
      buildTerminalRunCompletionDetail(runResult),
      runResult.runId,
      runResult.success ? TERMINAL_RUN_LOG_CODES.completed : TERMINAL_RUN_LOG_CODES.failed,
    );

    if (runResult.success) {
      this.notifier.success('脚本执行完成。');
    } else {
      this.notifier.error('脚本执行失败，请检查终端输出。');
    }
  }
}

let terminalRunOrchestrator: TerminalRunOrchestrator | null = null;

export const getTerminalRunOrchestrator = (): TerminalRunOrchestrator => {
  if (!terminalRunOrchestrator) {
    terminalRunOrchestrator = new TerminalRunOrchestrator();
  }
  return terminalRunOrchestrator;
};

export const __resetTerminalRunOrchestratorForTesting = (): void => {
  terminalRunOrchestrator?.dispose();
  terminalRunOrchestrator = null;
};
