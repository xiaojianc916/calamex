import type { IRunLogEntry, IRunResult, TExecutorKind } from '@/types/editor';
import { formatTime } from '@/utils/core/date';
import {
  formatFileSystemTextForDisplay,
  getPathBaseName,
  getRelativeFileSystemPath,
} from '@/utils/file/path';
import {
  isTerminalRunCompletedLog,
  isTerminalRunDispatchedLog,
  isTerminalRunFailedLog,
  isTerminalRunFinalLog,
  isTerminalRunFlowLog,
  isTerminalRunStartLog,
  isTerminalRunTimeoutLog,
  resolveTerminalRunLogKind,
  TERMINAL_RUN_LOG_TITLES,
} from '@/utils/terminal/terminal-run';

export type TInsightTone = 'neutral' | 'success' | 'warning' | 'error' | 'running';
export type TInsightStepStatus = 'done' | 'running' | 'warning' | 'error';
export type TInsightAccent = 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue';
export type TInsightDetailTone = 'default' | 'success' | 'warning' | 'error' | 'muted';

export interface IStructuredRunDetailLine {
  text: string;
  tone: TInsightDetailTone;
}

export interface IStructuredRunSession {
  pathPrefix: string;
  fileLabel: string;
  meta: string;
}

export interface IStructuredRunSummary {
  tone: TInsightTone;
  statusLabel: string;
  phaseLabel: string;
  elapsedLabel: string;
  progress: number;
  counts: {
    success: number;
    warning: number;
    error: number;
    running: number;
  };
}

export interface IStructuredRunTimelineItem {
  id: string;
  tag: string;
  accent: TInsightAccent;
  title: string;
  description: string;
  status: TInsightStepStatus;
  timestamp: string;
  detailsLabel?: string;
  details?: IStructuredRunDetailLine[];
  gapWeight: number;
}

export interface IStructuredRunReport {
  hasContent: boolean;
  source: 'structured' | 'fallback';
  fallbackReason?: string;
  session: IStructuredRunSession;
  summary: IStructuredRunSummary;
  timeline: IStructuredRunTimelineItem[];
}

type TBuildStructuredRunReportOptions = {
  terminalOutput: string;
  runLogs: IRunLogEntry[];
  lastRunResult: IRunResult | null;
  isRunning: boolean;
  executor: TExecutorKind;
  documentName: string;
  documentPath: string | null;
  workspaceRootPath: string | null;
};

type TInternalTimelineItem = Omit<IStructuredRunTimelineItem, 'gapWeight'> & {
  createdAtMs: number | null;
};

