import type {
  IActiveRunSummary,
  IRunLogEntry,
  IRunHistoryEntry,
  IRunResult,
  TExecutorKind,
  TRunHistoryStatus,
} from '@/types/editor';
import { getExecutorLabel } from '@/utils/templates';

interface IRunDocumentRef {
  name: string;
  path: string | null;
}

export interface IActiveTerminalRunMeta {
  runId: string;
  startedAt: string;
  commandLine: string;
  usedTempFile: boolean;
}

interface IBuildRunSummaryOptions {
  runId: string;
  documentName: string;
  documentPath: string | null;
  commandLine: string;
  executor: TExecutorKind;
  startedAt: string;
  usedTempFile: boolean;
}

interface IBuildRunResultOptions {
  output: string;
  exitCode: number | null;
  finishedAt: string;
  executor: TExecutorKind;
  activeRunMeta: IActiveTerminalRunMeta | null;
  activeRunSummary: IActiveRunSummary | null;
}

export const TERMINAL_RUN_LOG_CODES = {
  start: 'terminal-run/start',
  dispatched: 'terminal-run/dispatched',
  tempFile: 'terminal-run/temp-file',
  completed: 'terminal-run/completed',
  failed: 'terminal-run/failed',
  timeout: 'terminal-run/timeout',
} as const;

export type TTerminalRunLogKind =
  | 'start'
  | 'dispatched'
  | 'temp-file'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'other';

export const TERMINAL_RUN_LOG_TITLES = {
  start: '开始执行',
  dispatched: '已发送到集成终端',
  tempFile: '临时脚本文件',
  completed: '执行完成',
  failed: '执行失败',
  timeout: '终端运行超时',
} as const;

