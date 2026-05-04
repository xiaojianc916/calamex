<template>
  <section class="terminal-log-shell">
    <div class="terminal-log-header">
      <div class="terminal-log-run-indicator" :class="`tone-${summaryTone}`">
        <span class="terminal-log-run-pulse"></span>
        <span>{{ runIndicatorLabel }}</span>
      </div>

      <span class="terminal-log-run-path mono-text">{{ commandPreview }}</span>

      <div class="terminal-log-header-spacer" />

      <div class="terminal-log-env-badge mono-text">
        <span>{{ environmentParts[0] }}</span>
        <span class="terminal-log-env-sep">·</span>
        <span>{{ environmentParts[1] }}</span>
      </div>

      <div v-if="isFallbackReportActive" class="terminal-log-fallback-badge" :title="fallbackBadgeTitle">
        基础视图
      </div>

      <div class="terminal-log-header-actions">
        <button
type="button" class="icon-button app-tooltip-target terminal-log-icon-button"
          :class="{ 'is-selected': isAutoScrollEnabled }" :data-tooltip="isAutoScrollEnabled ? '关闭自动滚动' : '开启自动滚动'"
          data-tooltip-placement="top" :aria-label="isAutoScrollEnabled ? '关闭自动滚动' : '开启自动滚动'"
          @click="isAutoScrollEnabled = !isAutoScrollEnabled">
          <svg
viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="15" />
            <polyline points="7 13 12 18 17 13" />
            <line x1="5" y1="20" x2="19" y2="20" />
          </svg>
        </button>

        <button
type="button" class="icon-button app-tooltip-target terminal-log-icon-button" data-tooltip="复制全部输出"
          data-tooltip-placement="top" aria-label="复制全部输出" :disabled="!hasCopyableOutput"
          @click="void handleCopyAllOutput()">
          <svg
viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>

        <button
type="button" class="icon-button app-tooltip-target terminal-log-icon-button" data-tooltip="清空日志"
          data-tooltip-placement="top" aria-label="清空日志" :disabled="!displayedReport.hasContent"
          @click="handleClearLogs">
          <svg
viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18" />
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          </svg>
        </button>
      </div>
    </div>

    <div class="terminal-log-meta">
      <div class="terminal-log-meta-item">
        <span class="terminal-log-meta-value">{{ stepProgress.current }}</span>/ {{ stepProgress.total }} 步
      </div>
      <span class="terminal-log-meta-sep">·</span>
      <div class="terminal-log-meta-item is-success">
        <span class="terminal-log-meta-value">{{ displayedReport.summary.counts.success }}</span>成功
      </div>
      <div class="terminal-log-meta-item is-warning">
        <span class="terminal-log-meta-value">{{ displayedReport.summary.counts.warning }}</span>警告
      </div>
      <div class="terminal-log-meta-item is-error">
        <span class="terminal-log-meta-value">{{ displayedReport.summary.counts.error }}</span>错误
      </div>
      <div class="terminal-log-meta-item is-running">
        <span class="terminal-log-meta-value">{{ displayedReport.summary.counts.running }}</span>进行中
      </div>
      <div class="terminal-log-header-spacer" />
      <div class="terminal-log-elapsed mono-text">
        {{ elapsedLabel }}
        <span class="terminal-log-elapsed-label">已耗时</span>
      </div>
    </div>

    <div class="terminal-log-progress-track" aria-hidden="true">
      <div
class="terminal-log-progress-fill" :class="{ 'is-live': summaryTone === 'running' }"
        :style="{ width: `${displayedReport.summary.progress}%` }" />
    </div>

    <div ref="timelineRef" class="terminal-log-timeline">
      <div v-if="displayedReport.hasContent" class="terminal-log-timeline-list">
        <article
v-for="(item, index) in displayedReport.timeline" :key="item.id" class="terminal-log-event-row" :style="{
          '--terminal-log-gap': String(item.gapWeight),
          '--terminal-log-index': String(index),
        }">
          <div class="terminal-log-event-icon" :class="`is-${resolveEventTone(item)}`">
            <span class="terminal-log-event-dot"></span>
          </div>

          <div class="terminal-log-event-time" :class="{ 'is-live': item.status === 'running' }">
            {{ item.timestamp }}
          </div>

          <div class="terminal-log-event-kind" :class="`is-${resolveKindTone(item)}`">
            {{ resolveKindLabel(item) }}
          </div>

          <div class="terminal-log-event-body">
            <div class="terminal-log-event-title">{{ item.title }}</div>
            <div class="terminal-log-event-desc">{{ item.description }}</div>

            <code v-if="resolveInlineCode(item)" class="terminal-log-event-code">
              {{ resolveInlineCode(item) }}
            </code>

            <button
v-if="resolveOutputLines(item).length" type="button" class="terminal-log-event-toggle"
              :class="{ 'is-expanded': isExpanded(item.id) }" @click="toggleExpanded(item.id)">
              <svg
class="terminal-log-event-chevron" viewBox="0 0 24 24" aria-hidden="true" fill="none"
                stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="9 6 15 12 9 18" />
              </svg>
              {{ resolveToggleLabel(item) }}
            </button>

            <div class="terminal-log-event-output" :class="{ 'is-expanded': isExpanded(item.id) }">
              <pre v-if="resolveOutputLines(item).length"><span
                v-for="(detail, detailIndex) in resolveOutputLines(item)"
                :key="`${item.id}-${detailIndex}-${detail.text}`"
                class="terminal-log-output-line"
                :class="`is-${detail.tone}`"
              >{{ detail.text }}
