<script setup lang="ts">
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from '@/components/ai-elements/chain-of-thought';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Task, TaskContent, TaskItem } from '@/components/ai-elements/task';
import {
  classifyRuntimeToolKind,
  normalizeRuntimeToolName,
  type TAiRuntimeToolKind,
} from '@/constants/ai-runtime-tools';
import type { TAgentRuntimeEvent } from '@/types/agent-sidecar';
import {
  Activity,
  BookOpen,
  Brain,
  ChartColumn,
  CircleAlert,
  Clock3,
  Coffee,
  Dot,
  FileCode,
  FileText,
  Files,
  FolderTree,
  GitBranch,
  Globe,
  HardDrive,
  Image as ImageIcon,
  ListTodo,
  Pencil,
  Play,
  Search,
  Terminal,
  Workflow,
} from 'lucide-vue-next';
import { computed, type Component } from 'vue';

const REASONING_SEGMENT_CHARS = 420;
const PREVIEW_TAG_LIMIT = 96;
const MAX_TOOL_TAGS = 3;
const tokenNumberFormatter = new Intl.NumberFormat('zh-CN');

type TTaskIcon =
  | TAiRuntimeToolKind
  | 'file'
  | 'files'
  | 'folder'
  | 'patch'
  | 'globe'
  | 'play'
  | 'book'
  | 'chart'
  | 'brain'
  | 'image'
  | 'clock'
  | 'alert';

type TTaskStatus = 'pending' | 'running' | 'succeeded' | 'failed';

interface ITaskNodeItem {
  id: string;
  kind: TAiRuntimeToolKind;
  icon: TTaskIcon;
  toolName?: string;
  toolUseId?: string;
  resourceLabel?: string;
  suppressMeta?: boolean;
  webSearchSources?: IWebSearchSourceChip[];
  action: string;
  tags: string[];
  status: TTaskStatus;
  tail?: string;
}

interface IWebSearchSourceChip {
  url: string;
  host: string;
  displayUrl: string;
}

type TTimelineItem =
  | {
    type: 'reasoning';
    id: string;
    segments: string[];
    isLong: boolean;
  }
  | {
    type: 'event';
    id: string;
    text: string;
  }
  | {
    type: 'task';
    id: string;
    node: ITaskNodeItem;
  };

type TToolRuntimeEvent = Extract<
  TAgentRuntimeEvent,
  {
    type: 'agent.tool.started' | 'agent.tool.completed' | 'agent.tool.progress';
  }
>;

interface IToolIconMatcher {
  icon: TTaskIcon;
  patterns: RegExp[];
}

type TInlineMarkdownTokenKind = 'text' | 'strong' | 'emphasis' | 'code';
type TReasoningMarkdownBlockKind = 'paragraph' | 'heading' | 'unordered-list' | 'ordered-list' | 'quote';

interface IInlineMarkdownToken {
  kind: TInlineMarkdownTokenKind;
  text: string;
}

interface IReasoningMarkdownBlock {
  type: TReasoningMarkdownBlockKind;
  id: string;
  text?: string;
  items?: string[];
}

const props = withDefaults(defineProps<{
  events: TAgentRuntimeEvent[];
  isStreaming?: boolean;
}>(), {
  isStreaming: false,
});

const inlineMarkdownTokenCache = new Map<string, IInlineMarkdownToken[]>();
const reasoningMarkdownBlockCache = new Map<string, IReasoningMarkdownBlock[]>();

const TOOL_ICON_MATCHERS: readonly IToolIconMatcher[] = [
  {
    icon: 'folder',
    patterns: [
      /directory_tree/u,
      /list_directory/u,
      /list_workspace_entries/u,
      /list_project_files/u,
      /get_project_tree/u,
      /list_allowed_directories/u,
    ],
  },
  {
    icon: 'files',
    patterns: [
      /read_multiple_files/u,
      /copilot_getnotebooksummary/u,
    ],
  },
  {
    icon: 'image',
    patterns: [
      /view_image/u,
      /read_media_file/u,
    ],
  },
  {
    icon: 'file',
    patterns: [
      /read_file/u,
      /read_text_file/u,
      /read_current_file/u,
      /read_project_file/u,
      /read_selected_text/u,
      /get_file_info/u,
      /open_nodes/u,
      /mastra_list_logs/u,
    ],
  },
  {
    icon: 'patch',
    patterns: [
      /apply_patch/u,
      /edit_file/u,
      /propose_patch/u,
      /auto_apply_patch/u,
      /vscode_renamesymbol/u,
    ],
  },
  {
    icon: 'write',
    patterns: [
      /write_file/u,
      /create_file/u,
      /create_directory/u,
      /move_file/u,
      /delete_file/u,
      /create_new/u,
    ],
  },
  {
    icon: 'git',
    patterns: [
      /^git_/u,
      /get_git_/u,
      /github_repo/u,
      /stage_file/u,
      /create_commit/u,
    ],
  },
  {
    icon: 'book',
    patterns: [
      /query-docs/u,
      /query_docs/u,
      /docs/u,
    ],
  },
  {
    icon: 'play',
    patterns: [
      /^browser_/u,
      /browser_evaluate/u,
      /run_vscode_command/u,
      /create_and_run_task/u,
    ],
  },
  {
    icon: 'globe',
    patterns: [
      /browser_navigate/u,
      /open_browser_page/u,
      /fetch_webpage/u,
      /web_fetch/u,
      /tavily-extract/u,
      /tavily-crawl/u,
    ],
  },
  {
    icon: 'search',
    patterns: [
      /grep_search/u,
      /file_search/u,
      /semantic_search/u,
      /search_project_files/u,
      /search_text/u,
      /search_symbols/u,
      /search_files/u,
      /tavily/u,
      /web_search/u,
    ],
  },
  {
    icon: 'terminal',
    patterns: [
      /run_in_terminal/u,
      /run_shell_command/u,
      /run_command/u,
      /send_to_terminal/u,
      /get_terminal_output/u,
      /terminal_last_command/u,
      /terminal_selection/u,
    ],
  },
  {
    icon: 'chart',
    patterns: [
      /get_errors/u,
      /test_failure/u,
    ],
  },
  {
    icon: 'brain',
    patterns: [
      /sequentialthinking/u,
      /thinking/u,
      /reason/u,
    ],
  },
  {
    icon: 'task',
    patterns: [
      /manage_todo_list/u,
      /runsubagent/u,
      /vscode_askquestions/u,
    ],
  },
  {
    icon: 'clock',
    patterns: [
      /get_current_time/u,
      /convert_time/u,
      /time/u,
    ],
  },
  {
    icon: 'alert',
    patterns: [
      /debug_/u,
      /get_debug_/u,
      /stop_debug_session/u,
    ],
  },
  {
    icon: 'diagram',
    patterns: [
      /rendermermaiddiagram/u,
    ],
  },
  {
    icon: 'memory',
    patterns: [
      /^memory$/u,
      /read_graph/u,
      /search_nodes/u,
      /create_entities/u,
      /create_relations/u,
      /add_observations/u,
    ],
  },
];

