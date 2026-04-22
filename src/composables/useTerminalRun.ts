import { useMessage } from '@/composables/useMessage';
import { tauriService } from '@/services/tauri';
import type { useEditorStore } from '@/store/editor';
import type { IEditorDocument, IRunResult, TRunHistoryStatus } from '@/types/editor';
import {
    DEFAULT_TERMINAL_SESSION_ID,
    type ITerminalRunCompletePayload,
    type ITerminalRunOutputEvent,
} from '@/types/terminal';
import { toErrorMessage } from '@/utils/error';
import { DEFAULT_EXECUTOR, getExecutorLabel } from '@/utils/templates';
import { onScopeDispose, type ComputedRef } from 'vue';

const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 28;
const TERMINAL_OUTPUT_BATCH_INTERVAL_MS = 120;
const TERMINAL_RUN_COMPLETION_TIMEOUT_MS = 30 * 60 * 1000;

type TEditorStore = ReturnType<typeof useEditorStore>;

type TActiveTerminalRunMeta = {
    runId: string;
    startedAt: string;
    commandLine: string;
    usedTempFile: boolean;
};

type TUseTerminalRunOptions = {
    canRun: ComputedRef<boolean>;
    editorStore: TEditorStore;
};

const resolveRunHistoryStatus = (exitCode: number | null): TRunHistoryStatus => {
    if (exitCode === 0) {
        return 'success';
    }

    if (exitCode === null || exitCode === -1 || exitCode === 130) {
        return 'canceled';
    }

    return 'failed';
};

const isTextDocument = (document: IEditorDocument): boolean => document.kind === 'text';