</span></pre>
            </div>
          </div>
        </article>
      </div>

      <div v-else class="terminal-log-empty-state">
        <p class="terminal-log-empty-title">暂无运行日志</p>
        <p class="terminal-log-empty-text">
          运行脚本后，这里会整理为时间线视图，展示执行状态、阶段节点和可展开输出。
        </p>
      </div>
    </div>

    <footer class="terminal-log-footer" :class="{ 'is-disabled': !props.isTerminalReady }">
      <span class="terminal-log-prompt mono-text">&gt;</span>
      <input
v-model="commandInput" class="terminal-log-command-input mono-text" type="text"
        :disabled="!props.isTerminalReady" placeholder="输入命令，按 Enter 发送到终端" autocomplete="off" spellcheck="false"
        @keydown.enter.prevent="submitCommand">
    </footer>
  </section>
</template>

<script setup lang="ts">
import { useMessage } from '@/composables/useMessage';
import type { IRunLogEntry, IRunResult, TExecutorKind } from '@/types/editor';
import { writeClipboardText } from '@/utils/clipboard';
import { formatTime } from '@/utils/date';
import { toErrorMessage } from '@/utils/error';
import { formatFileSystemPathForDisplay } from '@/utils/path';
import {
  buildStructuredRunReport,
  type IStructuredRunDetailLine,
  type IStructuredRunReport,
  type IStructuredRunTimelineItem,
} from '@/utils/structured-run-report';
import {
  isTerminalRunDispatchedLog,
  isTerminalRunFlowLog,
  isTerminalRunStartLog,
  resolveTerminalRunLogKind,
} from '@/utils/terminal-run';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

const MAX_REPORT_CACHE_ENTRIES = 8;
const REPORT_REBUILD_DELAY_MS = 240;
const FALLBACK_BUILD_ERROR_REASON = '结构化日志构建失败，已切换到基础日志视图。';
const FALLBACK_EMPTY_WITH_SIGNALS_REASON = '结构化日志未产出结果，但检测到了原始运行信号，已切换到基础日志视图。';

const props = defineProps<{
  active: boolean;
  terminalOutputLength: number;
  terminalOutputVersion: number;
  resolveTerminalOutput: () => string;
  runLogs: IRunLogEntry[];
  lastRunResult: IRunResult | null;
  isRunning: boolean;
  executor: TExecutorKind;
  documentName: string;
  documentPath: string | null;
  workspaceRootPath: string | null;
  isTerminalReady: boolean;
}>();

const emit = defineEmits<{
  clear: [];
  'submit-command': [command: string];
}>();

const message = useMessage();
const commandInput = ref('');
const timelineRef = ref<HTMLElement | null>(null);
const isAutoScrollEnabled = ref(true);

const EMPTY_REPORT: IStructuredRunReport = {
  hasContent: false,
  source: 'structured',
  session: {
    pathPrefix: '??????',
    fileLabel: '?????',
    meta: 'WSL · bash',
  },
  summary: {
    tone: 'neutral',
    statusLabel: '待执行',
    phaseLabel: '等待运行',
    elapsedLabel: '—',
    progress: 0,
    counts: {
      success: 0,
      warning: 0,
      error: 0,
      running: 0,
    },
  },
  timeline: [],
};

const currentReportKey = computed(
  () => `${props.workspaceRootPath ?? ''}::${props.documentPath ?? ''}::${props.documentName}`,
);

const reportCache = ref<Map<string, IStructuredRunReport>>(new Map());
const liveReport = ref<IStructuredRunReport>(EMPTY_REPORT);
const expandedItemIds = ref<Set<string>>(new Set());

let reportBuildTimerId: number | null = null;
let lastFallbackDiagnosticSignature: string | null = null;

const hasRawRunSignals = computed(() => (
  props.isRunning
  || props.runLogs.length > 0
  || props.lastRunResult !== null
  || props.terminalOutputLength > 0
));

