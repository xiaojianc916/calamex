<script setup lang="ts">
import {
  Activity,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileText,
  FolderTree,
  GitBranch,
  Globe,
  LoaderCircle,
  Pencil,
  Search,
  Terminal,
  XCircle,
} from 'lucide-vue-next';
import type { Component } from 'vue';
import { computed } from 'vue';

import type {
  IAgentActivity,
  IAgentActivityDetail,
  TAgentActivityEvent,
  TAgentActivityStatus,
} from '@/types/agent-activity';
import type { IAiToolCall } from '@/types/ai';
import { materializeAgentActivities } from '@/utils/agent-activity';

const props = defineProps<{
  toolCalls: IAiToolCall[];
  activityText?: string;
  activityTrail?: string[];
  activities?: IAgentActivity[];
  activityEvents?: TAgentActivityEvent[];
}>();

type TToolActionKind =
  | 'read'
  | 'fileSearch'
  | 'symbolSearch'
  | 'diagnose'
  | 'patch'
  | 'applyPatch'
  | 'execute'
  | 'verify'
  | 'git'
  | 'web'
  | 'webFetch'
  | 'tree'
  | 'unknown';

interface IToolActionMeta {
  verb: string;
  fallbackTarget: string;
  icon: Component;
}

interface IToolStatusMeta {
  label: string;
  detail: string;
  icon: Component;
}

interface IToolTimelineItem extends IAiToolCall {
  actionLabel: string;
  headline: string;
  statusLabel: string;
  target: string;
  preview: string | null;
  leafItems: string[];
  lineRange: string | null;
  toolIcon: Component;
}

interface IToolActivityRow {
  id: string;
  title: string;
  status: IAiToolCall['status'];
  statusIcon: Component;
  isSpinning: boolean;
}

const TOOL_ACTION_BY_NAME: Record<string, TToolActionKind> = {
  read_text_file: 'read',
  read_media_file: 'read',
  read_multiple_files: 'read',
  read_current_file: 'read',
  read_selected_text: 'read',
  read_file: 'read',
  read_project_file: 'read',
  get_file_info: 'read',
  list_open_files: 'read',
  list_project_files: 'tree',
  list_allowed_directories: 'tree',
  list_directory: 'tree',
  list_directory_with_sizes: 'tree',
  directory_tree: 'tree',
  get_package_scripts: 'read',
  get_test_targets: 'read',
  get_terminal_log: 'read',
  search_files: 'fileSearch',
  search_text: 'fileSearch',
  search_symbols: 'symbolSearch',
  search_project_files: 'fileSearch',
  get_diagnostics: 'diagnose',
  get_git_diff: 'git',
  git_status: 'git',
  git_diff_unstaged: 'git',
  git_diff_staged: 'git',
  git_log: 'git',
  git_show: 'git',
  get_project_tree: 'tree',
  web_search: 'web',
  web_fetch: 'webFetch',
  'tavily-search': 'web',
  'tavily-extract': 'webFetch',
  'tavily-map': 'web',
  'tavily-crawl': 'webFetch',
  tavily_search: 'web',
  tavily_extract: 'webFetch',
  tavily_map: 'web',
  tavily_crawl: 'webFetch',
  tavily_research: 'web',
  propose_patch: 'patch',
  auto_apply_patch: 'applyPatch',
  write_file: 'applyPatch',
  edit_file: 'applyPatch',
  create_directory: 'applyPatch',
  move_file: 'applyPatch',
  delete_file: 'execute',
  run_test: 'verify',
  run_command: 'execute',
  run_shell_command: 'execute',
  install_package: 'execute',
  stage_file: 'git',
  create_commit: 'git',
  git_commit: 'git',
};