const TASK_ICON_MAP: Record<TTaskIcon, Component> = {
  search: Search,
  read: FileText,
  write: Pencil,
  git: GitBranch,
  browser: Globe,
  terminal: Terminal,
  task: ListTodo,
  network: Globe,
  diagram: Workflow,
  symbol: FileCode,
  python: FileCode,
  java: Coffee,
  memory: HardDrive,
  thinking: Brain,
  system: Activity,
  file: FileText,
  files: Files,
  folder: FolderTree,
  patch: Pencil,
  globe: Globe,
  play: Play,
  book: BookOpen,
  chart: ChartColumn,
  brain: Brain,
  image: ImageIcon,
  clock: Clock3,
  alert: CircleAlert,
};

const createEventKey = (
  event: Pick<TAgentRuntimeEvent, 'id' | 'type'>,
  index: number,
): string => `${event.type}:${event.id}:${index}`;

const getStableRuntimeEvents = (events: readonly TAgentRuntimeEvent[]): TAgentRuntimeEvent[] => {
  const deduped = new Map<string, TAgentRuntimeEvent>();

  for (const event of events) {
    if (!deduped.has(event.id)) {
      deduped.set(event.id, event);
    }
  }

  return Array.from(deduped.values());
};

const splitReasoningSegments = (value: string): string[] => {
  const normalized = value.trim();

  if (!normalized) {
    return [];
  }

  const paragraphs = normalized
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const segments: string[] = [];

  for (const paragraph of paragraphs) {
    const chars = Array.from(paragraph);

    if (chars.length <= REASONING_SEGMENT_CHARS) {
      segments.push(paragraph);
      continue;
    }

    for (let cursor = 0; cursor < chars.length; cursor += REASONING_SEGMENT_CHARS) {
      segments.push(chars.slice(cursor, cursor + REASONING_SEGMENT_CHARS).join(''));
    }
  }

  return segments;
};

const clipTag = (value: string, limit = PREVIEW_TAG_LIMIT): string => {
  const normalized = value.replace(/\s+/gu, ' ').trim();

  if (!normalized) {
    return '';
  }

  const chars = Array.from(normalized);

  if (chars.length <= limit) {
    return normalized;
  }

  return `${chars.slice(0, limit).join('')}...`;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const collectPreviewTextCandidates = (
  value: unknown,
  output: string[],
  depth = 0,
): void => {
  if (output.length >= MAX_TOOL_TAGS || depth > 3) {
    return;
  }

  if (isNonEmptyString(value)) {
    output.push(clipTag(value));
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPreviewTextCandidates(item, output, depth + 1);
      if (output.length >= MAX_TOOL_TAGS) {
        return;
      }
    }
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  const record = value as Record<string, unknown>;
  const priorityKeys = [
    'query',
    'path',
    'filePath',
    'pattern',
    'url',
    'command',
    'title',
    'summary',
    'text',
    'content',
    'result',
    'toolResult',
  ];

  for (const key of priorityKeys) {
    collectPreviewTextCandidates(record[key], output, depth + 1);
    if (output.length >= MAX_TOOL_TAGS) {
      return;
    }
  }
};

const resolveRuntimeToolIcon = (
  toolName: string,
  fallbackKind: TAiRuntimeToolKind,
): TTaskIcon => {
  const normalized = normalizeRuntimeToolName(toolName).toLowerCase();

  for (const matcher of TOOL_ICON_MATCHERS) {
    if (matcher.patterns.some((pattern) => pattern.test(normalized))) {
      return matcher.icon;
    }
  }

  return fallbackKind;
};

const parsePreviewValue = (value: string | undefined): string[] => {
  if (!isNonEmptyString(value)) {
    return [];
  }

  const normalized = value.trim();

  try {
    const parsed: unknown = JSON.parse(normalized);

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const tags: string[] = [];
      collectPreviewTextCandidates(parsed, tags);

      if (tags.length > 0) {
        return tags;
      }
    }
  } catch {
    // 非 JSON 内容按原始文本预览处理。
  }

  const clipped = clipTag(normalized);
  return clipped ? [clipped] : [];
};