const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\u0007|\u001b\\))/g;
const EMERGENCY_PROMPT_ONLY_PATTERN = /^[\w.-]+@[\w.-]+:.*[$#]\s*$/;
const EMERGENCY_TEMP_SCRIPT_PATTERN = /\/tmp\/[\w.-]+\.tmp\.sh/i;

const resolveLatestRunMarker = (runLogs: IRunLogEntry[]): IRunLogEntry | undefined =>
  [...runLogs]
    .reverse()
    .find((item) => isTerminalRunFlowLog(item) && (isTerminalRunStartLog(item) || isTerminalRunDispatchedLog(item)));

const buildEmergencyDetailLines = (
  value: string,
  options?: {
    stripTerminalNoise?: boolean;
  },
): IStructuredRunDetailLine[] => value
  .replace(ANSI_ESCAPE_PATTERN, '')
  .replace(/\r\n/g, '\n')
  .replace(/\r/g, '\n')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .filter((line) => {
    if (!options?.stripTerminalNoise) {
      return true;
    }

    if (EMERGENCY_TEMP_SCRIPT_PATTERN.test(line)) {
      return false;
    }

    if (EMERGENCY_PROMPT_ONLY_PATTERN.test(line)) {
      return false;
    }

    return true;
  })
  .slice(-8)
  .map((line) => ({
    text: line,
    tone: /error|failed|failure|exception|未找到|失败|错误|异常/i.test(line)
      ? 'error'
      : /warning|warn|deprecated|注意|提醒/i.test(line)
        ? 'warning'
        : 'default',
  }));

const buildEmergencyReport = (reason?: string): IStructuredRunReport => {
  const sortedRunLogs = [...props.runLogs].sort(
    (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
  );
  const rawOutput = props.resolveTerminalOutput().trim();
  const timeline: IStructuredRunTimelineItem[] = [];

  if (reason) {
    timeline.push({
      id: 'fallback-report-warning',
      tag: 'warn',
      accent: 'orange',
      title: '已切换到基础日志视图',
      description: reason,
      status: 'warning',
      timestamp: '实时',
      detailsLabel: '查看说明',
      details: buildEmergencyDetailLines(reason),
      gapWeight: 1,
    });
  }

  for (const item of sortedRunLogs) {
    const runLogKind = resolveTerminalRunLogKind(item);
    const status = item.level === 'error'
      ? 'error'
      : runLogKind === 'failed' || runLogKind === 'timeout'
        ? 'error'
        : props.isRunning && runLogKind === 'start'
          ? 'running'
          : 'done';
    timeline.push({
      id: `fallback-log-${item.id}`,
      tag: status === 'error' ? 'error' : isTerminalRunDispatchedLog(item) ? 'exec' : 'info',
      accent: status === 'error' ? 'red' : isTerminalRunDispatchedLog(item) ? 'teal' : 'blue',
      title: item.title,
      description: item.detail,
      status,
      timestamp: formatTime(item.createdAt),
      detailsLabel: item.detail.trim() ? '查看详情' : undefined,
      details: item.detail.trim() ? buildEmergencyDetailLines(item.detail) : undefined,
      gapWeight: 1,
    });
  }

  if (rawOutput) {
    const terminalOutputDetails = buildEmergencyDetailLines(rawOutput, {
      stripTerminalNoise: true,
    });

    if (terminalOutputDetails.length > 0) {
      timeline.push({
        id: 'fallback-terminal-output',
        tag: props.isRunning ? 'running' : 'done',
        accent: props.isRunning ? 'blue' : 'green',
        title: props.isRunning ? '终端实时输出' : '终端输出',
        description: props.isRunning ? '已捕获终端可见输出。' : '已保留本次运行的终端输出。',
        status: props.isRunning ? 'running' : 'done',
        timestamp: '实时',
        detailsLabel: '查看输出',
        details: terminalOutputDetails,
        gapWeight: 1,
      });
    }
  }

  if (timeline.length === 0 && props.isRunning) {
    timeline.push({
      id: 'fallback-running-placeholder',
      tag: 'running',
      accent: 'blue',
      title: '正在等待终端反馈…',
      description: '运行请求已经发出，但尚未收到可用于构建结构化日志的反馈。',
      status: 'running',
      timestamp: '实时',
      gapWeight: 1,
    });
  }

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

  const tone = props.isRunning
    ? 'running'
    : props.lastRunResult?.success === false || counts.error > 0
      ? 'error'
      : props.lastRunResult?.success === true || counts.success > 0
        ? 'success'
        : counts.warning > 0
          ? 'warning'
          : hasRawRunSignals.value
            ? 'running'
            : 'neutral';

  return {
    hasContent: hasRawRunSignals.value,
    source: 'fallback',
    fallbackReason: reason ?? FALLBACK_EMPTY_WITH_SIGNALS_REASON,
    session: {
      pathPrefix: props.documentPath ? '' : formatFileSystemPathForDisplay(props.workspaceRootPath) || '??????',
      fileLabel: props.documentPath
        ? formatFileSystemPathForDisplay(props.documentPath)
        : props.documentName || '?????',
      meta: `${props.lastRunResult?.executorLabel ?? props.executor.toUpperCase()} · bash`,
    },
    summary: {
      tone,
      statusLabel:
        tone === 'running'
          ? '运行中'
          : tone === 'error'
            ? '执行异常'
            : tone === 'warning'
              ? '有警告'
              : tone === 'success'
                ? '已完成'
                : '待执行',
      phaseLabel: timeline.length > 0 ? `已捕获 ${timeline.length} 条事件` : '等待运行',
      elapsedLabel: props.lastRunResult
        ? `${Math.max(0, props.lastRunResult.durationMs / 1000).toFixed(1)}s`
        : '—',
      progress: tone === 'running' ? 24 : tone === 'neutral' ? 0 : 100,
      counts,
    },
    timeline,
  };
};

const buildReportDebugSample = (): Record<string, unknown> => {
  const terminalOutput = props.resolveTerminalOutput();
  const latestRunMarker = resolveLatestRunMarker(props.runLogs);

  return {
    documentPath: props.documentPath,
    isRunning: props.isRunning,
    latestRunMarkerId: latestRunMarker?.id ?? null,
    runLogCount: props.runLogs.length,
    runLogTitles: props.runLogs.slice(-6).map((item) => item.title),
    lastRunResult: props.lastRunResult
      ? {
        success: props.lastRunResult.success,
        exitCode: props.lastRunResult.exitCode,
        startedAt: props.lastRunResult.startedAt,
        finishedAt: props.lastRunResult.finishedAt,
      }
      : null,
    terminalOutputLength: terminalOutput.length,
    terminalOutputPreview: terminalOutput.slice(0, 240),
  };
};

const resolveFallbackDiagnosticSignature = (reason: string): string => {
  const latestRunMarker = resolveLatestRunMarker(props.runLogs);

  return [
    currentReportKey.value,
    latestRunMarker?.id ?? props.lastRunResult?.startedAt ?? props.lastRunResult?.finishedAt ?? 'idle',
    reason,
  ].join('::');
};

const reportFallbackDiagnostic = (
  level: 'warn' | 'error',
  reason: string,
  error?: unknown,
): void => {
  const signature = resolveFallbackDiagnosticSignature(reason);
  if (lastFallbackDiagnosticSignature === signature) {
    return;
  }

  lastFallbackDiagnosticSignature = signature;
  const sample = buildReportDebugSample();

  if (level === 'error') {
    console.error('[structured-run-report] 构建失败，已切换到基础日志视图', {
      reason,
      error,
      sample,
    });
    return;
  }

  console.warn('[structured-run-report] 结构化日志未产出结果，已切换到基础日志视图', {
    reason,
    sample,
  });
};

const buildReportSafely = (): IStructuredRunReport => {
  try {
    return (
      buildStructuredRunReport({
        terminalOutput: props.resolveTerminalOutput(),
        runLogs: props.runLogs,
        lastRunResult: props.lastRunResult,
        isRunning: props.isRunning,
        executor: props.executor,
        documentName: props.documentName,
        documentPath: props.documentPath,
        workspaceRootPath: props.workspaceRootPath,
      }) ?? EMPTY_REPORT
    );
  } catch (error) {
    reportFallbackDiagnostic('error', FALLBACK_BUILD_ERROR_REASON, error);
    return buildEmergencyReport(FALLBACK_BUILD_ERROR_REASON);
  }
};

const clearPendingReportBuild = (): void => {
  if (reportBuildTimerId === null) {
    return;
  }

  window.clearTimeout(reportBuildTimerId);
  reportBuildTimerId = null;
};

const cacheReport = (key: string, nextReport: IStructuredRunReport): void => {
  const nextCache = new Map(reportCache.value);
  if (nextCache.has(key)) {
    nextCache.delete(key);
  }

  nextCache.set(key, nextReport);

  while (nextCache.size > MAX_REPORT_CACHE_ENTRIES) {
    const oldestKey = nextCache.keys().next().value;
    if (!oldestKey) {
      break;
    }

    nextCache.delete(oldestKey);
  }

  reportCache.value = nextCache;
};

const updateLiveReport = (): void => {
  clearPendingReportBuild();

  let nextReport = buildReportSafely();
  if (!nextReport.hasContent && hasRawRunSignals.value) {
    reportFallbackDiagnostic('warn', FALLBACK_EMPTY_WITH_SIGNALS_REASON);
    nextReport = buildEmergencyReport(FALLBACK_EMPTY_WITH_SIGNALS_REASON);
  }

  if (nextReport.source !== 'fallback') {
    lastFallbackDiagnosticSignature = null;
  }

  liveReport.value = nextReport;

  if (nextReport.hasContent) {
    cacheReport(currentReportKey.value, nextReport);
  }
};

const scheduleLiveReportUpdate = (): void => {
  clearPendingReportBuild();

  reportBuildTimerId = window.setTimeout(() => {
    reportBuildTimerId = null;
    updateLiveReport();
  }, props.isRunning ? REPORT_REBUILD_DELAY_MS : 32);
};

watch(
  currentReportKey,
  () => {
    if (!props.active) {
      liveReport.value = EMPTY_REPORT;
      return;
    }

    updateLiveReport();
  },
  { immediate: true },
);

watch(
  () => props.active,
  (nextActive) => {
    if (!nextActive) {
      clearPendingReportBuild();
      return;
    }

    updateLiveReport();
  },
  { immediate: true },
);

watch(
  () => [
    props.terminalOutputVersion,
    props.runLogs.length,
    props.runLogs[0]?.id ?? '',
    props.lastRunResult?.finishedAt ?? '',
    props.lastRunResult?.exitCode ?? null,
    props.lastRunResult?.durationMs ?? null,
    props.isRunning,
    props.executor,
    props.documentName,
    props.documentPath,
    props.workspaceRootPath,
  ],
  () => {
    if (!props.active) {
      return;
    }

    scheduleLiveReportUpdate();
  },
  { flush: 'post' },
);

const displayedReport = computed<IStructuredRunReport>(() => {
  if (liveReport.value.hasContent) {
    return liveReport.value;
  }

  return reportCache.value.get(currentReportKey.value) ?? liveReport.value;
});

const summaryTone = computed(() => displayedReport.value.summary.tone);
const isFallbackReportActive = computed(() => (
  displayedReport.value.hasContent && displayedReport.value.source === 'fallback'
));
const fallbackBadgeTitle = computed(() => displayedReport.value.fallbackReason ?? '当前已切换到基础日志视图。');

const runIndicatorLabel = computed(() => {
  switch (summaryTone.value) {
    case 'running':
      return '运行中';
    case 'success':
      return '已完成';
    case 'warning':
      return '有警告';
    case 'error':
      return '执行异常';
    default:
      return '待执行';
  }
});

const commandPreview = computed(() => {
  if (props.lastRunResult?.commandLine) {
    return props.lastRunResult.commandLine;
  }

  const dispatchLog = [...props.runLogs]
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .find(isTerminalRunDispatchedLog);

  if (dispatchLog?.detail) {
    return dispatchLog.detail;
  }

  const pathPrefix = displayedReport.value.session.pathPrefix.trim();
  return pathPrefix
    ? `${pathPrefix} / ${displayedReport.value.session.fileLabel}`
    : displayedReport.value.session.fileLabel;
});

const environmentParts = computed(() => {
  const [executorLabel, shellLabel] = displayedReport.value.session.meta
    .split('·')
    .map((item) => item.trim())
    .filter(Boolean);

  return [executorLabel ?? 'WSL', shellLabel ?? 'bash'] as const;
});

const stepProgress = computed(() => {
  const total = displayedReport.value.timeline.length;
  return {
    current: total,
    total,
  };
});

const elapsedLabel = computed(() => displayedReport.value.summary.elapsedLabel.replace(/s$/, ''));

const hasCopyableOutput = computed(() => {
  return props.terminalOutputLength > 0 || displayedReport.value.timeline.length > 0;
});

type TTerminalLogTone = 'info' | 'exec' | 'ok' | 'warn' | 'err' | 'live';

const resolveKindLabel = (item: IStructuredRunTimelineItem): string => {
  if (item.status === 'running') {
    return 'Run';
  }

  switch (item.tag) {
    case 'start':
      return 'Start';
    case 'exec':
      return 'Exec';
    case 'error':
      return 'Error';
    case 'warn':
      return 'Hint';
    case 'done':
      return 'Done';
    case 'load':
      return 'Temp';
    default:
      return 'Info';
  }
};

const resolveItemTone = (item: IStructuredRunTimelineItem): TTerminalLogTone => {
  if (item.status === 'running') {
    return 'live';
  }

  if (item.status === 'error') {
    return 'err';
  }

  if (item.status === 'warning') {
    return 'warn';
  }

  if (item.tag === 'exec' || item.tag === 'load') {
    return 'exec';
  }

  if (item.tag === 'done') {
    return 'ok';
  }

  return 'info';
};

const resolveEventTone = (item: IStructuredRunTimelineItem): TTerminalLogTone => resolveItemTone(item);

const resolveKindTone = (item: IStructuredRunTimelineItem): TTerminalLogTone => resolveItemTone(item);

const resolveInlineCode = (item: IStructuredRunTimelineItem): string | null => {
  if (item.status !== 'error') {
    return null;
  }

  return item.details?.[0]?.text ?? item.description ?? null;
};

const resolveOutputLines = (item: IStructuredRunTimelineItem): IStructuredRunDetailLine[] => {
  const detailLines = item.details ?? [];

  if (item.status === 'error' && detailLines.length > 1) {
    return detailLines.slice(1);
  }

  if (item.status === 'error' && detailLines.length === 1) {
    return [];
  }

  return detailLines;
};

const resolveToggleLabel = (item: IStructuredRunTimelineItem): string => {
  if (isExpanded(item.id)) {
    return item.status === 'running' ? '收起实时输出' : '隐藏输出';
  }

  if (item.status === 'running') {
    return '查看实时输出';
  }

  return item.detailsLabel ?? '查看输出';
};

watch(
  () => displayedReport.value.timeline,
  (items) => {
    const visibleIds = items.map((item) => item.id);
    const nextExpandedIds = new Set<string>();

    for (const itemId of expandedItemIds.value) {
      if (visibleIds.includes(itemId)) {
        nextExpandedIds.add(itemId);
      }
    }

    for (const item of items) {
      if (item.status === 'running') {
        nextExpandedIds.add(item.id);
      }
    }

    expandedItemIds.value = nextExpandedIds;
  },
  { immediate: true },
);

const toggleExpanded = (itemId: string): void => {
  const nextExpandedIds = new Set(expandedItemIds.value);
  if (nextExpandedIds.has(itemId)) {
    nextExpandedIds.delete(itemId);
  } else {
    nextExpandedIds.add(itemId);
  }

  expandedItemIds.value = nextExpandedIds;
};

const isExpanded = (itemId: string): boolean => expandedItemIds.value.has(itemId);

type TTimelineScrollBehavior = 'auto' | 'smooth';

const scrollTimelineToBottom = async (behavior: TTimelineScrollBehavior): Promise<void> => {
  await nextTick();
  const timelineElement = timelineRef.value;
  if (!timelineElement) {
    return;
  }

  timelineElement.scrollTo({
    top: timelineElement.scrollHeight,
    behavior,
  });
};

watch(
  () => [
    props.active,
    isAutoScrollEnabled.value,
    displayedReport.value.timeline.map((item) => item.id).join('|'),
  ],
  ([nextActive, nextAutoScroll]) => {
    if (!nextActive || !nextAutoScroll) {
      return;
    }

    void scrollTimelineToBottom(props.isRunning ? 'smooth' : 'auto');
  },
  { flush: 'post' },
);

const buildFallbackCopyPayload = (): string => {
  return displayedReport.value.timeline
    .map((item) => {
      const output = resolveOutputLines(item)
        .map((detail) => detail.text)
        .join('\n');
      return [item.timestamp, item.title, item.description, output].filter(Boolean).join('\n');
    })
    .join('\n\n');
};

const handleCopyAllOutput = async (): Promise<void> => {
  const rawOutput = props.resolveTerminalOutput().trim();
  const payload = rawOutput || buildFallbackCopyPayload();

  if (!payload) {
    message.warning('暂无可复制的终端输出');
    return;
  }

  try {
    await writeClipboardText(payload);
    message.success('已复制终端输出');
  } catch (error) {
    message.error(toErrorMessage(error, '复制终端输出失败'));
  }
};

const handleClearLogs = (): void => {
  emit('clear');
  message.success('已清空运行日志');
};

const submitCommand = (): void => {
  const normalizedCommand = commandInput.value.trim();
  if (!normalizedCommand || !props.isTerminalReady) {
    return;
  }

  emit('submit-command', normalizedCommand);
  commandInput.value = '';
};

onBeforeUnmount(() => {
  clearPendingReportBuild();
});
</script>

<style scoped>
.terminal-log-shell {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  background: linear-gradient(180deg, color-mix(in srgb, var(--panel-bg) 98%, transparent), var(--panel-bg));
}

.terminal-log-header,
.terminal-log-meta,
.terminal-log-footer {
  flex-shrink: 0;
}

.terminal-log-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 24px 0;
  user-select: none;
}

.terminal-log-run-indicator {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
}

.terminal-log-run-pulse {
  position: relative;
  width: 7px;
  height: 7px;
  flex-shrink: 0;
  border-radius: 999px;
  background: var(--accent-strong);
  box-shadow: 0 0 10px color-mix(in srgb, var(--accent-strong) 60%, transparent);
}

.terminal-log-run-indicator.tone-success .terminal-log-run-pulse {
  background: var(--success);
  box-shadow: 0 0 10px color-mix(in srgb, var(--success) 54%, transparent);
}

.terminal-log-run-indicator.tone-warning .terminal-log-run-pulse {
  background: var(--warning);
  box-shadow: 0 0 10px color-mix(in srgb, var(--warning) 54%, transparent);
}

.terminal-log-run-indicator.tone-error .terminal-log-run-pulse {
  background: var(--danger);
  box-shadow: 0 0 12px color-mix(in srgb, var(--danger) 56%, transparent);
}

.terminal-log-run-indicator.tone-running .terminal-log-run-pulse::after {
  content: '';
  position: absolute;
  inset: -3px;
  border: 1px solid color-mix(in srgb, var(--accent-strong) 84%, transparent);
  border-radius: 999px;
  opacity: 0.55;
  animation: terminal-log-ring 1.6s ease-out infinite;
}

@keyframes terminal-log-ring {
  0% {
    transform: scale(0.6);
    opacity: 0.6;
  }

  100% {
    transform: scale(2);
    opacity: 0;
  }
}

.terminal-log-run-path {
  min-width: 0;
  overflow: hidden;
  color: var(--text-tertiary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.terminal-log-header-spacer {
  flex: 1;
}

.terminal-log-env-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 22px;
  padding: 0 10px;
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  color: var(--text-tertiary);
  font-size: 11px;
  white-space: nowrap;
}

.terminal-log-fallback-badge {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--warning) 38%, var(--border-subtle));
  border-radius: 999px;
  background: color-mix(in srgb, var(--warning) 12%, transparent);
  color: color-mix(in srgb, var(--warning) 72%, var(--text-secondary));
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.terminal-log-env-sep {
  color: var(--text-quaternary);
}

.terminal-log-header-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.terminal-log-icon-button {
  height: 26px;
  width: 26px;
}

.terminal-log-icon-button svg {
  width: 13px;
  height: 13px;
}

.terminal-log-icon-button.is-selected {
  color: var(--text-primary);
}

.terminal-log-icon-button.is-selected:hover {
  background: transparent;
}

.terminal-log-meta {
  display: flex;
  align-items: baseline;
  gap: 16px;
  padding: 10px 24px 0;
}

.terminal-log-meta-item {
  color: var(--text-tertiary);
  font-size: 12px;
}

.terminal-log-meta-value {
  margin-right: 4px;
  color: var(--text-primary);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.terminal-log-meta-item.is-success .terminal-log-meta-value {
  color: var(--success);
}

.terminal-log-meta-item.is-warning .terminal-log-meta-value {
  color: var(--warning);
}

.terminal-log-meta-item.is-error .terminal-log-meta-value {
  color: var(--danger);
}

.terminal-log-meta-item.is-running .terminal-log-meta-value {
  color: var(--accent-strong);
}

.terminal-log-meta-sep {
  color: var(--text-quaternary);
}

.terminal-log-elapsed {
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.terminal-log-elapsed-label {
  margin-left: 4px;
  color: var(--text-quaternary);
}

.terminal-log-progress-track {
  position: relative;
  margin: 10px 24px 0;
  height: 2px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--shell-divider) 80%, transparent);
}

.terminal-log-progress-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent-strong) 0%, #8b5cf6 16%, #ec4899 32%, #f97316 48%, #eab308 64%, #10b981 80%, #06b6d4 92%, var(--accent-strong) 100%);
  background-size: 220% 100%;
  box-shadow: 0 0 10px rgba(139, 92, 246, 0.22);
}