const TOOL_DISPLAY_BY_NAME: Readonly<Record<string, string>> = {
  read_text_file: '查看文本文件',
  read_media_file: '查看媒体文件',
  read_multiple_files: '查看多个文件',
  read_current_file: '查看当前文件',
  read_selected_text: '查看选区',
  read_file: '查看文件',
  read_project_file: '查看项目文件',
  get_file_info: '查看文件信息',
  list_directory: '查看目录',
  list_directory_with_sizes: '查看目录大小',
  directory_tree: '查看目录树',
  list_allowed_directories: '查看可访问目录',
  list_project_files: '查看项目文件',
  search_files: '文件搜索',
  search_text: '全文搜索',
  search_project_files: '项目搜索',
  search_symbols: '符号搜索',
  web_search: '联网搜索',
  web_fetch: '读取网页',
  'tavily-search': '联网搜索',
  'tavily-extract': '读取网页',
  'tavily-map': '查看站点地图',
  'tavily-crawl': '抓取站点',
  tavily_search: '联网搜索',
  tavily_extract: '读取网页',
  tavily_map: '查看站点地图',
  tavily_crawl: '抓取站点',
  tavily_research: '联网调研',
};

const TOOL_ACTION_META: Record<TToolActionKind, IToolActionMeta> = {
  read: {
    verb: '查看文件',
    fallbackTarget: '文件',
    icon: FileText,
  },
  fileSearch: {
    verb: '搜索文件',
    fallbackTarget: '项目',
    icon: Search,
  },
  symbolSearch: {
    verb: '搜索符号',
    fallbackTarget: '项目',
    icon: Search,
  },
  diagnose: {
    verb: '检查',
    fallbackTarget: '工作区',
    icon: Activity,
  },
  patch: {
    verb: '生成 Patch',
    fallbackTarget: '变更',
    icon: Pencil,
  },
  applyPatch: {
    verb: '应用 Patch',
    fallbackTarget: '变更',
    icon: Pencil,
  },
  execute: {
    verb: '执行',
    fallbackTarget: '命令',
    icon: Terminal,
  },
  verify: {
    verb: '验证',
    fallbackTarget: '测试',
    icon: Terminal,
  },
  git: {
    verb: 'Git',
    fallbackTarget: '变更',
    icon: GitBranch,
  },
  web: {
    verb: '检索',
    fallbackTarget: '资源',
    icon: Globe,
  },
  webFetch: {
    verb: '查看网页',
    fallbackTarget: '网页',
    icon: Globe,
  },
  tree: {
    verb: '查看目录',
    fallbackTarget: '项目结构',
    icon: FolderTree,
  },
  unknown: {
    verb: '调用',
    fallbackTarget: '任务',
    icon: Activity,
  },
};

const TOOL_STATUS_META: Record<IAiToolCall['status'], IToolStatusMeta> = {
  pending: {
    label: '等待中',
    detail: '等待确认',
    icon: Clock3,
  },
  running: {
    label: '运行中',
    detail: '正在执行',
    icon: LoaderCircle,
  },
  succeeded: {
    label: '已完成',
    detail: '结果已返回',
    icon: CheckCircle2,
  },
  failed: {
    label: '失败',
    detail: '执行失败',
    icon: CircleAlert,
  },
  denied: {
    label: '已停止',
    detail: '已停止',
    icon: XCircle,
  },
};

const ACTIVITY_STATUS_TO_TOOL_STATUS: Record<TAgentActivityStatus, IAiToolCall['status']> = {
  pending: 'pending',
  running: 'running',
  success: 'succeeded',
  error: 'failed',
  cancelled: 'denied',
};

const ACTIVITY_KIND_ICON: Record<IAgentActivity['kind'], Component> = {
  run: Activity,
  search: Search,
  read_file: FileText,
  edit_file: Pencil,
  tool_call: Activity,
  command: Terminal,
  reasoning_summary: Activity,
  llm: Activity,
  error: CircleAlert,
};

const STATUS_PREFIX_PATTERN =
  /^(?:正在|已|等待|调用失败|已拒绝|Agent\s*)\s*(?:读取|搜索|加载|使用|应用|生成|验证|执行|运行|检索|分析|暂存|提交|调用|完成)?\s*[:：]?\s*/u;

const GENERIC_TARGET_PREFIX_PATTERN =
  /^(?:当前文件|当前选区|项目内容|文件名|符号|诊断|Git\s*变更|终端日志|网页|Patch|测试|命令|Git\s*暂存|Git\s*提交|文件|打开文件|package scripts|测试目标|工作区)\s*[:：]?\s*/iu;

const GENERIC_TARGET_VALUES = new Set([
  '文件',
  '项目',
  '项目结构',
  '工作区',
  '资源',
  '网页',
  '任务',
  '命令',
  '测试',
  '变更',
]);