const parsePreviewRecord = (value: string | undefined): Record<string, unknown> | null => {
  if (!isNonEmptyString(value)) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(value.trim());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

const parsePreviewJson = (value: string | undefined): unknown | null => {
  if (!isNonEmptyString(value)) {
    return null;
  }

  try {
    return JSON.parse(value.trim()) as unknown;
  } catch {
    return null;
  }
};

const PREVIEW_PATH_KEYS = ['path', 'filePath', 'file_path', 'targetPath', 'target_path'] as const;

const WEB_SEARCH_TOOL_NAMES = new Set([
  'web_search',
  'tavily-search',
  'tavily_search',
  'tavily-map',
  'tavily_map',
  'tavily-research',
  'tavily_research',
]);

const READ_FILE_TOOL_NAMES = new Set([
  'read_text_file',
  'mastra_workspace_read_file',
]);

const WRITE_FILE_TOOL_NAMES = new Set([
  'write_file',
  'string_replace_lsp',
  'mastra_workspace_write_file',
  'mastra_workspace_edit_file',
]);

const WEB_SEARCH_SOURCE_URL_KEYS = [
  'url',
  'href',
  'link',
] as const;

const WEB_SEARCH_SOURCE_HOST_KEYS = [
  'domain',
  'domains',
  'site',
  'sites',
  'includeDomain',
  'include_domain',
  'includeDomains',
  'include_domains',
] as const;

const collectPreviewPathCandidate = (value: unknown, depth = 0): string | null => {
  if (depth > 4 || value == null) {
    return null;
  }

  if (isNonEmptyString(value)) {
    return value.trim();
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = collectPreviewPathCandidate(item, depth + 1);

      if (candidate) {
        return candidate;
      }
    }

    return null;
  }

  if (typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;

  for (const key of PREVIEW_PATH_KEYS) {
    const candidate = collectPreviewPathCandidate(record[key], depth + 1);

    if (candidate) {
      return candidate;
    }
  }

  for (const nestedValue of Object.values(record)) {
    const candidate = collectPreviewPathCandidate(nestedValue, depth + 1);

    if (candidate) {
      return candidate;
    }
  }

  return null;
};

const extractPathFromTextPreview = (value: string): string | null => {
  const normalized = value.trim();
  const windowsMatch = normalized.match(/[A-Za-z]:[\\/][^"'\n\r\t]+/u);

  if (windowsMatch?.[0]) {
    return windowsMatch[0].trim();
  }

  const unixMatch = normalized.match(/(?:^|[\s"'])((?:\.{1,2}[\\/]|[\\/])[^"]+?\.[A-Za-z0-9_-]{1,12})/u);

  if (unixMatch?.[1]) {
    return unixMatch[1].trim();
  }

  return null;
};

const resolvePreviewPath = (value: string | undefined): string | null => {
  const parsed = parsePreviewJson(value);
  const structuredCandidate = collectPreviewPathCandidate(parsed);

  if (structuredCandidate) {
    return structuredCandidate;
  }

  if (!isNonEmptyString(value)) {
    return null;
  }

  return extractPathFromTextPreview(value);
};

const resolveWebSearchQuery = (value: string | undefined): string | null => {
  const record = parsePreviewRecord(value);
  const candidate = record?.query;

  return isNonEmptyString(candidate) ? candidate.trim() : null;
};

const getHostname = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url.trim();
  }
};

const normalizeWebSearchHost = (host: string): string =>
  host.trim().toLowerCase().replace(/^www\./u, '');

const getDisplayWebSearchUrl = (url: string): string => {
  const host = normalizeWebSearchHost(getHostname(url));

  return host || url.trim();
};

const collectUrlsFromText = (value: string): string[] => {
  const matches = value.match(/https?:\/\/[^\s"'<>）)]+/giu);

  return matches?.map((url) => url.trim()).filter(Boolean) ?? [];
};

const pushWebSearchSource = (
  sources: IWebSearchSourceChip[],
  seen: Set<string>,
  rawUrl: string,
): void => {
  const url = rawUrl.trim();
  const host = normalizeWebSearchHost(getHostname(url));

  if (!url || !host || seen.has(url)) {
    return;
  }

  if (seen.has(host)) {
    return;
  }

  seen.add(url);
  seen.add(host);
  sources.push({
    url,
    host,
    displayUrl: getDisplayWebSearchUrl(url),
  });
};

const pushWebSearchHostSource = (
  sources: IWebSearchSourceChip[],
  seen: Set<string>,
  rawHost: string,
): void => {
  const host = normalizeWebSearchHost(rawHost);

  if (!host || host.includes('/') || host.includes(':') || seen.has(host)) {
    return;
  }

  seen.add(host);
  sources.push({
    url: host,
    host,
    displayUrl: host,
  });
};

const collectWebSearchSourcesFromValue = (
  value: unknown,
  sources: IWebSearchSourceChip[],
  seen: Set<string>,
  depth = 0,
): void => {
  if (depth > 5 || sources.length >= 6 || value == null) {
    return;
  }

  if (isNonEmptyString(value)) {
    for (const url of collectUrlsFromText(value)) {
      pushWebSearchSource(sources, seen, url);

      if (sources.length >= 6) {
        return;
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectWebSearchSourcesFromValue(item, sources, seen, depth + 1);

      if (sources.length >= 6) {
        return;
      }
    }
    return;
  }

  if (typeof value !== 'object') {
    return;
  }

  const record = value as Record<string, unknown>;

  for (const key of WEB_SEARCH_SOURCE_URL_KEYS) {
    const candidate = record[key];

    if (isNonEmptyString(candidate)) {
      pushWebSearchSource(sources, seen, candidate);

      if (sources.length >= 6) {
        return;
      }
    }
  }

  for (const key of WEB_SEARCH_SOURCE_HOST_KEYS) {
    const candidate = record[key];

    if (isNonEmptyString(candidate)) {
      pushWebSearchHostSource(sources, seen, candidate);
    } else if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (isNonEmptyString(item)) {
          pushWebSearchHostSource(sources, seen, item);
        }

        if (sources.length >= 6) {
          return;
        }
      }
    }

    if (sources.length >= 6) {
      return;
    }
  }

  for (const nestedValue of Object.values(record)) {
    collectWebSearchSourcesFromValue(nestedValue, sources, seen, depth + 1);

    if (sources.length >= 6) {
      return;
    }
  }
};

const resolveWebSearchSources = (value: string | undefined): IWebSearchSourceChip[] => {
  const parsed = parsePreviewJson(value);
  const seen = new Set<string>();
  const sources: IWebSearchSourceChip[] = [];

  collectWebSearchSourcesFromValue(parsed ?? value, sources, seen);

  return sources;
};

const mergeWebSearchSources = (
  ...groups: readonly (readonly IWebSearchSourceChip[] | undefined)[]
): IWebSearchSourceChip[] | undefined => {
  const seen = new Set<string>();
  const merged: IWebSearchSourceChip[] = [];

  for (const group of groups) {
    if (!group?.length) {
      continue;
    }

    for (const source of group) {
      pushWebSearchSource(merged, seen, source.url);

      if (merged.length >= 6) {
        return merged;
      }
    }
  }

  return merged.length ? merged : undefined;
};

const isWebSearchToolName = (toolName: string | undefined): boolean =>
  Boolean(toolName && (
    WEB_SEARCH_TOOL_NAMES.has(toolName)
    || /^tavily(?:-|_)/iu.test(toolName)
    || /(?:^|[_-])tavily(?:[_-]|$)/iu.test(toolName)
  ));

interface IToolActionDescriptor {
  action: string;
  resourceLabel?: string;
  suppressMeta?: boolean;
  webSearchSources?: IWebSearchSourceChip[];
}

const describeToolAction = (
  event: Extract<TToolRuntimeEvent, { type: 'agent.tool.started' | 'agent.tool.completed' }>,
  toolName: string,
  fallbackResourceLabel?: string,
): IToolActionDescriptor => {
  const resourceLabel = fallbackResourceLabel
    ?? resolvePreviewPath(event.type === 'agent.tool.started' ? event.inputPreview : event.resultPreview)
    ?? undefined;

  if (READ_FILE_TOOL_NAMES.has(toolName) && resourceLabel) {
    if (event.type === 'agent.tool.completed' && !event.ok) {
      return {
        action: `读取失败 ${resourceLabel}`,
        resourceLabel,
        suppressMeta: true,
      };
    }

    return {
      action: event.type === 'agent.tool.started'
        ? `正在读取 ${resourceLabel}`
        : `读取完成 ${resourceLabel}`,
      resourceLabel,
      suppressMeta: true,
    };
  }

  if (WRITE_FILE_TOOL_NAMES.has(toolName) && resourceLabel) {
    if (event.type === 'agent.tool.completed' && !event.ok) {
      return {
        action: `编辑失败 ${resourceLabel}`,
        resourceLabel,
        suppressMeta: true,
      };
    }

    return {
      action: event.type === 'agent.tool.started'
        ? `正在编辑 ${resourceLabel}`
        : `编辑完成 ${resourceLabel}`,
      resourceLabel,
      suppressMeta: true,
    };
  }

  if (toolName === 'get_current_time') {
    if (event.type === 'agent.tool.completed' && !event.ok) {
      return {
        action: '当前时间读取失败',
        suppressMeta: true,
      };
    }

    return {
      action: event.type === 'agent.tool.started'
        ? '正在读取当前时间'
        : '当前时间读取完成',
      suppressMeta: true,
    };
  }

  if (isWebSearchToolName(toolName)) {
    const query = resolveWebSearchQuery(event.type === 'agent.tool.started' ? event.inputPreview : undefined)
      ?? fallbackResourceLabel
      ?? undefined;
    const webSearchSources = resolveWebSearchSources(
      event.type === 'agent.tool.completed' ? event.resultPreview : event.inputPreview,
    );

    if (event.type === 'agent.tool.completed' && !event.ok) {
      return {
        action: 'Search Failed',
        resourceLabel: query,
        suppressMeta: true,
        webSearchSources,
      };
    }

    return {
      action: event.type === 'agent.tool.started'
        ? `Search for ${query ?? 'web results'}`
        : 'Complete Search',
      resourceLabel: query,
      suppressMeta: true,
      webSearchSources,
    };
  }

  return {
    action: event.type === 'agent.tool.started'
      ? `开始调用 ${toolName}`
      : `完成调用 ${toolName}`,
    resourceLabel,
  };
};

const describeRunEvent = (event: TAgentRuntimeEvent): string | null => {
  switch (event.type) {
    case 'agent.run.started':
      return null;

    case 'agent.run.completed':
      return null;

    case 'agent.run.error':
      return `Agent 执行失败：${event.errorMessage}`;

    case 'agent.model.started':
      return event.projectedInputTokensAvailable
        ? `模型调用开始，预计输入 token：${event.projectedInputTokens ?? 0}`
        : '模型调用开始';

    case 'agent.model.completed':
      return event.ok
        ? `模型调用完成${event.stopReason ? `（${event.stopReason}）` : ''}`
        : `模型调用失败：${event.errorMessage ?? '未知错误'}`;

    case 'acontext.token.checked':
      return event.projectedInputTokensAvailable
        ? `上下文预算检查，预计输入 token：${tokenNumberFormatter.format(event.projectedInputTokens ?? 0)}`
        : '上下文预算检查完成';

    case 'agent.text.delta':
    case 'agent.tool.progress':
      return null;

    case 'agent.message.added':
      return event.role ? `追加消息：${event.role}` : '已追加消息';

    case 'agent.debug':
      return event.name ? `调试事件：${event.name}` : null;

    default:
      return null;
  }
};

const isToolEvent = (event: TAgentRuntimeEvent): event is TToolRuntimeEvent =>
  event.type === 'agent.tool.started'
  || event.type === 'agent.tool.completed'
  || event.type === 'agent.tool.progress';

const createToolNode = (
  event: TToolRuntimeEvent,
  eventIndex: number,
  previousNode?: ITaskNodeItem,
): ITaskNodeItem => {
  const id = createEventKey(event, eventIndex);

  if (event.type === 'agent.tool.progress') {
    const webSearchSources = mergeWebSearchSources(
      previousNode?.webSearchSources,
      resolveWebSearchSources(event.dataPreview),
    );

    return {
      id: previousNode?.id ?? id,
      kind: previousNode?.kind ?? 'thinking',
      icon: previousNode?.icon ?? 'brain',
      toolName: previousNode?.toolName,
      toolUseId: previousNode?.toolUseId,
      resourceLabel: previousNode?.resourceLabel,
      suppressMeta: previousNode?.suppressMeta,
      webSearchSources,
      action: previousNode?.action ?? '工具执行中',
      tags: previousNode?.suppressMeta
        ? []
        : parsePreviewValue(event.dataPreview),
      status: 'running',
      tail: previousNode?.tail,
    };
  }

  const kind = classifyRuntimeToolKind(event.toolName);
  const toolName = normalizeRuntimeToolName(event.toolName);
  const icon = resolveRuntimeToolIcon(event.toolName, kind);
  const actionDescriptor = describeToolAction(event, toolName, previousNode?.resourceLabel);

  if (event.type === 'agent.tool.started') {
    return {
      id: previousNode?.id ?? id,
      kind,
      icon,
      toolName,
      toolUseId: event.toolUseId,
      resourceLabel: actionDescriptor.resourceLabel,
      suppressMeta: actionDescriptor.suppressMeta,
      webSearchSources: mergeWebSearchSources(
        previousNode?.webSearchSources,
        actionDescriptor.webSearchSources,
      ),
      action: actionDescriptor.action,
      tags: actionDescriptor.suppressMeta
        ? []
        : [toolName, ...parsePreviewValue(event.inputPreview)].slice(0, MAX_TOOL_TAGS),
      status: 'running',
      tail: actionDescriptor.suppressMeta ? undefined : '执行中',
    };
  }

  return {
    id: previousNode?.id ?? id,
    kind,
    icon,
    toolName,
    toolUseId: event.toolUseId ?? previousNode?.toolUseId,
    resourceLabel: actionDescriptor.resourceLabel,
    suppressMeta: actionDescriptor.suppressMeta,
    webSearchSources: mergeWebSearchSources(
      previousNode?.webSearchSources,
      actionDescriptor.webSearchSources,
    ),
    action: actionDescriptor.action,
    tags: actionDescriptor.suppressMeta
      ? []
      : [toolName, ...parsePreviewValue(event.resultPreview)].slice(0, MAX_TOOL_TAGS),
    status: event.ok ? 'succeeded' : 'failed',
    tail: actionDescriptor.suppressMeta
      ? undefined
      : event.ok
        ? '成功'
        : `失败：${event.errorMessage ?? '未知错误'}`,
  };
};

const findPendingToolTaskIndex = (
  items: readonly TTimelineItem[],
  event: Extract<TToolRuntimeEvent, { type: 'agent.tool.completed' }>,
): number => {
  const normalizedToolName = normalizeRuntimeToolName(event.toolName);

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];

    if (item.type !== 'task') {
      continue;
    }

    const { node } = item;

    if (node.status !== 'running' || !node.toolName) {
      continue;
    }

    if (event.toolUseId && node.toolUseId === event.toolUseId) {
      return index;
    }

    if (!event.toolUseId && node.toolName === normalizedToolName) {
      return index;
    }
  }

  return -1;
};