.terminal-log-progress-fill.is-live {
  animation: terminal-log-rainbow-slide 4.5s linear infinite;
}

@keyframes terminal-log-rainbow-slide {
  0% {
    background-position: 0% 0%;
  }

  100% {
    background-position: -220% 0%;
  }
}

.terminal-log-timeline {
  flex: 1;
  min-height: 0;
  margin-top: 14px;
  padding: 4px 14px 20px;
  overflow-y: auto;
}

.terminal-log-timeline::-webkit-scrollbar {
  width: 10px;
}

.terminal-log-timeline::-webkit-scrollbar-thumb {
  border: 2px solid var(--panel-bg);
  border-radius: 999px;
  background: color-mix(in srgb, var(--shell-divider) 90%, transparent);
}

.terminal-log-timeline-list {
  position: relative;
}

.terminal-log-timeline-list::before {
  content: '';
  position: absolute;
  left: 15.5px;
  top: 14px;
  bottom: 14px;
  width: 1px;
  background: linear-gradient(180deg, transparent 0%, color-mix(in srgb, var(--shell-divider) 90%, transparent) 6%, color-mix(in srgb, var(--shell-divider) 90%, transparent) 94%, transparent 100%);
}

.terminal-log-event-row {
  position: relative;
  display: grid;
  grid-template-columns: 12px 64px 56px minmax(0, 1fr);
  column-gap: 14px;
  padding: 8px 10px calc(8px + (var(--terminal-log-gap, 1) * 4px)) 10px;
  animation: terminal-log-fade-up 0.45s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  animation-delay: calc(var(--terminal-log-index, 0) * 0.04s);
}