const RUN_START_MARKER = '[sh-editor] Running current script...';
const EXIT_CODE_PATTERN = /\[sh-editor\]\s*Exit code:\s*(-?\d+)/i;
const EXIT_CODE_LINE_PATTERN = /\[sh-editor\]\s*Exit code:\s*-?\d+/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 剥离 ANSI 转义序列必须匹配 ESC(\u001b)/BEL(\u0007) 控制字符
const ANSI_PATTERN = /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\u0007|\u001b\\))/g;
const STEP_LINE_PATTERN = /^(?:\[\s*step\s*\]|\[\s*\d+\/\d+\s*\]|step\s*\d+|==>|->)/i;
const COMMAND_PROMPT_PATTERN = /^[\w.-]+@[\w.-]+:.*[$#]\s+/;
const PROMPT_ONLY_PATTERN = /^[\w.-]+@[\w.-]+:.*[$#]\s*$/;
const CONTINUATION_PROMPT_PATTERN = /^[\w.-]*>\s*/;
const HEREDOC_START_PATTERN = /cat\s+<<'SH_EDITOR_EOF_\d+'/i;
const HEREDOC_END_PATTERN = /^__SH_EDITOR_EOF_\d+__$/;
const TEMP_SCRIPT_PATTERN = /\/tmp\/[\w.-]+\.tmp\.sh/i;
const INTERNAL_SCRIPT_PATTERN = /__sh_editor_status|unset\s+__sh_editor_status/i;
const WARNING_PATTERN = /warning|warn|deprecated|注意|提醒/i;
const ERROR_PATTERN =
  /error|failed|failure|denied|not found|no such file|syntax|traceback|exception|未找到|失败|错误|异常/i;

const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, '');

const normalizeOutput = (value: string): string =>
  stripAnsi(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const parseExitCodeFromOutput = (output: string): number | null => {
  const matched = output.match(EXIT_CODE_PATTERN);
  return matched ? Number(matched[1]) : null;
};

const sortLogsAscending = (runLogs: IRunLogEntry[]): IRunLogEntry[] =>
  // Schwartzian transform（装饰-排序-还原）：每条日志只解析一次时间戳，避免比较器
  // 里反复 new Date().getTime()。该排序会随终端输出刷新被高频调用，把 Date 解析从
  // O(n log n) 次降到 O(n) 次。首个 .map 已生成新数组，排序不会改动入参顺序。
  runLogs
    .map((entry) => ({ entry, sortKey: new Date(entry.createdAt).getTime() }))
    .sort((left, right) => left.sortKey - right.sortKey)
    .map((decorated) => decorated.entry);

const parseTimestamp = (value: string | null | undefined): number | null => {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
};

const formatElapsed = (durationMs: number | null): string => {
  if (durationMs === null || durationMs < 0) {
    return '—';
  }

  const totalSeconds = durationMs / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(1).padStart(4, '0');
  return `${String(minutes).padStart(2, '0')}:${seconds}s`;
};

const resolveTimelineStatus = (value: string): TInsightStepStatus => {
  if (ERROR_PATTERN.test(value)) {
    return 'error';
  }

  if (WARNING_PATTERN.test(value)) {
    return 'warning';
  }

  return 'done';
};

const resolveDetailTone = (value: string): TInsightDetailTone => {
  if (ERROR_PATTERN.test(value)) {
    return 'error';
  }

  if (WARNING_PATTERN.test(value)) {
    return 'warning';
  }

  if (/^(?:✓|✔|ok\b|success\b|完成|已完成)/i.test(value)) {
    return 'success';
  }

  if (/^(?:\$|\[sh-editor\]|#\s+(?:stdout|stderr))/i.test(value)) {
    return 'muted';
  }

  return 'default';
};

const buildDetailLines = (lines: string[]): IStructuredRunDetailLine[] =>
  lines
    .map((line) => formatFileSystemTextForDisplay(line).trim())
    .filter(Boolean)
    .slice(-8)
    .map((line) => ({
      text: line,
      tone: resolveDetailTone(line),
    }));

const resolveShellName = (commandLine: string | null): string | null => {
  if (!commandLine) {
    return null;
  }

  const normalizedCommandLine = commandLine.trim();
  if (!normalizedCommandLine) {
    return null;
  }

  const firstToken = normalizedCommandLine.split(/\s+/)[0] ?? '';
  if (!firstToken) {
    return null;
  }

  return (
    firstToken
      .split('/')
      .pop()
      ?.replace(/\.exe$/i, '') ?? null
  );
};

const resolveCommandLine = (
  lastRunResult: IRunResult | null,
  runLogs: IRunLogEntry[],
): string | null => {
  if (lastRunResult?.commandLine) {
    return lastRunResult.commandLine;
  }

  for (let index = runLogs.length - 1; index >= 0; index -= 1) {
    if (isTerminalRunDispatchedLog(runLogs[index])) {
      return runLogs[index].detail;
    }
  }

  return null;
};

const resolveSession = (
  documentName: string,
  documentPath: string | null,
  workspaceRootPath: string | null,
  lastRunResult: IRunResult | null,
  runLogs: IRunLogEntry[],
  executor: TExecutorKind,
): IStructuredRunSession => {
  const workspaceLabel = getPathBaseName(workspaceRootPath) || '未打开工作区';
  const fallbackFileLabel = documentName.trim() || getPathBaseName(documentPath) || '未选择文件';
  const relativePath = getRelativeFileSystemPath(documentPath, workspaceRootPath);
  const relativeSegments = relativePath ? relativePath.split('/').filter(Boolean) : [];

  if (relativeSegments.length === 0) {
    relativeSegments.push(fallbackFileLabel);
  } else {
    relativeSegments[relativeSegments.length - 1] = fallbackFileLabel;
  }

  const fileLabel = relativeSegments[relativeSegments.length - 1] ?? fallbackFileLabel;
  const pathPrefix = [workspaceLabel, ...relativeSegments.slice(0, -1)].join(' / ');
  const executorLabel = lastRunResult?.executorLabel ?? executor.toUpperCase();
  const shellName = resolveShellName(resolveCommandLine(lastRunResult, runLogs)) ?? 'terminal';

  return {
    pathPrefix,
    fileLabel,
    meta: `${executorLabel} · ${shellName}`,
  };
};

const resolveTargetRunId = (
  lastRunResult: IRunResult | null,
  runFlowLogs: IRunLogEntry[],
): string | null => {
  if (lastRunResult?.runId) {
    return lastRunResult.runId;
  }

  for (let index = runFlowLogs.length - 1; index >= 0; index -= 1) {
    const item = runFlowLogs[index];
    if (item.runId) {
      return item.runId;
    }
  }

  return null;
};

const resolveScopedRunLogs = (
  orderedLogs: IRunLogEntry[],
  runFlowLogs: IRunLogEntry[],
  lastRunResult: IRunResult | null,
): IRunLogEntry[] => {
  if (runFlowLogs.length === 0) {
    return [];
  }

  const targetRunId = resolveTargetRunId(lastRunResult, runFlowLogs);
  if (targetRunId) {
    const scopedByRunId = runFlowLogs.filter((item) => item.runId === targetRunId);
    if (scopedByRunId.length > 0) {
      return scopedByRunId;
    }
  }

  let startIndex = -1;
  for (let index = orderedLogs.length - 1; index >= 0; index -= 1) {
    if (isTerminalRunStartLog(orderedLogs[index])) {
      startIndex = index;
      break;
    }
  }

  if (startIndex === -1) {
    for (let index = orderedLogs.length - 1; index >= 0; index -= 1) {
      if (isTerminalRunDispatchedLog(orderedLogs[index])) {
        startIndex = index;
        break;
      }
    }
  }

  if (startIndex === -1) {
    return runFlowLogs.slice(Math.max(0, runFlowLogs.length - 6));
  }

  const scopedLogs = orderedLogs.slice(startIndex).filter(isTerminalRunFlowLog);

  if (scopedLogs.length > 0) {
    return scopedLogs;
  }

  return runFlowLogs.slice(Math.max(0, runFlowLogs.length - 6));
};

const findLastRunMarkerIndex = (lines: string[]): number => {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].includes(RUN_START_MARKER)) {
      return index;
    }
  }

  return -1;
};