const getActionKind = (toolName: string): TToolActionKind =>
  TOOL_ACTION_BY_NAME[toolName] ?? 'unknown';

const normalizeText = (value: string): string =>
  value
    .replace(/…$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();

const stripTargetNoise = (value: string): string => {
  const withoutStatus = normalizeText(value).replace(STATUS_PREFIX_PATTERN, '').trim();
  const withoutGenericPrefix = withoutStatus.replace(GENERIC_TARGET_PREFIX_PATTERN, '').trim();

  return withoutGenericPrefix || withoutStatus;
};

const isUrlLike = (value: string): boolean => /^https?:\/\//iu.test(value);

const isFileLikeTarget = (value: string): boolean =>
  /[\\/]/u.test(value) || /\.[a-z0-9]{1,12}(?::|#L|\s*$)/iu.test(value);

const formatLineRange = (start: string, end: string | undefined): string =>
  end && end !== start ? `L${start}-${end}` : `L${start}`;

const parseTarget = (value: string): { target: string; lineRange: string | null } => {
  const target = normalizeText(value);

  if (!target || isUrlLike(target)) {
    return {
      target,
      lineRange: null,
    };
  }

  const hashLineMatch = target.match(/^(.+?)#L(\d+)(?:-L?(\d+))?$/u);
  if (hashLineMatch?.[1] && hashLineMatch[2] && isFileLikeTarget(hashLineMatch[1])) {
    return {
      target: hashLineMatch[1].trim(),
      lineRange: formatLineRange(hashLineMatch[2], hashLineMatch[3]),
    };
  }

  const colonLineMatch = target.match(/^(.+):(\d+)(?:-(\d+))?$/u);
  if (colonLineMatch?.[1] && colonLineMatch[2] && isFileLikeTarget(colonLineMatch[1])) {
    return {
      target: colonLineMatch[1].trim(),
      lineRange: formatLineRange(colonLineMatch[2], colonLineMatch[3]),
    };
  }

  return {
    target,
    lineRange: null,
  };
};

const MACHINE_PREVIEW_PATTERN =
  /(?:^\s*(?:\{|\[|\[object\s+Object\])|"?toolResult"?\s*:|"?content"?\s*:\s*\[|"?result"?\s*:\s*(?:\{|\[))/iu;

const isMachinePreview = (value: string): boolean =>
  MACHINE_PREVIEW_PATTERN.test(normalizeText(value));

const getTargetSource = (toolCall: IAiToolCall, fallbackTarget: string): string => {
  const targetPreview = toolCall.targetPreview?.trim();

  if (targetPreview && !isMachinePreview(targetPreview)) {
    return targetPreview;
  }

  const summaryTarget = stripTargetNoise(toolCall.summary);
  if (
    summaryTarget &&
    !isMachinePreview(summaryTarget) &&
    (isFileLikeTarget(summaryTarget) || isUrlLike(summaryTarget))
  ) {
    return summaryTarget;
  }

  return fallbackTarget;
};

const getDetailPreview = (
  summary: string,
  target: string,
  statusDetail: string,
): string | null => {
  const preview = normalizeText(summary);
  const strippedPreview = stripTargetNoise(preview);
  const normalizedTarget = normalizeText(target);

  if (
    !preview ||
    strippedPreview === normalizedTarget ||
    preview === statusDetail ||
    isMachinePreview(preview)
  ) {
    return null;
  }

  return strippedPreview || preview;
};

const getActionLabel = (toolName: string, actionMeta: IToolActionMeta): string =>
  TOOL_DISPLAY_BY_NAME[toolName] ?? actionMeta.verb;

const isGenericTarget = (target: string, fallbackTarget: string): boolean =>
  target === fallbackTarget || GENERIC_TARGET_VALUES.has(target);

const hasLeafLabel = (items: readonly string[], label: string): boolean =>
  items.some((item) => item.startsWith(`${label}：`));

const getTargetLeafLabel = (
  actionKind: TToolActionKind,
  target: string,
  fallbackTarget: string,
  existingDetails: readonly string[],
): string | null => {
  if (!target || isGenericTarget(target, fallbackTarget) || isMachinePreview(target)) {
    return null;
  }

  if (actionKind === 'read' && !hasLeafLabel(existingDetails, '文件')) {
    return `文件：${target}`;
  }

  if (actionKind === 'tree' && !hasLeafLabel(existingDetails, '目录')) {
    return `目录：${target}`;
  }

  if (
    (actionKind === 'fileSearch' || actionKind === 'symbolSearch') &&
    !hasLeafLabel(existingDetails, '范围')
  ) {
    return `范围：${target}`;
  }

  if ((actionKind === 'web' || actionKind === 'webFetch') && !hasLeafLabel(existingDetails, '查询')) {
    return `目标：${target}`;
  }

  return `目标：${target}`;
};

const formatElapsed = (elapsedMs: number | undefined): string | null => {
  if (elapsedMs === undefined) {
    return null;
  }

  if (elapsedMs < 1000) {
    return `${elapsedMs}ms`;
  }

  return `${Math.max(1, Math.round(elapsedMs / 1000))}s`;
};

const uniqueStrings = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      return false;
    }

    seen.add(normalized);
    return true;
  });
};

const buildTimelineItem = (toolCall: IAiToolCall): IToolTimelineItem => {
  const actionKind = getActionKind(toolCall.name);
  const actionMeta = TOOL_ACTION_META[actionKind];
  const statusMeta = TOOL_STATUS_META[toolCall.status];
  const parsedTarget = parseTarget(stripTargetNoise(getTargetSource(toolCall, actionMeta.fallbackTarget)));
  const target = parsedTarget.target || actionMeta.fallbackTarget;
  const elapsed = formatElapsed(toolCall.elapsedMs);
  const actionLabel = getActionLabel(toolCall.name, actionMeta);
  const headline = `${actionLabel} · ${target}`;
  const preview = getDetailPreview(toolCall.summary, target, statusMeta.detail);
  const detailItems = uniqueStrings(toolCall.detailItems ?? [])
    .filter((item) => !isMachinePreview(item))
    .slice(0, 4);
  const lineRange = parsedTarget.lineRange;
  const metaItems = uniqueStrings([
    getTargetLeafLabel(actionKind, target, actionMeta.fallbackTarget, detailItems) ?? '',
    lineRange ? `位置：${lineRange}` : '',
    elapsed ? `耗时：${elapsed}` : '',
    preview ? `结果：${preview}` : '',
    detailItems.length || preview ? '' : `状态：${statusMeta.detail}`,
  ]);
  const leafItems = uniqueStrings([
    ...detailItems,
    ...metaItems,
  ]).slice(0, 7);

  return {
    ...toolCall,
    actionLabel,
    headline,
    statusLabel: statusMeta.label,
    target,
    preview,
    leafItems,
    lineRange,
    toolIcon: actionMeta.icon,
  };
};

const formatActivityDetail = (detail: IAgentActivityDetail): string =>
  `${detail.label}：${detail.value}`;

const buildActivityLeafItems = (activity: IAgentActivity): string[] => {
  const detailItems = (activity.details ?? [])
    .map(formatActivityDetail)
    .filter((item) => !isMachinePreview(item));
  const output = activity.outputSummary && !isMachinePreview(activity.outputSummary)
    ? `结果：${activity.outputSummary}`
    : '';
  const error = activity.error?.message ? `错误：${activity.error.message}` : '';
  const duration = formatElapsed(activity.durationMs);

  return uniqueStrings([
    ...detailItems,
    output,
    error,
    duration ? `耗时：${duration}` : '',
    detailItems.length || output || error ? '' : `状态：${TOOL_STATUS_META[
      ACTIVITY_STATUS_TO_TOOL_STATUS[activity.status]
    ].detail}`,
  ]).slice(0, 7);
};

const buildTimelineItemFromActivity = (activity: IAgentActivity): IToolTimelineItem => {
  const status = ACTIVITY_STATUS_TO_TOOL_STATUS[activity.status];
  const target = normalizeText(
    activity.description ?? activity.inputSummary ?? activity.outputSummary ?? '',
  );
  const fallbackTarget = activity.kind === 'search' ? '检索' : '任务';
  const displayTarget = target || fallbackTarget;
  const preview = activity.outputSummary ?? activity.error?.message ?? null;

  return {
    id: activity.id,
    name: activity.tool?.name ?? activity.kind,
    status,
    summary: activity.outputSummary ?? activity.description ?? activity.title,
    targetPreview: displayTarget,
    elapsedMs: activity.durationMs,
    actionLabel: activity.title,
    headline: target ? `${activity.title} · ${target}` : activity.title,
    statusLabel: TOOL_STATUS_META[status].label,
    target: displayTarget,
    preview,
    leafItems: buildActivityLeafItems(activity),
    lineRange: null,
    toolIcon: ACTIVITY_KIND_ICON[activity.kind],
  };
};

const resolvedActivities = computed(() => {
  if (props.activities?.length) {
    return props.activities;
  }

  if (props.activityEvents?.length) {
    return materializeAgentActivities(props.activityEvents);
  }

  return [];
});

const activityRoot = computed(() =>
  resolvedActivities.value.find((activity) => !activity.parentId) ?? null,
);

const activityChildren = computed(() => {
  const root = activityRoot.value;

  if (!root) {
    return [];
  }

  return resolvedActivities.value.filter((activity) => activity.parentId === root.id);
});

const items = computed(() => {
  if (activityRoot.value) {
    return activityChildren.value
      .filter((activity) => activity.kind !== 'reasoning_summary' && activity.kind !== 'llm')
      .map(buildTimelineItemFromActivity);
  }

  return props.toolCalls.map(buildTimelineItem);
});

const processItems = computed(() => {
  if (activityRoot.value) {
    return uniqueStrings(
      activityChildren.value
        .filter((activity) => activity.kind === 'reasoning_summary' || activity.kind === 'llm')
        .map((activity) => activity.description ?? activity.title),
    ).slice(-3);
  }

  const activityTitle = normalizeText(props.activityText ?? '');

  return uniqueStrings(props.activityTrail ?? [])
    .filter((item) => !isMachinePreview(item))
    .filter((item) => normalizeText(item) !== activityTitle)
    .slice(-2);
});

const getPrimaryItem = (timelineItems: readonly IToolTimelineItem[]): IToolTimelineItem | null => {
  const running = timelineItems.find((item) => item.status === 'running');
  if (running) {
    return running;
  }

  const failed = timelineItems.find((item) => item.status === 'failed');
  if (failed) {
    return failed;
  }

  return timelineItems[timelineItems.length - 1] ?? null;
};

const getGroupStatus = (timelineItems: readonly IToolTimelineItem[]): IAiToolCall['status'] => {
  if (timelineItems.some((item) => item.status === 'failed')) {
    return 'failed';
  }

  if (timelineItems.some((item) => item.status === 'running')) {
    return 'running';
  }

  if (timelineItems.some((item) => item.status === 'pending')) {
    return 'pending';
  }

  if (timelineItems.some((item) => item.status === 'denied')) {
    return 'denied';
  }

  return 'succeeded';
};

const activityRow = computed<IToolActivityRow | null>(() => {
  const root = activityRoot.value;
  if (root) {
    const status = ACTIVITY_STATUS_TO_TOOL_STATUS[root.status];
    const statusMeta = TOOL_STATUS_META[status];

    return {
      id: root.id,
      title: root.title,
      status,
      statusIcon: statusMeta.icon,
      isSpinning: status === 'running',
    };
  }

  const trimmedActivity = props.activityText?.trim();
  if (!trimmedActivity && !items.value.length) {
    return null;
  }

  const primaryItem = getPrimaryItem(items.value);
  const status = getGroupStatus(items.value);
  const statusMeta = TOOL_STATUS_META[status];

  return {
    id: 'current-activity',
    title: trimmedActivity || primaryItem?.headline || statusMeta.detail,
    status,
    statusIcon: statusMeta.icon,
    isSpinning: status === 'running',
  };
});
</script>

<template>
  <section v-if="activityRow" class="ai-tool-activity-inline ai-tool-run-timeline" :class="`is-${activityRow.status}`"
    aria-label="工具调用树">
    <ol class="ai-tool-tree">
      <li class="ai-tool-tree-node ai-tool-run-item ai-tool-run-current" :class="`is-${activityRow.status}`"
        aria-live="polite">
        <details class="ai-tool-node-details ai-tool-root-details" open>
          <summary class="ai-tool-tree-row ai-tool-tree-root-row">
            <span class="ai-tool-run-status-node">
              <component :is="activityRow.statusIcon" class="ai-tool-status-icon"
                :class="{ 'is-spinning': activityRow.isSpinning }" />
            </span>
            <span class="ai-tool-run-title" :title="activityRow.title">{{ activityRow.title }}</span>
            <ChevronRight class="ai-tool-run-chevron" aria-hidden="true" />
          </summary>

          <ol v-if="processItems.length || items.length" class="ai-tool-subtree ai-tool-tool-list">
            <li v-for="process in processItems" :key="`process:${process}`"
              class="ai-tool-tree-node ai-tool-detail-node ai-tool-process-node">
              <span class="ai-tool-leaf-dot" aria-hidden="true" />
              <span class="ai-tool-run-fact" :title="process">{{ process }}</span>
            </li>
            <li v-for="item in items" :key="item.id" class="ai-tool-tree-node ai-tool-run-item"
              :class="`is-${item.status}`">
              <details class="ai-tool-node-details">
                <summary class="ai-tool-tree-row ai-tool-run-summary">
                  <span class="ai-tool-run-dot" aria-hidden="true" />
                  <span class="ai-tool-run-main">
                    <component :is="item.toolIcon" class="ai-tool-kind-icon" aria-hidden="true" />
                    <span class="ai-tool-run-action">{{ item.actionLabel }}</span>
                    <span class="ai-tool-run-target" :title="item.target">{{ item.target }}</span>
                  </span>
                  <span class="ai-tool-run-status">{{ item.statusLabel }}</span>
                  <ChevronRight class="ai-tool-run-chevron" aria-hidden="true" />
                </summary>
                <ol class="ai-tool-subtree ai-tool-detail-list">
                  <li v-for="leaf in item.leafItems" :key="`${item.id}:leaf:${leaf}`"
                    class="ai-tool-tree-node ai-tool-detail-node">
                    <span class="ai-tool-leaf-dot" aria-hidden="true" />
                    <span class="ai-tool-run-fact" :title="leaf">{{ leaf }}</span>
                  </li>
                </ol>
              </details>
            </li>
          </ol>
        </details>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.ai-tool-run-timeline {
  width: min(100%, 640px);
  color: var(--text-tertiary);
  font-size: 13px;
  line-height: 20px;
}

.ai-tool-run-status-node {
  display: inline-flex;
  width: 20px;
  height: 20px;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--surface-panel);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--shell-divider) 78%, transparent);
}

.ai-tool-status-icon {
  width: 13px;
  height: 13px;
  color: var(--text-quaternary);
  stroke-width: 2;
}

.ai-tool-status-icon.is-spinning {
  animation: ai-tool-status-spin 900ms linear infinite;
  color: var(--text-secondary);
}

.ai-tool-run-title {
  min-width: 0;
  overflow: hidden;
  color: inherit;
  font-size: 14px;
  font-weight: 520;
  line-height: 22px;
  text-overflow: ellipsis;
  unicode-bidi: plaintext;
  white-space: nowrap;
}

.ai-tool-tree,
.ai-tool-subtree {
  display: grid;
  min-width: 0;
  list-style: none;
}

.ai-tool-tree {
  gap: 2px;
  margin: 0;
  padding: 0;
}

.ai-tool-subtree {
  gap: 3px;
  margin: 5px 0 0 10px;
  border-left: 1px solid color-mix(in srgb, var(--shell-divider) 72%, transparent);
  padding: 3px 0 5px 16px;
}

.ai-tool-tree-node {
  position: relative;
  min-width: 0;
}

.ai-tool-run-item {
  padding: 6px 0;
  animation: ai-tool-row-enter 180ms cubic-bezier(0.23, 1, 0.32, 1) both;
}

.ai-tool-subtree>.ai-tool-tree-node::before {
  position: absolute;
  top: 16px;
  left: -16px;
  width: 12px;
  border-top: 1px solid color-mix(in srgb, var(--shell-divider) 72%, transparent);
  content: '';
}

.ai-tool-run-current {
  padding-top: 0;
}

.ai-tool-tree-row {
  display: grid;
  min-width: 0;
  align-items: center;
  column-gap: 7px;
}

.ai-tool-tree-root-row {
  grid-template-columns: 20px minmax(0, 1fr) 14px;
  min-height: 30px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  list-style: none;
  transition:
    background-color 140ms cubic-bezier(0.23, 1, 0.32, 1),
    color 140ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-tool-tree-root-row::-webkit-details-marker,
.ai-tool-run-summary::-webkit-details-marker {
  display: none;
}

.ai-tool-run-dot {
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: var(--text-quaternary);
}

.ai-tool-leaf-dot {
  width: 3px;
  height: 3px;
  margin-top: 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-quaternary) 72%, transparent);
}