@keyframes terminal-log-fade-up {
  from {
    opacity: 0;
    transform: translateY(4px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.terminal-log-event-icon {
  position: relative;
  z-index: 1;
  display: grid;
  width: 12px;
  height: 12px;
  margin-top: 4px;
  place-items: center;
}

.terminal-log-event-dot {
  position: relative;
  width: 9px;
  height: 9px;
  border: 1.5px solid var(--accent-strong);
  border-radius: 999px;
  background: var(--accent-strong);
  box-shadow: 0 0 0 3px var(--panel-bg), 0 0 0 5px color-mix(in srgb, var(--accent-strong) 20%, transparent), 0 0 14px color-mix(in srgb, var(--accent-strong) 50%, transparent);
}

.terminal-log-event-dot::before {
  content: '';
  position: absolute;
  inset: 1.2px;
  border-radius: 999px;
  background: radial-gradient(circle at 30% 28%, rgba(255, 255, 255, 0.52) 0%, transparent 60%);
}

.terminal-log-event-icon.is-exec .terminal-log-event-dot {
  border-color: #b084eb;
  background: #b084eb;
  box-shadow: 0 0 0 3px var(--panel-bg), 0 0 0 5px rgba(176, 132, 235, 0.22), 0 0 14px rgba(176, 132, 235, 0.52);
}

.terminal-log-event-icon.is-ok .terminal-log-event-dot {
  border-color: var(--success);
  background: var(--success);
  box-shadow: 0 0 0 3px var(--panel-bg), 0 0 0 5px color-mix(in srgb, var(--success) 24%, transparent), 0 0 14px color-mix(in srgb, var(--success) 52%, transparent);
}

.terminal-log-event-icon.is-warn .terminal-log-event-dot {
  border-color: var(--warning);
  background: var(--warning);
  box-shadow: 0 0 0 3px var(--panel-bg), 0 0 0 5px color-mix(in srgb, var(--warning) 26%, transparent), 0 0 14px color-mix(in srgb, var(--warning) 52%, transparent);
}

.terminal-log-event-icon.is-err .terminal-log-event-dot {
  border-color: var(--danger);
  background: var(--danger);
  box-shadow: 0 0 0 3px var(--panel-bg), 0 0 0 5px color-mix(in srgb, var(--danger) 26%, transparent), 0 0 16px color-mix(in srgb, var(--danger) 55%, transparent);
}

.terminal-log-event-icon.is-live .terminal-log-event-dot {
  width: 10px;
  height: 10px;
  border: none;
  background: radial-gradient(circle at 32% 30%, #b4bcef 0%, #7a86ea 35%, var(--accent-strong) 65%, #3b4499 100%);
  box-shadow: 0 0 0 3px var(--panel-bg), 0 0 0 5px color-mix(in srgb, var(--accent-strong) 25%, transparent), 0 0 20px color-mix(in srgb, var(--accent-strong) 70%, transparent), inset 0 0 4px rgba(255, 255, 255, 0.15);
  animation: terminal-log-live-core 2s ease-in-out infinite;
}

.terminal-log-event-icon.is-live::before,
.terminal-log-event-icon.is-live::after {
  content: '';
  position: absolute;
  inset: 0;
  border: 1px solid var(--accent-strong);
  border-radius: 999px;
  opacity: 0;
  animation: terminal-log-live-ripple 2.4s cubic-bezier(0.2, 0.8, 0.2, 1) infinite;
}

.terminal-log-event-icon.is-live::after {
  animation-delay: 1.2s;
}

@keyframes terminal-log-live-core {

  0%,
  100% {
    transform: scale(1);
  }

  50% {
    transform: scale(1.08);
  }
}

@keyframes terminal-log-live-ripple {
  0% {
    transform: scale(0.7);
    opacity: 0.85;
  }

  70% {
    opacity: 0;
  }

  100% {
    transform: scale(3.2);
    opacity: 0;
  }
}

.terminal-log-event-time {
  color: var(--text-quaternary);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.terminal-log-event-time.is-live {
  color: var(--accent-strong);
}

.terminal-log-event-kind {
  padding-top: 1px;
  color: var(--text-quaternary);
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
}

.terminal-log-event-kind.is-info {
  color: #4ec9ff;
}

.terminal-log-event-kind.is-exec {
  color: #b084eb;
}

.terminal-log-event-kind.is-ok {
  color: var(--success);
}

.terminal-log-event-kind.is-warn {
  color: var(--warning);
}

.terminal-log-event-kind.is-err {
  color: var(--danger);
}

.terminal-log-event-kind.is-live {
  color: #7a86ea;
}

.terminal-log-event-body {
  min-width: 0;
}

.terminal-log-event-title {
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.45;
}

.terminal-log-event-desc {
  margin-top: 3px;
  color: var(--text-tertiary);
  font-size: 12.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.terminal-log-event-code {
  display: block;
  margin-top: 8px;
  padding: 7px 10px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 74%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--panel-muted) 92%, transparent);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.55;
  text-overflow: ellipsis;
  white-space: pre-wrap;
  word-break: break-word;
}

.terminal-log-event-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 7px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-quaternary);
  font-size: 11.5px;
  cursor: pointer;
  transition: color 0.14s ease;
}

.terminal-log-event-toggle:hover {
  color: color-mix(in srgb, var(--accent-strong) 84%, white 8%);
}

.terminal-log-event-chevron {
  width: 9px;
  height: 9px;
  transition: transform 0.22s cubic-bezier(0.4, 0, 0.2, 1);
}

.terminal-log-event-toggle.is-expanded .terminal-log-event-chevron {
  transform: rotate(90deg);
}

.terminal-log-event-output {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.28s cubic-bezier(0.4, 0, 0.2, 1), margin-top 0.22s ease;
}

.terminal-log-event-output.is-expanded {
  max-height: 360px;
  margin-top: 8px;
}

.terminal-log-event-output pre {
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 72%, transparent);
  border-radius: 6px;
  background: var(--bg-code);
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.6;
}

.terminal-log-event-output pre::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.terminal-log-event-output pre::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: color-mix(in srgb, var(--shell-divider) 88%, transparent);
}