const findPendingWebSearchTaskIndex = (
  items: readonly TTimelineItem[],
): number => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];

    if (
      item.type === 'task'
      && item.node.status === 'running'
      && isWebSearchToolName(item.node.toolName)
    ) {
      return index;
    }
  }

  return -1;
};

const findAdjacentWebSearchTaskIndex = (
  items: readonly TTimelineItem[],
): number => {
  const item = items.at(-1);

  return item?.type === 'task' && isWebSearchToolName(item.node.toolName)
    ? items.length - 1
    : -1;
};

const buildTimelineItems = (events: readonly TAgentRuntimeEvent[]): TTimelineItem[] => {
  const stableEvents = getStableRuntimeEvents(events);
  const items: TTimelineItem[] = [];
  let reasoningBuffer = '';
  let reasoningBufferId = '';

  const getReasoningOverlapLength = (previous: string, incoming: string): number => {
    const maxLength = Math.min(previous.length, incoming.length);

    for (let length = maxLength; length > 0; length -= 1) {
      if (previous.slice(-length) === incoming.slice(0, length)) {
        return length;
      }
    }

    return 0;
  };

  const appendReasoningText = (incomingText: string): void => {
    if (!incomingText) {
      return;
    }

    if (!reasoningBuffer) {
      reasoningBuffer = incomingText;
      return;
    }

    if (incomingText.startsWith(reasoningBuffer)) {
      // Some providers stream cumulative snapshots (full text so far).
      reasoningBuffer = incomingText;
      return;
    }

    if (reasoningBuffer.startsWith(incomingText)) {
      // Ignore stale/shorter snapshot.
      return;
    }

    const overlapLength = getReasoningOverlapLength(reasoningBuffer, incomingText);
    reasoningBuffer += incomingText.slice(overlapLength);
  };

  const flushReasoningLine = (): void => {
    if (!reasoningBufferId || reasoningBuffer.length === 0) {
      return;
    }

    const segments = splitReasoningSegments(reasoningBuffer);

    if (segments.length > 0) {
      items.push({
        type: 'reasoning',
        id: `reasoning:${reasoningBufferId}`,
        segments,
        isLong: segments.length > 1,
      });
    }

    reasoningBuffer = '';
    reasoningBufferId = '';
  };

  stableEvents.forEach((event, eventIndex) => {
    if (event.type === 'agent.reasoning.delta') {
      if (!reasoningBufferId) {
        reasoningBufferId = createEventKey(event, eventIndex);
      }

      appendReasoningText(event.text);
      return;
    }

    if (event.type === 'agent.text.delta' || event.type === 'agent.debug') {
      return;
    }

    if (isToolEvent(event)) {
      flushReasoningLine();

      if (event.type === 'agent.tool.progress') {
        const pendingTaskIndex = findPendingWebSearchTaskIndex(items);

        if (pendingTaskIndex >= 0 && resolveWebSearchSources(event.dataPreview).length > 0) {
          const pendingTask = items[pendingTaskIndex];

          if (pendingTask.type === 'task') {
            pendingTask.node = createToolNode(event, eventIndex, pendingTask.node);
            return;
          }
        }
      }

      if (
        event.type === 'agent.tool.started'
        && isWebSearchToolName(normalizeRuntimeToolName(event.toolName))
      ) {
        const adjacentTaskIndex = findAdjacentWebSearchTaskIndex(items);

        if (adjacentTaskIndex >= 0) {
          const adjacentTask = items[adjacentTaskIndex];

          if (adjacentTask.type === 'task') {
            adjacentTask.node = createToolNode(event, eventIndex, adjacentTask.node);
            return;
          }
        }
      }

      if (event.type === 'agent.tool.completed') {
        const pendingTaskIndex = findPendingToolTaskIndex(items, event);

        if (pendingTaskIndex >= 0) {
          const pendingTask = items[pendingTaskIndex];

          if (pendingTask.type === 'task') {
            pendingTask.node = createToolNode(event, eventIndex, pendingTask.node);
            return;
          }
        }

        if (isWebSearchToolName(normalizeRuntimeToolName(event.toolName))) {
          const adjacentTaskIndex = findAdjacentWebSearchTaskIndex(items);

          if (adjacentTaskIndex >= 0) {
            const adjacentTask = items[adjacentTaskIndex];

            if (adjacentTask.type === 'task') {
              adjacentTask.node = createToolNode(event, eventIndex, adjacentTask.node);
              return;
            }
          }
        }
      }

      const node = createToolNode(event, eventIndex);
      items.push({
        type: 'task',
        id: `task:${node.id}`,
        node,
      });
      return;
    }

    const message = describeRunEvent(event);

    if (message) {
      flushReasoningLine();

      items.push({
        type: 'event',
        id: `event:${createEventKey(event, eventIndex)}`,
        text: message,
      });
    }
  });

  flushReasoningLine();

  return items;
};