const extractCanonicalLine = (line: string): string => {
  if (line.includes(RUN_START_MARKER)) {
    return RUN_START_MARKER;
  }

  const exitLine = line.match(EXIT_CODE_LINE_PATTERN);
  if (exitLine) {
    return exitLine[0];
  }

  return line;
};

const shouldSkipLine = (
  line: string,
  inHeredoc: boolean,
): {
  skip: boolean;
  nextInHeredoc: boolean;
} => {
  if (inHeredoc) {
    if (HEREDOC_END_PATTERN.test(line)) {
      return { skip: true, nextInHeredoc: false };
    }
    return { skip: true, nextInHeredoc: true };
  }

  if (HEREDOC_START_PATTERN.test(line)) {
    return { skip: true, nextInHeredoc: true };
  }

  if (line.startsWith('# stdout') || line.startsWith('# stderr')) {
    return { skip: true, nextInHeredoc: false };
  }

  if (HEREDOC_END_PATTERN.test(line)) {
    return { skip: true, nextInHeredoc: false };
  }

  if (line.includes('SH_EDITOR_EOF_')) {
    return { skip: true, nextInHeredoc: false };
  }

  if (TEMP_SCRIPT_PATTERN.test(line) || INTERNAL_SCRIPT_PATTERN.test(line)) {
    return { skip: true, nextInHeredoc: false };
  }

  if (PROMPT_ONLY_PATTERN.test(line)) {
    return { skip: true, nextInHeredoc: false };
  }

  if (COMMAND_PROMPT_PATTERN.test(line) && line.includes('printf')) {
    return { skip: true, nextInHeredoc: false };
  }

  if (COMMAND_PROMPT_PATTERN.test(line) && line.includes('cat <<')) {
    return { skip: true, nextInHeredoc: false };
  }

  if (CONTINUATION_PROMPT_PATTERN.test(line)) {
    return { skip: true, nextInHeredoc: false };
  }

  return { skip: false, nextInHeredoc: false };
};