.terminal-log-output-line {
  display: block;
  white-space: pre-wrap;
  word-break: break-word;
}

.terminal-log-output-line.is-default {
  color: var(--text-secondary);
}

.terminal-log-output-line.is-muted {
  color: var(--text-quaternary);
}

.terminal-log-output-line.is-warning {
  color: var(--warning);
}

.terminal-log-output-line.is-error {
  color: var(--danger);
}

.terminal-log-output-line.is-success {
  color: var(--success);
}

.terminal-log-empty-state {
  display: grid;
  min-height: 100%;
  place-items: center;
  padding: 32px 24px;
  text-align: center;
}

.terminal-log-empty-title {
  margin: 0;
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 500;
}

.terminal-log-empty-text {
  max-width: 420px;
  margin: 10px 0 0;
  color: var(--text-tertiary);
  font-size: 12.5px;
  line-height: 1.7;
}

.terminal-log-footer {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 20px;
  border-top: 1px solid var(--shell-divider);
  background: color-mix(in srgb, var(--panel-bg) 98%, transparent);
}

.terminal-log-footer::before {
  content: '';
  position: absolute;
  top: -1px;
  left: 0;
  right: 0;
  height: 1px;
  opacity: 0;
  background: linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--accent-strong) 28%, transparent) 20%, rgba(236, 72, 153, 0.22) 40%, rgba(245, 158, 11, 0.22) 60%, rgba(16, 185, 129, 0.22) 80%, transparent 100%);
  transition: opacity 0.25s ease;
}