const timelineItems = computed(() => buildTimelineItems(props.events));

const shouldRenderTimeline = computed(() =>
  timelineItems.value.length > 0 || props.isStreaming,
);

const chainHeaderLabel = computed(() => props.isStreaming ? '正在思考' : '思考完成');

const getTaskIcon = (node: ITaskNodeItem): Component =>
  TASK_ICON_MAP[node.icon];

const getFaviconSource = (host: string): string =>
  `http://favicon.localhost/${encodeURIComponent(host)}`;

const handleWebSourceIconError = (event: Event): void => {
  const target = event.target;

  if (!(target instanceof HTMLImageElement)) {
    return;
  }

  target.onerror = null;
  target.hidden = true;
  target.parentElement?.classList.add('is-fallback');
};

const getTaskStepStatus = (node: ITaskNodeItem): 'complete' | 'active' | 'pending' => {
  if (node.status === 'running') {
    return 'complete';
  }

  if (node.status === 'pending') {
    return 'pending';
  }

  return 'complete';
};

const shouldShowTaskStatus = (node: ITaskNodeItem): boolean =>
  node.status !== 'succeeded';

const pushInlineMarkdownToken = (
  tokens: IInlineMarkdownToken[],
  kind: TInlineMarkdownTokenKind,
  text: string,
): void => {
  if (!text) {
    return;
  }

  const previous = tokens.at(-1);
  if (previous?.kind === kind) {
    previous.text += text;
    return;
  }

  tokens.push({ kind, text });
};