const sanitizeExecutionLines = (lines: string[]): string[] => {
  const sanitized: string[] = [];
  let inHeredoc = false;

  for (const originalLine of lines) {
    const trimmedLine = originalLine.trim();
    if (!trimmedLine) {
      continue;
    }

    const hasRunMarker = trimmedLine.includes(RUN_START_MARKER);
    const hasHeredocStart = HEREDOC_START_PATTERN.test(trimmedLine);
    if (hasRunMarker) {
      sanitized.push(RUN_START_MARKER);
      if (hasHeredocStart) {
        inHeredoc = true;
      }
      continue;
    }

    const canonicalLine = extractCanonicalLine(trimmedLine);

    if (EXIT_CODE_LINE_PATTERN.test(canonicalLine)) {
      sanitized.push(canonicalLine);
      continue;
    }

    const skipResult = shouldSkipLine(canonicalLine, inHeredoc);
    inHeredoc = skipResult.nextInHeredoc;
    if (skipResult.skip) {
      continue;
    }

    sanitized.push(canonicalLine);
  }

  return sanitized;
};

const isMetaOutputLine = (line: string): boolean =>
  line === RUN_START_MARKER || EXIT_CODE_LINE_PATTERN.test(line);

const collectExecutionOutputLines = (terminalOutput: string): string[] => {
  const normalizedOutput = normalizeOutput(terminalOutput);
  if (!normalizedOutput) {
    return [];
  }

  const allLines = normalizedOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const lastRunMarkerIndex = findLastRunMarkerIndex(allLines);
  const scopedLines = lastRunMarkerIndex >= 0 ? allLines.slice(lastRunMarkerIndex) : allLines;

  return sanitizeExecutionLines(scopedLines);
};

const collectStepLines = (outputLines: string[]): string[] =>
  outputLines
    .filter((line) => !isMetaOutputLine(line))
    .filter(
      (line) =>
        STEP_LINE_PATTERN.test(line) ||
        /(?:checking|build|deploy|upload|sync|compile|install|test|lint|done|完成|开始|执行|校验|部署|error|fail|hello)/i.test(
          line,
        ),
    )
    .slice(0, 5);

const resolveOutputTitle = (line: string): string => {
  const normalizedLine = line
    .replace(/^(?:\[\s*step\s*\]|\[\s*\d+\/\d+\s*\]|step\s*\d+\s*[:：.-]?|==>|->)\s*/i, '')
    .trim();

  if (!normalizedLine) {
    return '终端反馈';
  }

  return normalizedLine.length > 26 ? `${normalizedLine.slice(0, 26)}…` : normalizedLine;
};

const buildLogTimelineItem = (item: IRunLogEntry, outputLines: string[]): TInternalTimelineItem => {
  let tag = 'trace';
  let accent: TInsightAccent = 'yellow';
  let status: TInsightStepStatus = 'done';
  const kind = resolveTerminalRunLogKind(item);

  switch (kind) {
    case 'start':
      tag = 'start';
      accent = 'red';
      break;
    case 'temp-file':
      tag = 'load';
      accent = 'orange';
      status = 'warning';
      break;
    case 'dispatched':
      tag = 'exec';
      accent = 'teal';
      break;
    case 'completed':
      tag = 'done';
      accent = 'green';
      break;
    case 'failed':
    case 'timeout':
      tag = 'error';
      accent = 'red';
      status = 'error';
      break;
    default:
      if (item.level === 'error' || ERROR_PATTERN.test(item.title)) {
        tag = 'error';
        accent = 'red';
        status = 'error';
      } else if (WARNING_PATTERN.test(item.title)) {
        tag = 'warn';
        accent = 'yellow';
        status = 'warning';
      }
  }

  const detailLines = isTerminalRunDispatchedLog(item)
    ? buildDetailLines([item.detail])
    : isTerminalRunFinalLog(item)
      ? buildDetailLines(outputLines.length > 0 ? outputLines : [item.detail])
      : item.detail.includes('\n')
        ? buildDetailLines(item.detail.split('\n'))
        : [];

  return {
    id: item.id,
    tag,
    accent,
    title: item.title,
    description: item.detail,
    status,
    timestamp: formatTime(item.createdAt),
    detailsLabel:
      detailLines.length > 0
        ? isTerminalRunDispatchedLog(item)
          ? '查看命令'
          : '查看输出'
        : undefined,
    details: detailLines.length > 0 ? detailLines : undefined,
    createdAtMs: parseTimestamp(item.createdAt),
  };
};