.terminal-log-footer:focus-within::before {
  opacity: 1;
}

.terminal-log-footer.is-disabled {
  opacity: 0.7;
}

.terminal-log-prompt {
  flex-shrink: 0;
  color: var(--accent-strong);
  font-size: 13px;
  font-weight: 600;
}

.terminal-log-command-input {
  min-width: 0;
  flex: 1;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  font-size: 12.5px;
  outline: none;
  caret-color: var(--accent-strong);
}

.terminal-log-command-input::placeholder {
  color: var(--text-quaternary);
  font-family: var(--font-sans);
}

.terminal-log-command-input:disabled {
  cursor: default;
}

@media (max-width: 880px) {

  .terminal-log-header,
  .terminal-log-meta {
    flex-wrap: wrap;
  }

  .terminal-log-header-spacer {
    display: none;
  }

  .terminal-log-run-path {
    order: 3;
    flex-basis: 100%;
  }

  .terminal-log-meta {
    gap: 12px;
  }

  .terminal-log-event-row {
    grid-template-columns: 12px 56px 48px minmax(0, 1fr);
    column-gap: 12px;
  }
}

@media (max-width: 640px) {

  .terminal-log-header,
  .terminal-log-meta {
    padding-left: 16px;
    padding-right: 16px;
  }

  .terminal-log-progress-track {
    margin-left: 16px;
    margin-right: 16px;
  }

  .terminal-log-timeline {
    padding-left: 10px;
    padding-right: 10px;
  }

  .terminal-log-event-row {
    grid-template-columns: 12px 1fr;
    row-gap: 4px;
  }

  .terminal-log-event-time,
  .terminal-log-event-kind,
  .terminal-log-event-body {
    grid-column: 2;
  }

  .terminal-log-footer {
    padding-left: 16px;
    padding-right: 16px;
  }
}
</style>