const findNextSingleAsterisk = (value: string, startIndex: number): number => {
  for (let index = startIndex; index < value.length; index += 1) {
    if (value[index] !== '*') {
      continue;
    }

    if (value[index - 1] === '*' || value[index + 1] === '*') {
      continue;
    }

    return index;
  }

  return -1;
};

const tokenizeInlineMarkdown = (value: string): IInlineMarkdownToken[] => {
  const cached = inlineMarkdownTokenCache.get(value);
  if (cached) {
    return cached;
  }

  const tokens: IInlineMarkdownToken[] = [];
  let plainBuffer = '';
  let index = 0;

  const flushPlain = (): void => {
    pushInlineMarkdownToken(tokens, 'text', plainBuffer);
    plainBuffer = '';
  };

  while (index < value.length) {
    if (value[index] === '`') {
      const endIndex = value.indexOf('`', index + 1);
      if (endIndex > index + 1) {
        flushPlain();
        pushInlineMarkdownToken(tokens, 'code', value.slice(index + 1, endIndex));
        index = endIndex + 1;
        continue;
      }
    }

    if (value.startsWith('**', index)) {
      const endIndex = value.indexOf('**', index + 2);
      if (endIndex > index + 2) {
        flushPlain();
        pushInlineMarkdownToken(tokens, 'strong', value.slice(index + 2, endIndex));
        index = endIndex + 2;
        continue;
      }
    }

    if (value[index] === '*' && value[index + 1] !== '*' && value[index - 1] !== '*') {
      const endIndex = findNextSingleAsterisk(value, index + 1);
      if (endIndex > index + 1) {
        flushPlain();
        pushInlineMarkdownToken(tokens, 'emphasis', value.slice(index + 1, endIndex));
        index = endIndex + 1;
        continue;
      }
    }

    plainBuffer += value[index];
    index += 1;
  }

  flushPlain();

  if (inlineMarkdownTokenCache.size > 240) {
    inlineMarkdownTokenCache.clear();
  }

  inlineMarkdownTokenCache.set(value, tokens);
  return tokens;
};

const isReasoningHeadingLine = (line: string): boolean => {
  if (line.includes('://')) {
    return false;
  }

  if (/^\s{0,3}#{1,6}\s+\S/u.test(line)) {
    return true;
  }

  const trimmed = line.trim();
  return trimmed.length > 1 && trimmed.length <= 80 && /[:：]$/u.test(trimmed);
};