const buildOutputTimelineItems = (
  outputLines: string[],
  isRunning: boolean,
): TInternalTimelineItem[] =>
  collectStepLines(outputLines).map((line, index) => {
    const status = resolveTimelineStatus(line);

    return {
      id: `output-step-${index}`,
      tag: 'check',
      accent: status === 'error' ? 'red' : 'yellow',
      title: resolveOutputTitle(line),
      description: line,
      status: status === 'done' && isRunning ? 'running' : status,
      timestamp: '实时',
      createdAtMs: null,
    };
  });

const buildSyntheticOutcomeItem = (
  lastRunResult: IRunResult | null,
  exitCodeFromOutput: number | null,
  outputLines: string[],
): TInternalTimelineItem | null => {
  if (lastRunResult) {
    const exitCode =
      typeof lastRunResult.exitCode === 'number' ? lastRunResult.exitCode : exitCodeFromOutput;
    const detailLines =
      outputLines.length > 0
        ? buildDetailLines(outputLines)
        : lastRunResult.commandLine
          ? buildDetailLines([lastRunResult.commandLine])
          : [];

    return {
      id: `synthetic-outcome-${lastRunResult.finishedAt}`,
      tag: lastRunResult.success ? 'done' : 'error',
      accent: lastRunResult.success ? 'green' : 'red',
      title: lastRunResult.success
        ? TERMINAL_RUN_LOG_TITLES.completed
        : TERMINAL_RUN_LOG_TITLES.failed,
      description: `执行器：${lastRunResult.executorLabel}，退出码：${exitCode ?? '未知'}，耗时：${lastRunResult.durationMs}ms。`,
      status: lastRunResult.success ? 'done' : 'error',
      timestamp: formatTime(lastRunResult.finishedAt),
      detailsLabel:
        detailLines.length > 0 ? (outputLines.length > 0 ? '查看输出' : '查看命令') : undefined,
      details: detailLines.length > 0 ? detailLines : undefined,
      createdAtMs: parseTimestamp(lastRunResult.finishedAt),
    };
  }

  if (exitCodeFromOutput === null) {
    return null;
  }

  const isSuccess = exitCodeFromOutput === 0;
  return {
    id: `synthetic-outcome-${exitCodeFromOutput}`,
    tag: isSuccess ? 'done' : 'error',
    accent: isSuccess ? 'green' : 'red',
    title: isSuccess ? '终端执行完成' : '终端执行异常结束',
    description: isSuccess
      ? '已从终端输出中识别到脚本结束状态。'
      : `终端返回非零退出码 ${exitCodeFromOutput}，请继续检查输出。`,
    status: isSuccess ? 'done' : 'error',
    timestamp: '实时',
    detailsLabel: outputLines.length > 0 ? '查看输出' : undefined,
    details: outputLines.length > 0 ? buildDetailLines(outputLines) : undefined,
    createdAtMs: null,
  };
};