.ai-tool-run-summary {
  grid-template-columns: 9px minmax(0, 1fr) auto 14px;
  min-height: 28px;
  gap: 7px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  list-style: none;
  padding: 1px 2px 1px 0;
  transition:
    background-color 140ms cubic-bezier(0.23, 1, 0.32, 1),
    color 140ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-tool-run-main {
  display: grid;
  min-width: 0;
  grid-template-columns: auto auto minmax(0, 1fr);
  align-items: center;
  gap: 7px;
}

.ai-tool-kind-icon {
  width: 13px;
  height: 13px;
  color: var(--text-quaternary);
  stroke-width: 1.9;
}

.ai-tool-run-action {
  color: var(--text-secondary);
  font-weight: 520;
  white-space: nowrap;
}

.ai-tool-run-target {
  min-width: 0;
  overflow: hidden;
  color: var(--text-tertiary);
  text-overflow: ellipsis;
  unicode-bidi: plaintext;
  white-space: nowrap;
}

.ai-tool-run-status {
  color: var(--text-quaternary);
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
}

.ai-tool-run-fact {
  max-width: 100%;
  overflow: hidden;
  border-radius: var(--radius-sm);
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 19px;
  text-overflow: ellipsis;
  unicode-bidi: plaintext;
  white-space: nowrap;
}

.ai-tool-detail-list {
  margin-top: 4px;
}

.ai-tool-detail-node {
  display: grid;
  min-width: 0;
  grid-template-columns: 7px minmax(0, 1fr);
  column-gap: 8px;
  padding: 2px 0;
}

.ai-tool-run-timeline.is-running .ai-tool-tree-root-row {
  color: var(--text-primary);
}

.ai-tool-run-timeline.is-succeeded .ai-tool-status-icon,
.ai-tool-run-current.is-succeeded .ai-tool-status-icon {
  color: var(--success);
}

.ai-tool-run-item.is-succeeded .ai-tool-run-dot {
  background: var(--success);
}

.ai-tool-run-timeline.is-failed .ai-tool-status-icon,
.ai-tool-run-current.is-failed .ai-tool-status-icon {
  color: var(--danger);
}

.ai-tool-run-item.is-failed .ai-tool-run-dot {
  background: var(--danger);
}

.ai-tool-run-item.is-failed .ai-tool-run-status {
  color: var(--danger);
}

.ai-tool-run-item.is-running .ai-tool-run-dot {
  background: var(--text-secondary);
}

.ai-tool-run-current.is-running .ai-tool-run-status-node {
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--shell-divider) 78%, transparent),
    0 0 0 4px color-mix(in srgb, var(--accent-strong) 8%, transparent);
}

.ai-tool-run-current.is-denied .ai-tool-status-icon,
.ai-tool-run-current.is-pending .ai-tool-status-icon {
  color: var(--text-quaternary);
}

.ai-tool-run-chevron {
  width: 13px;
  height: 13px;
  color: var(--text-quaternary);
  stroke-width: 2;
  transition: transform 140ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-tool-node-details[open]>.ai-tool-tree-row .ai-tool-run-chevron {
  transform: rotate(90deg);
}

@media (hover: hover) and (pointer: fine) {

  .ai-tool-tree-root-row:hover,
  .ai-tool-run-summary:hover {
    background: color-mix(in srgb, var(--surface-hover) 48%, transparent);
    color: var(--text-primary);
  }
}

.ai-tool-tree-root-row:focus-visible,
.ai-tool-run-summary:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent-strong) 46%, transparent);
  outline-offset: 2px;
}

@keyframes ai-tool-status-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes ai-tool-row-enter {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {

  .ai-tool-status-icon.is-spinning,
  .ai-tool-run-item,
  .ai-tool-run-chevron {
    animation: none;
    transition: none;
  }
}
</style>