const normalizeReasoningHeadingText = (line: string): string =>
  line
    .trim()
    .replace(/^\s{0,3}#{1,6}\s+/u, '')
    .replace(/\s+#*\s*$/u, '');

const parseReasoningMarkdownBlocks = (segment: string): IReasoningMarkdownBlock[] => {
  const cached = reasoningMarkdownBlockCache.get(segment);
  if (cached) {
    return cached;
  }

  const blocks: IReasoningMarkdownBlock[] = [];
  const paragraphLines: string[] = [];
  let listType: 'ordered-list' | 'unordered-list' | undefined;
  let listItems: string[] = [];

  const pushBlock = (block: Omit<IReasoningMarkdownBlock, 'id'>): void => {
    blocks.push({
      ...block,
      id: `${blocks.length}:${block.type}`,
    });
  };

  const flushParagraph = (): void => {
    const text = paragraphLines.join('\n').trim();
    paragraphLines.length = 0;

    if (text) {
      pushBlock({ type: 'paragraph', text });
    }
  };

  const flushList = (): void => {
    if (listType && listItems.length > 0) {
      pushBlock({ type: listType, items: listItems });
    }

    listType = undefined;
    listItems = [];
  };

  const flushInlineBlocks = (): void => {
    flushParagraph();
    flushList();
  };

  for (const line of segment.replace(/\r\n?/gu, '\n').split('\n')) {
    const trimmed = line.trim();

    if (!trimmed) {
      flushInlineBlocks();
      continue;
    }

    const unorderedMatch = /^\s{0,3}[-*+]\s+(.+)$/u.exec(line);
    if (unorderedMatch) {
      flushParagraph();

      if (listType !== 'unordered-list') {
        flushList();
        listType = 'unordered-list';
      }

      listItems.push(unorderedMatch[1].trim());
      continue;
    }

    const orderedMatch = /^\s{0,3}\d+[.)]\s+(.+)$/u.exec(line);
    if (orderedMatch) {
      flushParagraph();

      if (listType !== 'ordered-list') {
        flushList();
        listType = 'ordered-list';
      }

      listItems.push(orderedMatch[1].trim());
      continue;
    }

    const quoteMatch = /^\s{0,3}>\s?(.+)$/u.exec(line);
    if (quoteMatch) {
      flushInlineBlocks();
      pushBlock({ type: 'quote', text: quoteMatch[1].trim() });
      continue;
    }

    if (isReasoningHeadingLine(line)) {
      flushInlineBlocks();
      pushBlock({ type: 'heading', text: normalizeReasoningHeadingText(line) });
      continue;
    }

    flushList();
    paragraphLines.push(line);
  }

  flushInlineBlocks();

  if (reasoningMarkdownBlockCache.size > 240) {
    reasoningMarkdownBlockCache.clear();
  }

  reasoningMarkdownBlockCache.set(segment, blocks);
  return blocks;
};
</script>

<template>
  <ChainOfThought
v-if="shouldRenderTimeline" class="ai-runtime-timeline" default-open
    aria-label="Agent Chain of Thought">
    <ChainOfThoughtHeader class="ai-runtime-chain-header">
      <Shimmer v-if="isStreaming" as="span" class="ai-runtime-chain-label ai-runtime-chain-label--thinking">
        {{ chainHeaderLabel }}
      </Shimmer>
      <span v-else class="ai-runtime-chain-label ai-runtime-chain-label--done">
        {{ chainHeaderLabel }}
      </span>
    </ChainOfThoughtHeader>

    <ChainOfThoughtContent class="ai-runtime-chain-content">
      <template v-for="item in timelineItems" :key="item.id">
        <ChainOfThoughtStep
v-if="item.type === 'reasoning'" class="ai-runtime-step is-reasoning" label="Reasoning"
          status="complete">
          <template #icon>
            <Dot class="ai-runtime-step-icon" aria-hidden="true" />
          </template>

          <div class="agent-line">
            <template v-for="(segment, segmentIndex) in item.segments" :key="`${item.id}:segment:${segmentIndex}`">
              <template
v-for="block in parseReasoningMarkdownBlocks(segment)"
                :key="`${item.id}:segment:${segmentIndex}:block:${block.id}`">
                <p v-if="block.type === 'paragraph'" class="agent-line__segment agent-line__paragraph">
                  <template
v-for="(token, tokenIndex) in tokenizeInlineMarkdown(block.text ?? '')"
                    :key="`${item.id}:segment:${segmentIndex}:block:${block.id}:token:${tokenIndex}`">
                    <strong v-if="token.kind === 'strong'" class="agent-line__strong">{{ token.text }}</strong>
                    <em v-else-if="token.kind === 'emphasis'" class="agent-line__emphasis">{{ token.text }}</em>
                    <code v-else-if="token.kind === 'code'" class="agent-line__code">{{ token.text }}</code>
                    <span v-else>{{ token.text }}</span>
                  </template>
                </p>

                <p v-else-if="block.type === 'heading'" class="agent-line__segment agent-line__heading">
                  <template
v-for="(token, tokenIndex) in tokenizeInlineMarkdown(block.text ?? '')"
                    :key="`${item.id}:segment:${segmentIndex}:block:${block.id}:token:${tokenIndex}`">
                    <strong v-if="token.kind === 'strong'" class="agent-line__strong">{{ token.text }}</strong>
                    <em v-else-if="token.kind === 'emphasis'" class="agent-line__emphasis">{{ token.text }}</em>
                    <code v-else-if="token.kind === 'code'" class="agent-line__code">{{ token.text }}</code>
                    <span v-else>{{ token.text }}</span>
                  </template>
                </p>

                <blockquote v-else-if="block.type === 'quote'" class="agent-line__segment agent-line__quote">
                  <template
v-for="(token, tokenIndex) in tokenizeInlineMarkdown(block.text ?? '')"
                    :key="`${item.id}:segment:${segmentIndex}:block:${block.id}:token:${tokenIndex}`">
                    <strong v-if="token.kind === 'strong'" class="agent-line__strong">{{ token.text }}</strong>
                    <em v-else-if="token.kind === 'emphasis'" class="agent-line__emphasis">{{ token.text }}</em>
                    <code v-else-if="token.kind === 'code'" class="agent-line__code">{{ token.text }}</code>
                    <span v-else>{{ token.text }}</span>
                  </template>
                </blockquote>

                <ol v-else-if="block.type === 'ordered-list'" class="agent-line__segment agent-line__list">
                  <li
v-for="(entry, entryIndex) in block.items ?? []"
                    :key="`${segmentIndex}:${block.id}:entry:${entryIndex}`">
                    <template
v-for="(token, tokenIndex) in tokenizeInlineMarkdown(entry)"
                      :key="`${item.id}:segment:${segmentIndex}:block:${block.id}:entry:${entryIndex}:token:${tokenIndex}`">
                      <strong v-if="token.kind === 'strong'" class="agent-line__strong">{{ token.text }}</strong>
                      <em v-else-if="token.kind === 'emphasis'" class="agent-line__emphasis">{{ token.text }}</em>
                      <code v-else-if="token.kind === 'code'" class="agent-line__code">{{ token.text }}</code>
                      <span v-else>{{ token.text }}</span>
                    </template>
                  </li>
                </ol>

                <ul v-else class="agent-line__segment agent-line__list">
                  <li
v-for="(entry, entryIndex) in block.items ?? []"
                    :key="`${segmentIndex}:${block.id}:entry:${entryIndex}`">
                    <template
v-for="(token, tokenIndex) in tokenizeInlineMarkdown(entry)"
                      :key="`${item.id}:segment:${segmentIndex}:block:${block.id}:entry:${entryIndex}:token:${tokenIndex}`">
                      <strong v-if="token.kind === 'strong'" class="agent-line__strong">{{ token.text }}</strong>
                      <em v-else-if="token.kind === 'emphasis'" class="agent-line__emphasis">{{ token.text }}</em>
                      <code v-else-if="token.kind === 'code'" class="agent-line__code">{{ token.text }}</code>
                      <span v-else>{{ token.text }}</span>
                    </template>
                  </li>
                </ul>
              </template>
            </template>
          </div>
        </ChainOfThoughtStep>

        <ChainOfThoughtStep
v-else-if="item.type === 'event'" class="ai-runtime-step is-event" :label="item.text"
          status="complete">
          <template #icon>
            <Activity class="ai-runtime-step-icon" aria-hidden="true" />
          </template>
        </ChainOfThoughtStep>

        <ChainOfThoughtStep
v-else class="ai-runtime-step is-task" :label="item.node.action"
          :status="getTaskStepStatus(item.node)">
          <template #icon>
            <component
:is="getTaskIcon(item.node)" class="ai-runtime-step-icon" :class="`is-icon-${item.node.icon}`"
              aria-hidden="true" />
          </template>

          <Task
v-if="item.node.tags.length || item.node.tail || item.node.webSearchSources?.length"
            class="ai-runtime-task">
            <TaskContent
v-if="item.node.tags.length || item.node.tail || item.node.webSearchSources?.length"
              class="ai-runtime-task-content"
              :class="{ 'has-web-search-sources': item.node.webSearchSources?.length }">
              <div v-if="item.node.webSearchSources?.length" class="ai-runtime-web-search-sources">
                <div
v-for="source in item.node.webSearchSources" :key="`${item.node.id}:source:${source.url}`"
                  class="ai-runtime-web-source-pill" :title="source.url">
                  <span class="ai-runtime-web-source-icon-wrap" aria-hidden="true">
                    <img
class="ai-runtime-web-source-icon" :src="getFaviconSource(source.host)" alt="" loading="lazy"
                      decoding="async" @error="handleWebSourceIconError" />
                    <Globe class="ai-runtime-web-source-icon-fallback" />
                  </span>
                  <span class="ai-runtime-web-source-label">{{ source.displayUrl }}</span>
                </div>
              </div>

              <ChainOfThoughtSearchResults v-if="item.node.tags.length" class="ai-runtime-task-search-results">
                <ChainOfThoughtSearchResult
v-for="tag in item.node.tags" :key="`${item.node.id}:tag:${tag}`"
                  class="ai-runtime-task-file" :title="tag">
                  {{ tag }}
                </ChainOfThoughtSearchResult>
              </ChainOfThoughtSearchResults>

              <TaskItem
v-if="shouldShowTaskStatus(item.node) && item.node.tail" class="ai-runtime-task-item"
                :class="`is-${item.node.status}`">
                {{ item.node.tail }}
              </TaskItem>
            </TaskContent>
          </Task>
        </ChainOfThoughtStep>
      </template>
    </ChainOfThoughtContent>
  </ChainOfThought>
</template>

<style scoped>
.ai-runtime-timeline {
  max-width: min(100%, 760px);
  padding: 4px 0 2px;
  color: var(--text-tertiary);
  font-size: 14px;
  line-height: 20px;
}

.ai-runtime-chain-header {
  min-height: 24px;
  color: var(--text-tertiary);
  font-size: 14px;
  line-height: 20px;
}

.ai-runtime-chain-header:hover {
  color: var(--text-primary);
}

.ai-runtime-chain-label {
  display: inline-flex;
  align-items: center;
  min-width: 0;
}

.ai-runtime-chain-label--thinking {
  font-weight: 500;
}

.ai-runtime-chain-label--done {
  color: inherit;
}

.ai-runtime-chain-content {
  max-width: min(100%, 720px);
}

.ai-runtime-step {
  min-width: 0;
}

.ai-runtime-step :deep(.space-y-2) {
  min-width: 0;
}

.ai-runtime-step-icon {
  width: 16px;
  height: 16px;
  color: currentColor;
  stroke-width: 2;
}

.agent-line {
  color: currentColor;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.agent-line__segment {
  margin: 0;
}

.agent-line__segment+.agent-line__segment {
  margin-top: 6px;
}

.agent-line__heading {
  color: var(--text-secondary);
  font-weight: 650;
}

.agent-line__list {
  list-style-position: outside;
  margin-bottom: 0;
  margin-left: 0;
  padding-left: 18px;
  white-space: normal;
}

.agent-line__list li {
  min-width: 0;
  padding-left: 2px;
  white-space: pre-wrap;
}

.agent-line__list li+li {
  margin-top: 3px;
}

.agent-line__list li::marker {
  color: var(--text-tertiary);
}

.agent-line__quote {
  border-left: 2px solid color-mix(in srgb, var(--shell-divider) 82%, transparent);
  color: var(--text-secondary);
  padding-left: 10px;
}

.agent-line__strong {
  color: inherit;
  font-weight: 650;
}

.agent-line__emphasis {
  color: inherit;
  font-style: italic;
}

.agent-line__code {
  border: 1px solid color-mix(in srgb, var(--shell-divider) 76%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--surface-soft) 84%, transparent);
  color: inherit;
  font-family: var(--font-mono);
  font-size: 0.92em;
  padding: 0 4px;
}

.ai-runtime-task {
  min-width: 0;
}

.ai-runtime-task-content :deep(> div) {
  margin-top: 0;
  border-left-width: 0;
  padding-left: 24px;
}

.ai-runtime-task-content.has-web-search-sources :deep(> div) {
  padding-left: 0;
}

.ai-runtime-task-item {
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.ai-runtime-task-item.is-failed {
  color: color-mix(in srgb, var(--danger) 84%, var(--text-tertiary));
}

.ai-runtime-web-search-sources {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.ai-runtime-web-source-pill {
  display: inline-flex;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  gap: 6px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 72%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface-soft) 88%, transparent);
  color: var(--text-secondary);
  padding: 3px 10px;
}

.ai-runtime-web-source-icon-wrap {
  display: inline-flex;
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
}

.ai-runtime-web-source-icon,
.ai-runtime-web-source-icon-fallback {
  width: 16px;
  height: 16px;
}

.ai-runtime-web-source-icon {
  display: block;
  border-radius: var(--radius-sm);
}

.ai-runtime-web-source-icon-fallback {
  display: none;
  stroke-width: 2;
}

.ai-runtime-web-source-icon-wrap.is-fallback .ai-runtime-web-source-icon-fallback {
  display: block;
}

.ai-runtime-web-source-label {
  min-width: 0;
  overflow-wrap: anywhere;
  unicode-bidi: plaintext;
  white-space: normal;
}

.ai-runtime-task-file {
  max-width: min(560px, 72vw);
  overflow: hidden;
  text-overflow: ellipsis;
  unicode-bidi: plaintext;
  white-space: nowrap;
}
</style>