const buildRunningTimelineItem = (outputLines: string[]): TInternalTimelineItem => {
  let latestOutputLine: string | undefined;
  for (let index = outputLines.length - 1; index >= 0; index -= 1) {
    const line = outputLines[index];
    if (line !== undefined && !isMetaOutputLine(line)) {
      latestOutputLine = line;
      break;
    }
  }

  return {
    id: 'running-now',
    tag: 'running',
    accent: 'blue',
    title: latestOutputLine ? resolveOutputTitle(latestOutputLine) : '正在等待更多终端输出…',
    description: latestOutputLine
      ? `最新终端反馈：${latestOutputLine}`
      : '脚本命令已发往集成终端，正在等待退出状态。',
    status: 'running',
    timestamp: '实时',
    detailsLabel: outputLines.length > 0 ? '查看输出' : undefined,
    details: outputLines.length > 0 ? buildDetailLines(outputLines) : undefined,
    createdAtMs: null,
  };
};

const assignGapWeights = (items: TInternalTimelineItem[]): IStructuredRunTimelineItem[] =>
  items.map((item, index) => {
    const nextItem = items[index + 1];
    let gapWeight = 1;

    if (nextItem !== undefined && item.createdAtMs !== null && nextItem.createdAtMs !== null) {
      const diffMs = Math.max(0, nextItem.createdAtMs - item.createdAtMs);
      gapWeight = diffMs >= 3000 ? 3 : diffMs >= 1200 ? 2 : 1;
    }

    return {
      id: item.id,
      tag: item.tag,
      accent: item.accent,
      title: item.title,
      description: item.description,
      status: item.status,
      timestamp: item.timestamp,
      detailsLabel: item.detailsLabel,
      details: item.details,
      gapWeight,
    };
  });

const buildTimeline = (
  runLogs: IRunLogEntry[],
  outputLines: string[],
  lastRunResult: IRunResult | null,
  exitCodeFromOutput: number | null,
  isRunning: boolean,
): IStructuredRunTimelineItem[] => {
  const primaryLogItems: TInternalTimelineItem[] = [];
  const finalLogItems: TInternalTimelineItem[] = [];
  const scopedRunLogs = lastRunResult
    ? runLogs.filter((item) => {
        if (!isTerminalRunFinalLog(item)) {
          return true;
        }

        return lastRunResult.success
          ? isTerminalRunCompletedLog(item)
          : isTerminalRunFailedLog(item) || isTerminalRunTimeoutLog(item);
      })
    : runLogs;

  for (const item of scopedRunLogs) {
    const timelineItem = buildLogTimelineItem(item, outputLines);
    if (isTerminalRunFinalLog(item)) {
      finalLogItems.push(timelineItem);
    } else {
      primaryLogItems.push(timelineItem);
    }
  }

  const timelineItems: TInternalTimelineItem[] = [
    ...primaryLogItems,
    ...buildOutputTimelineItems(outputLines, isRunning),
    ...finalLogItems,
  ];

  const syntheticOutcomeItem = buildSyntheticOutcomeItem(
    lastRunResult,
    exitCodeFromOutput,
    outputLines,
  );
  if (syntheticOutcomeItem && finalLogItems.length === 0) {
    timelineItems.push(syntheticOutcomeItem);
  }

  if (isRunning) {
    timelineItems.push(buildRunningTimelineItem(outputLines));
  }

  return assignGapWeights(timelineItems);
};

const resolveElapsedMs = (
  lastRunResult: IRunResult | null,
  scopedRunLogs: IRunLogEntry[],
  isRunning: boolean,
): number | null => {
  if (typeof lastRunResult?.durationMs === 'number' && lastRunResult.durationMs > 0) {
    return lastRunResult.durationMs;
  }

  const startedAtMs =
    parseTimestamp(lastRunResult?.startedAt) ?? parseTimestamp(scopedRunLogs[0]?.createdAt);
  if (startedAtMs === null) {
    return null;
  }

  if (isRunning) {
    return Math.max(0, Date.now() - startedAtMs);
  }

  const finishedAtMs =
    parseTimestamp(lastRunResult?.finishedAt) ??
    parseTimestamp(scopedRunLogs[scopedRunLogs.length - 1]?.createdAt);
  if (finishedAtMs === null) {
    return null;
  }

  return Math.max(0, finishedAtMs - startedAtMs);
};