export const createTerminalRunId = (): string =>
  `terminal-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const resolveRunHistoryStatus = (exitCode: number | null): TRunHistoryStatus => {
  if (exitCode === 0) {
    return 'success';
  }

  if (exitCode === null || exitCode === -1 || exitCode === 130) {
    return 'canceled';
  }

  return 'failed';
};

const buildRunSummary = ({
  runId,
  documentName,
  documentPath,
  commandLine,
  executor,
  startedAt,
  usedTempFile,
}: IBuildRunSummaryOptions): IActiveRunSummary => ({
  runId,
  documentName,
  documentPath,
  commandLine,
  executor,
  executorLabel: getExecutorLabel(executor),
  startedAt,
  usedTempFile,
});

export const buildPendingTerminalRunSummary = (
  document: IRunDocumentRef,
  runId: string,
  startedAt: string,
  executor: TExecutorKind,
  usedTempFile: boolean,
): IActiveRunSummary =>
  buildRunSummary({
    runId,
    documentName: document.name,
    documentPath: document.path,
    commandLine: '正在发送到集成终端…',
    executor,
    startedAt,
    usedTempFile,
  });

export const createActiveTerminalRunMeta = (
  runId: string,
  startedAt: string,
  commandLine: string,
  usedTempFile: boolean,
): IActiveTerminalRunMeta => ({
  runId,
  startedAt,
  commandLine,
  usedTempFile,
});

export const buildDispatchedTerminalRunSummary = (
  document: IRunDocumentRef,
  activeRunMeta: IActiveTerminalRunMeta,
  executor: TExecutorKind,
): IActiveRunSummary =>
  buildRunSummary({
    runId: activeRunMeta.runId,
    documentName: document.name,
    documentPath: document.path,
    commandLine: activeRunMeta.commandLine,
    executor,
    startedAt: activeRunMeta.startedAt,
    usedTempFile: activeRunMeta.usedTempFile,
  });

export const buildTerminalRunResult = ({
  output,
  exitCode,
  finishedAt,
  executor,
  activeRunMeta,
  activeRunSummary,
}: IBuildRunResultOptions): IRunResult => {
  const durationMs = activeRunMeta
    ? Math.max(0, new Date(finishedAt).getTime() - new Date(activeRunMeta.startedAt).getTime())
    : 0;

  return {
    runId: activeRunMeta?.runId ?? activeRunSummary?.runId ?? null,
    success: exitCode === 0,
    stdout: output,
    stderr: exitCode === 0 ? '' : output,
    combinedOutput: output,
    exitCode,
    executor,
    executorLabel: getExecutorLabel(executor),
    durationMs,
    startedAt: activeRunMeta?.startedAt ?? activeRunSummary?.startedAt ?? finishedAt,
    finishedAt,
    commandLine: activeRunMeta?.commandLine ?? activeRunSummary?.commandLine ?? 'bash',
    logPath: null,
    usedTempFile: activeRunMeta?.usedTempFile ?? activeRunSummary?.usedTempFile ?? false,
  };
};

const LEGACY_RUN_FLOW_LOG_TITLES = new Set([
  TERMINAL_RUN_LOG_TITLES.start,
  TERMINAL_RUN_LOG_TITLES.dispatched,
  TERMINAL_RUN_LOG_TITLES.tempFile,
  TERMINAL_RUN_LOG_TITLES.completed,
  TERMINAL_RUN_LOG_TITLES.failed,
  '终端执行状态异常',
  '脚本执行失败',
]);

const LEGACY_FINAL_RUN_LOG_TITLES = new Set([
  TERMINAL_RUN_LOG_TITLES.completed,
  TERMINAL_RUN_LOG_TITLES.failed,
  '终端执行状态异常',
  '脚本执行失败',
]);

const TERMINAL_RUN_LOG_CODE_SET = new Set<string>(Object.values(TERMINAL_RUN_LOG_CODES));
const TERMINAL_RUN_FINAL_LOG_CODE_SET = new Set<string>([
  TERMINAL_RUN_LOG_CODES.completed,
  TERMINAL_RUN_LOG_CODES.failed,
  TERMINAL_RUN_LOG_CODES.timeout,
]);

export const isTerminalRunStartLog = (
  item: Pick<IRunLogEntry, 'title' | 'code'>,
): boolean =>
  item.code === TERMINAL_RUN_LOG_CODES.start || item.title === TERMINAL_RUN_LOG_TITLES.start;

export const isTerminalRunDispatchedLog = (
  item: Pick<IRunLogEntry, 'title' | 'code'>,
): boolean =>
  item.code === TERMINAL_RUN_LOG_CODES.dispatched
  || item.title === TERMINAL_RUN_LOG_TITLES.dispatched;

const isTerminalRunTempFileLog = (
  item: Pick<IRunLogEntry, 'title' | 'code'>,
): boolean =>
  item.code === TERMINAL_RUN_LOG_CODES.tempFile
  || item.title === TERMINAL_RUN_LOG_TITLES.tempFile;

export const isTerminalRunCompletedLog = (
  item: Pick<IRunLogEntry, 'title' | 'code'>,
): boolean =>
  item.code === TERMINAL_RUN_LOG_CODES.completed
  || item.title === TERMINAL_RUN_LOG_TITLES.completed;

export const isTerminalRunTimeoutLog = (
  item: Pick<IRunLogEntry, 'title' | 'code'>,
): boolean =>
  item.code === TERMINAL_RUN_LOG_CODES.timeout
  || item.title === TERMINAL_RUN_LOG_TITLES.timeout;

export const isTerminalRunFailedLog = (
  item: Pick<IRunLogEntry, 'title' | 'code'>,
): boolean =>
  item.code === TERMINAL_RUN_LOG_CODES.failed
  || item.title === TERMINAL_RUN_LOG_TITLES.failed
  || item.title === '终端执行状态异常'
  || item.title === '脚本执行失败';

export const isTerminalRunFlowLog = (item: IRunLogEntry): boolean =>
  item.scope === 'run'
  || (typeof item.code === 'string' && TERMINAL_RUN_LOG_CODE_SET.has(item.code))
  || LEGACY_RUN_FLOW_LOG_TITLES.has(item.title);

export const isTerminalRunFinalLog = (item: IRunLogEntry): boolean =>
  (typeof item.code === 'string' && TERMINAL_RUN_FINAL_LOG_CODE_SET.has(item.code))
  || LEGACY_FINAL_RUN_LOG_TITLES.has(item.title);

export const resolveTerminalRunLogKind = (
  item: Pick<IRunLogEntry, 'title' | 'code'>,
): TTerminalRunLogKind => {
  if (isTerminalRunStartLog(item)) {
    return 'start';
  }

  if (isTerminalRunDispatchedLog(item)) {
    return 'dispatched';
  }

  if (isTerminalRunTempFileLog(item)) {
    return 'temp-file';
  }

  if (isTerminalRunCompletedLog(item)) {
    return 'completed';
  }

  if (isTerminalRunTimeoutLog(item)) {
    return 'timeout';
  }

  if (isTerminalRunFailedLog(item)) {
    return 'failed';
  }

  return 'other';
};

export const buildTerminalRunHistoryEntry = (
  runResult: IRunResult,
  activeRunSummary: IActiveRunSummary | null,
  fallbackDocument: IRunDocumentRef,
): Omit<IRunHistoryEntry, 'id'> => ({
  status: resolveRunHistoryStatus(runResult.exitCode),
  documentName: activeRunSummary?.documentName ?? fallbackDocument.name,
  documentPath: activeRunSummary?.documentPath ?? fallbackDocument.path,
  commandLine: runResult.commandLine,
  executor: runResult.executor,
  executorLabel: runResult.executorLabel,
  startedAt: runResult.startedAt,
  finishedAt: runResult.finishedAt,
  durationMs: runResult.durationMs,
  exitCode: runResult.exitCode,
  usedTempFile: runResult.usedTempFile,
});

export const buildTerminalRunCompletionDetail = (runResult: IRunResult): string =>
  `执行器：${runResult.executorLabel}，退出码：${runResult.exitCode ?? '未知'}，耗时：${runResult.durationMs}ms。`;