export const useTerminalRun = ({
    canRun,
    editorStore,
}: TUseTerminalRunOptions) => {
    let bufferedTerminalOutput = '';
    let bufferedTerminalOutputTimerId: number | null = null;
    let terminalRunFallbackTimerId: number | null = null;
    let isDisposed = false;
    let activeTerminalRunMeta: TActiveTerminalRunMeta | null = null;

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

        if (!bufferedTerminalOutput) {
            return;
        }

        if (isDisposed) {
            bufferedTerminalOutput = '';
            return;
        }

        editorStore.appendTerminalOutput(bufferedTerminalOutput);
        bufferedTerminalOutput = '';
    };

    const resetBufferedTerminalOutput = (): void => {
        clearBufferedTerminalOutputTimer();
        bufferedTerminalOutput = '';
    };

    const scheduleTerminalRunCompletionTimeout = (runId: string): void => {
        clearTerminalRunFallbackTimer();
        terminalRunFallbackTimerId = window.setTimeout(() => {
            terminalRunFallbackTimerId = null;

            if (isDisposed || editorStore.pendingTerminalRunId !== runId) {
                return;
            }

            resetBufferedTerminalOutput();
            editorStore.isRunning = false;
            editorStore.setPendingTerminalRunId(null);
            editorStore.setActiveRunSummary(null);
            activeTerminalRunMeta = null;

            const message = '终端运行超时，已停止等待完成事件，请检查终端状态。';
            editorStore.appendLog('error', '终端运行超时', message);
            useMessage().error(message);
        }, TERMINAL_RUN_COMPLETION_TIMEOUT_MS);
    };

    const ensureIntegratedTerminalSession = async (): Promise<void> => {
        await tauriService.ensureTerminalSession({
            sessionId: DEFAULT_TERMINAL_SESSION_ID,
            cwd: null,
            cols: DEFAULT_TERMINAL_COLS,
            rows: DEFAULT_TERMINAL_ROWS,
        });
    };

    const shouldReconnectIntegratedTerminal = (error: unknown): boolean => {
        const message = toErrorMessage(error, '');
        return message.includes('目标终端会话不存在');
    };

    const dispatchScriptToIntegratedTerminal = async (
        document: IEditorDocument,
        runId: string,
    ) => {
        try {
            return await tauriService.dispatchScriptToTerminal({
                sessionId: DEFAULT_TERMINAL_SESSION_ID,
                path: document.path,
                content: document.content,
                isDirty: document.isDirty,
                runId,
            });
        } catch (error) {
            if (!shouldReconnectIntegratedTerminal(error)) {
                throw error;
            }

            await ensureIntegratedTerminalSession();
            return tauriService.dispatchScriptToTerminal({
                sessionId: DEFAULT_TERMINAL_SESSION_ID,
                path: document.path,
                content: document.content,
                isDirty: document.isDirty,
                runId,
            });
        }
    };

    const runScriptInIntegratedTerminal = async (document: IEditorDocument): Promise<void> => {
        if (!isTextDocument(document)) {
            throw new Error('当前文档不是可执行脚本文本。');
        }

        const runId = `terminal-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const startedAt = new Date().toISOString();
        const initialUsedTempFile = document.isDirty || !document.path;

        editorStore.setPendingTerminalRunId(runId);
        editorStore.setActiveRunSummary({
            runId,
            documentName: document.name,
            documentPath: document.path,
            commandLine: '正在发送到集成终端…',
            executor: DEFAULT_EXECUTOR,
            executorLabel: getExecutorLabel(DEFAULT_EXECUTOR),
            startedAt,
            usedTempFile: initialUsedTempFile,
        });
        resetBufferedTerminalOutput();
        editorStore.lastRunResult = null;
        editorStore.setTerminalOutput('');
        activeTerminalRunMeta = {
            runId,
            startedAt,
            commandLine: 'bash',
            usedTempFile: initialUsedTempFile,
        };
        scheduleTerminalRunCompletionTimeout(runId);

        try {
            const dispatchResult = await dispatchScriptToIntegratedTerminal(document, runId);
            if (isDisposed) {
                return;
            }

            const currentPendingRunId = editorStore.pendingTerminalRunId;
            if (currentPendingRunId !== runId) {
                return;
            }

            activeTerminalRunMeta = {
                runId,
                startedAt: dispatchResult.startedAt,
                commandLine: dispatchResult.commandLine,
                usedTempFile: dispatchResult.usedTempFile,
            };
            editorStore.setActiveRunSummary({
                runId,
                documentName: document.name,
                documentPath: document.path,
                commandLine: dispatchResult.commandLine,
                executor: DEFAULT_EXECUTOR,
                executorLabel: getExecutorLabel(DEFAULT_EXECUTOR),
                startedAt: dispatchResult.startedAt,
                usedTempFile: dispatchResult.usedTempFile,
            });
            editorStore.appendLog('success', '已发送到集成终端', dispatchResult.commandLine);

            if (dispatchResult.usedTempFile) {
                editorStore.appendLog(
                    'info',
                    '临时脚本文件',
                    '当前内容已写入临时 shell 脚本文件后执行。',
                );
            }

            useMessage().success('脚本已发送到集成终端。');
        } catch (error) {
            if (isDisposed) {
                return;
            }

            const currentPendingRunId = editorStore.pendingTerminalRunId;
            const currentActiveRunId = activeTerminalRunMeta?.runId;
            if (currentPendingRunId !== runId && currentActiveRunId !== runId) {
                return;
            }

            resetBufferedTerminalOutput();
            clearTerminalRunFallbackTimer();
            editorStore.setPendingTerminalRunId(null);
            editorStore.setActiveRunSummary(null);
            activeTerminalRunMeta = null;
            editorStore.isRunning = false;

            const message = toErrorMessage(error, '脚本执行失败');
            editorStore.appendLog('error', '脚本执行失败', message);
            editorStore.setTerminalOutput(message);
            useMessage().error(message);
        }
    };

    const handleIntegratedTerminalRunComplete = (payload: ITerminalRunCompletePayload): void => {
        if (isDisposed) {
            return;
        }

        const pendingRunId = editorStore.pendingTerminalRunId;
        if (payload.runId !== pendingRunId && payload.runId !== activeTerminalRunMeta?.runId) {
            return;
        }

        const activeRun = activeTerminalRunMeta;
        const activeRunSummary = editorStore.activeRunSummary;

        editorStore.setPendingTerminalRunId(null);
        clearTerminalRunFallbackTimer();
        flushBufferedTerminalOutput();

        const safeOutput = editorStore.getTerminalOutputSnapshot();

        const durationMs = activeRun
            ? Math.max(
                0,
                new Date(payload.finishedAt).getTime() - new Date(activeRun.startedAt).getTime(),
            )
            : 0;

        const runResult: IRunResult = {
            success: payload.exitCode === 0,
            stdout: safeOutput,
            stderr: payload.exitCode === 0 ? '' : safeOutput,
            combinedOutput: safeOutput,
            exitCode: payload.exitCode,
            executor: 'wsl',
            executorLabel: getExecutorLabel('wsl'),
            durationMs,
            startedAt: activeRun?.startedAt ?? payload.finishedAt,
            finishedAt: payload.finishedAt,
            commandLine: activeRun?.commandLine ?? 'bash',
            logPath: null,
            usedTempFile: activeRun?.usedTempFile ?? false,
        };

        editorStore.lastRunResult = runResult;
        editorStore.appendRunHistory({
            status: resolveRunHistoryStatus(runResult.exitCode),
            documentName: activeRunSummary?.documentName ?? editorStore.document.name,
            documentPath: activeRunSummary?.documentPath ?? editorStore.document.path,
            commandLine: runResult.commandLine,
            executor: runResult.executor,
            executorLabel: runResult.executorLabel,
            startedAt: runResult.startedAt,
            finishedAt: runResult.finishedAt,
            durationMs: runResult.durationMs,
            exitCode: runResult.exitCode,
            usedTempFile: runResult.usedTempFile,
        });
        editorStore.isRunning = false;
        editorStore.setActiveRunSummary(null);
        activeTerminalRunMeta = null;

        editorStore.appendLog(
            runResult.success ? 'success' : 'error',
            runResult.success ? '执行完成' : '执行失败',
            `执行器：${runResult.executorLabel}，退出码：${runResult.exitCode ?? '未知'}，耗时：${runResult.durationMs}ms。`,
        );

        if (runResult.success) {
            useMessage().success('脚本执行完成。');
        } else {
            useMessage().error('脚本执行失败，请检查终端输出。');
        }
    };

    const runScript = async (): Promise<void> => {
        if (!canRun.value) {
            useMessage().warning(
                isTextDocument(editorStore.document)
                    ? '请先提供可执行脚本内容，并确认当前系统存在可用的 WSL2 运行环境。'
                    : '当前打开的是图片预览，无法直接执行。',
            );
            return;
        }

        const currentDocument = editorStore.document;
        if (!editorStore.environment.hasAny) {
            useMessage().error('当前系统不可用：WSL2。');
            return;
        }

        editorStore.isRunning = true;
        editorStore.appendLog(
            'info',
            '开始执行',
            `当前脚本将使用 ${getExecutorLabel(DEFAULT_EXECUTOR)} 执行。`,
        );

        try {
            await runScriptInIntegratedTerminal(currentDocument);
        } catch (error) {
            const message = toErrorMessage(error, '脚本执行失败');
            resetBufferedTerminalOutput();
            clearTerminalRunFallbackTimer();
            editorStore.setPendingTerminalRunId(null);
            editorStore.setActiveRunSummary(null);
            activeTerminalRunMeta = null;
            editorStore.isRunning = false;
            editorStore.appendLog('error', '脚本执行失败', message);
            editorStore.setTerminalOutput(message);
            useMessage().error(message);
        }
    };

    const appendTerminalOutput = (payload: ITerminalRunOutputEvent): void => {
        if (isDisposed || !payload.data) {
            return;
        }

        const pendingRunId = editorStore.pendingTerminalRunId;
        if (payload.runId !== pendingRunId && payload.runId !== activeTerminalRunMeta?.runId) {
            return;
        }

        bufferedTerminalOutput += payload.data;
        if (bufferedTerminalOutputTimerId !== null) {
            return;
        }

        bufferedTerminalOutputTimerId = window.setTimeout(() => {
            flushBufferedTerminalOutput();
        }, TERMINAL_OUTPUT_BATCH_INTERVAL_MS);
    };

    onScopeDispose(() => {
        isDisposed = true;
        resetBufferedTerminalOutput();
        clearTerminalRunFallbackTimer();
        editorStore.setActiveRunSummary(null);
        activeTerminalRunMeta = null;
    });

    return {
        runScript,
        appendTerminalOutput,
        handleIntegratedTerminalRunComplete,
    };
};