const resolveSummaryTone = (
  isRunning: boolean,
  lastRunResult: IRunResult | null,
  exitCodeFromOutput: number | null,
  counts: IStructuredRunSummary['counts'],
): TInsightTone => {
  if (isRunning || counts.running > 0) {
    return 'running';
  }

  if (lastRunResult) {
    return lastRunResult.success ? 'success' : 'error';
  }

  if (exitCodeFromOutput !== null) {
    return exitCodeFromOutput === 0 ? 'success' : 'error';
  }

  if (counts.error > 0) {
    return 'error';
  }

  if (counts.warning > 0) {
    return 'warning';
  }

  if (lastRunResult?.success || exitCodeFromOutput === 0 || counts.success > 0) {
    return 'success';
  }

  return 'neutral';
};

const buildSummary = (
  timeline: IStructuredRunTimelineItem[],
  scopedRunLogs: IRunLogEntry[],
  lastRunResult: IRunResult | null,
  exitCodeFromOutput: number | null,
  isRunning: boolean,
): IStructuredRunSummary => {
  const counts = timeline.reduce(
    (accumulator, item) => {
      if (item.status === 'done') {
        accumulator.success += 1;
      } else if (item.status === 'warning') {
        accumulator.warning += 1;
      } else if (item.status === 'error') {
        accumulator.error += 1;
      } else {
        accumulator.running += 1;
      }

      return accumulator;
    },
    {
      success: 0,
      warning: 0,
      error: 0,
      running: 0,
    },
  );

  const tone = resolveSummaryTone(isRunning, lastRunResult, exitCodeFromOutput, counts);
  const totalSteps = timeline.length;
  const weightedCompletedSteps =
    counts.success + counts.warning + counts.error + (counts.running > 0 ? 0.35 : 0);
  const progress =
    totalSteps === 0
      ? 0
      : tone === 'success' || tone === 'warning' || tone === 'error'
        ? 100
        : Math.max(12, Math.min(92, Math.round((weightedCompletedSteps / totalSteps) * 100)));

  return {
    tone,
    statusLabel:
      tone === 'running'
        ? '运行中'
        : tone === 'error'
          ? '执行异常'
          : tone === 'warning'
            ? '已完成'
            : tone === 'success'
              ? '已完成'
              : '待执行',
    phaseLabel:
      totalSteps === 0
        ? '等待运行'
        : isRunning
          ? `第 ${totalSteps} 步，共 ${totalSteps} 步`
          : `共 ${totalSteps} 步`,
    elapsedLabel: formatElapsed(resolveElapsedMs(lastRunResult, scopedRunLogs, isRunning)),
    progress,
    counts,
  };
};

export const buildStructuredRunReport = ({
  terminalOutput,
  runLogs,
  lastRunResult,
  isRunning,
  executor,
  documentName,
  documentPath,
  workspaceRootPath,
}: TBuildStructuredRunReportOptions): IStructuredRunReport => {
  const sourceRunLogs = Array.isArray(runLogs) ? runLogs : [];
  const orderedLogs = sortLogsAscending(sourceRunLogs);
  const rawRunFlowLogs = orderedLogs.filter(isTerminalRunFlowLog);
  const safeRunLogs = resolveScopedRunLogs(orderedLogs, rawRunFlowLogs, lastRunResult);
  const safeOutput = typeof terminalOutput === 'string' ? terminalOutput : '';
  const outputLines = collectExecutionOutputLines(safeOutput);
  const exitCodeFromOutput = parseExitCodeFromOutput(outputLines.join('\n'));
  const timeline = buildTimeline(
    safeRunLogs,
    outputLines,
    lastRunResult,
    exitCodeFromOutput,
    isRunning,
  );

  return {
    hasContent:
      safeRunLogs.length > 0 ||
      rawRunFlowLogs.length > 0 ||
      outputLines.length > 0 ||
      Boolean(lastRunResult) ||
      Boolean(isRunning),
    source: 'structured',
    session: resolveSession(
      documentName,
      documentPath,
      workspaceRootPath,
      lastRunResult,
      safeRunLogs,
      executor,
    ),
    summary: buildSummary(timeline, safeRunLogs, lastRunResult, exitCodeFromOutput, isRunning),
    timeline,
  };
};
