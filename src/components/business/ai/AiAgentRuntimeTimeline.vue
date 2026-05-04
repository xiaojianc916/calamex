<script setup lang="ts">
import { computed, ref } from 'vue';
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css';



import {
  classifyRuntimeToolKind,
  normalizeRuntimeToolName,
  type TAiRuntimeToolKind,
} from '@/constants/ai-runtime-tools';
import type { TAgentRuntimeEvent } from '@/types/agent-sidecar';

const REASONING_SEGMENT_CHARS = 420;
const PREVIEW_TAG_LIMIT = 96;
const MAX_TOOL_TAGS = 3;

type TTreeNodeIcon =
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

interface ITreeNodeItem {
  id: string;
  kind: TAiRuntimeToolKind;
  icon: TTreeNodeIcon;
  action: string;
  tags: string[];
  tail?: string;
  isThinking?: boolean;
}

type TTimelineItem =
  | {
    type: 'line';
    id: string;
    text: string;
    segments: string[];
    isLong: boolean;
  }
  | {
    type: 'muted';
    id: string;
    text: string;
  }
  | {
    type: 'tree';
    id: string;
    nodes: ITreeNodeItem[];
  };

type TToolRuntimeEvent = Extract<
  TAgentRuntimeEvent,
  {
    type: 'agent.tool.started' | 'agent.tool.completed' | 'agent.tool.progress';
  }
>;

interface IToolIconMatcher {
  icon: TTreeNodeIcon;
  patterns: RegExp[];
}

const props = defineProps<{
  events: TAgentRuntimeEvent[];
}>();

const collapsedReasoningMap = ref<Record<string, boolean>>({});

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
      /log_anomalies/u,
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

const isReasoningCollapsed = (itemId: string): boolean =>
  Boolean(collapsedReasoningMap.value[itemId]);

const toggleReasoningCollapsed = (itemId: string): void => {
  collapsedReasoningMap.value = {
    ...collapsedReasoningMap.value,
    [itemId]: !isReasoningCollapsed(itemId),
  };
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
): TTreeNodeIcon => {
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
    const parsed = JSON.parse(normalized) as unknown;

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

const describeRunEvent = (event: TAgentRuntimeEvent): string | null => {
  switch (event.type) {
    case 'agent.run.started':
      return '已开始执行 Agent 流程';

    case 'agent.run.completed':
      return event.stopReason ? `Agent 执行完成（${event.stopReason}）` : 'Agent 执行完成';

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

    case 'agent.text.delta':
      return null;

    case 'agent.message.added':
      return event.role ? `追加消息：${event.role}` : '已追加消息';

    case 'agent.tool.progress':
      return null;

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

const createToolNode = (event: TToolRuntimeEvent, eventIndex: number): ITreeNodeItem => {
  const id = createEventKey(event, eventIndex);

  if (event.type === 'agent.tool.progress') {
    return {
      id,
      kind: 'thinking',
      icon: 'brain',
      action: '工具执行中',
      tags: parsePreviewValue(event.dataPreview),
      isThinking: true,
    };
  }

  const kind = classifyRuntimeToolKind(event.toolName);
  const toolName = normalizeRuntimeToolName(event.toolName);
  const icon = resolveRuntimeToolIcon(event.toolName, kind);

  if (event.type === 'agent.tool.started') {
    return {
      id,
      kind,
      icon,
      action: `开始调用 ${toolName}`,
      tags: [toolName, ...parsePreviewValue(event.inputPreview)].slice(0, MAX_TOOL_TAGS),
      tail: '执行中',
    };
  }

  return {
    id,
    kind,
    icon,
    action: `完成调用 ${toolName}`,
    tags: [toolName, ...parsePreviewValue(event.resultPreview)].slice(0, MAX_TOOL_TAGS),
    tail: event.ok ? '成功' : `失败：${event.errorMessage ?? '未知错误'}`,
  };
};

const buildTimelineItems = (events: readonly TAgentRuntimeEvent[]): TTimelineItem[] => {
  const stableEvents = getStableRuntimeEvents(events);
  const items: TTimelineItem[] = [];
  let toolNodesBuffer: ITreeNodeItem[] = [];
  let reasoningBuffer = '';
  let reasoningBufferId = '';

  const flushToolNodes = (): void => {
    if (toolNodesBuffer.length === 0) {
      return;
    }

    items.push({
      type: 'tree',
      id: `tree:${toolNodesBuffer[0]?.id ?? String(items.length)}`,
      nodes: toolNodesBuffer,
    });

    toolNodesBuffer = [];
  };

  const flushReasoningLine = (): void => {
    if (!reasoningBufferId || reasoningBuffer.length === 0) {
      return;
    }

    const segments = splitReasoningSegments(reasoningBuffer);

    if (segments.length > 0) {
      items.push({
        type: 'line',
        id: `line:${reasoningBufferId}`,
        text: reasoningBuffer,
        segments,
        isLong: segments.length > 1,
      });
    }

    reasoningBuffer = '';
    reasoningBufferId = '';
  };

  stableEvents.forEach((event, eventIndex) => {
    if (event.type === 'agent.reasoning.delta') {
      flushToolNodes();

      if (!reasoningBufferId) {
        reasoningBufferId = createEventKey(event, eventIndex);
      }

      reasoningBuffer += event.text ?? '';
      return;
    }

    if (event.type === 'agent.text.delta' || event.type === 'agent.debug') {
      return;
    }

    if (isToolEvent(event)) {
      flushReasoningLine();
      toolNodesBuffer.push(createToolNode(event, eventIndex));
      return;
    }

    const message = describeRunEvent(event);

    if (message) {
      flushReasoningLine();
      flushToolNodes();

      items.push({
        type: 'muted',
        id: `muted:${createEventKey(event, eventIndex)}`,
        text: message,
      });
    }
  });

  flushReasoningLine();
  flushToolNodes();

  return items;
};

const timelineItems = computed(() => buildTimelineItems(props.events));
</script>

<template>
  <section v-if="timelineItems.length > 0" class="ai-runtime-timeline" aria-label="Agent 活动树">
    <template v-for="item in timelineItems" :key="item.id">
      <div v-if="item.type === 'line'" class="agent-line">
        <p
v-for="(segment, segmentIndex) in (
          isReasoningCollapsed(item.id)
            ? item.segments.slice(0, 1)
            : item.segments
        )" :key="`${item.id}:segment:${segmentIndex}`" class="agent-line__segment">
          {{ segment }}
        </p>

        <button v-if="item.isLong" type="button" class="agent-line__toggle" @click="toggleReasoningCollapsed(item.id)">
          {{ isReasoningCollapsed(item.id) ? '展开全部推理' : '收起长推理' }}
        </button>
      </div>

      <p v-else-if="item.type === 'muted'" class="agent-line muted">
        {{ item.text }}
      </p>

      <div v-else class="activity-tree">
        <div v-for="node in item.nodes" :key="node.id" class="tree-node" :class="`${node.kind}-node`">
          <div class="node-icon" :class="[`icon-${node.icon}`, { thinking: node.isThinking }]">
            <svg
v-if="node.icon === 'search'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>

            <svg
v-else-if="node.icon === 'file'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
              <path d="M8 13h8" />
              <path d="M8 17h5" />
            </svg>

            <svg
v-else-if="node.icon === 'files'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <path d="M16 2H8a2 2 0 0 0-2 2v12" />
              <path d="M8 6h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6" />
              <path d="M10 12h6" />
              <path d="M10 16h4" />
            </svg>

            <svg
v-else-if="node.icon === 'folder'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v3" />
              <path d="M3 8v10a2 2 0 0 0 2 2h6" />
              <path d="M15 13v6" />
              <path d="M15 16h4" />
              <circle cx="19" cy="16" r="2" />
            </svg>

            <svg
v-else-if="node.icon === 'read'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <rect x="2" y="7" width="20" height="14" rx="2" />
              <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
            </svg>

            <svg
v-else-if="node.icon === 'write'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>

            <svg
v-else-if="node.icon === 'patch'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <path d="M4 7h16" />
              <path d="M4 17h16" />
              <path d="M8 12h8" />
              <path d="M12 8v8" />
            </svg>

            <svg
v-else-if="node.icon === 'git'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M8 12h8" />
              <path d="M12 8v8" />
            </svg>

            <svg
v-else-if="node.icon === 'browser'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path
d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3
                15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>

            <svg
v-else-if="node.icon === 'globe'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20" />
              <path d="M12 2a15 15 0 0 1 0 20" />
              <path d="M12 2a15 15 0 0 0 0 20" />
            </svg>

            <svg
v-else-if="node.icon === 'play'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <polygon points="10 8 16 12 10 16 10 8" />
            </svg>

            <svg
v-else-if="node.icon === 'book'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z" />
              <path d="M8 7h8" />
              <path d="M8 11h6" />
            </svg>

            <svg
v-else-if="node.icon === 'terminal'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m7 9 3 3-3 3" />
              <line x1="13" y1="15" x2="17" y2="15" />
            </svg>

            <svg
v-else-if="node.icon === 'chart'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <path d="M3 3v18h18" />
              <rect x="7" y="12" width="3" height="5" rx="1" />
              <rect x="12" y="8" width="3" height="9" rx="1" />
              <rect x="17" y="5" width="3" height="12" rx="1" />
            </svg>

            <svg
v-else-if="node.icon === 'task'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <path d="M9 11l2 2 4-4" />
              <path d="M9 17h6" />
              <rect x="4" y="3" width="16" height="18" rx="2" />
            </svg>

            <svg
v-else-if="node.icon === 'network'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20" />
              <path d="M12 2a15 15 0 0 1 0 20" />
              <path d="M12 2a15 15 0 0 0 0 20" />
            </svg>

            <svg
v-else-if="node.icon === 'diagram'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="6" height="6" rx="1" />
              <rect x="15" y="3" width="6" height="6" rx="1" />
              <rect x="9" y="15" width="6" height="6" rx="1" />
              <path d="M9 6h6" />
              <path d="M12 9v6" />
            </svg>

            <svg
v-else-if="node.icon === 'symbol'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <path d="M8 4 3 12l5 8" />
              <path d="m16 4 5 8-5 8" />
              <path d="m14 9-4 6" />
            </svg>

            <svg
v-else-if="node.icon === 'python'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <path d="M12 3h4a3 3 0 0 1 3 3v3H8a3 3 0 0 0-3 3v1" />
              <path d="M12 21H8a3 3 0 0 1-3-3v-3h11a3 3 0 0 0 3-3v-1" />
              <path d="M9 6h.01" />
              <path d="M15 18h.01" />
            </svg>

            <svg
v-else-if="node.icon === 'java'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <path d="M8 18h8" />
              <path d="M7 22h10" />
              <path d="M7 10h10v3a5 5 0 0 1-10 0v-3Z" />
              <path d="M17 11h1a2 2 0 0 1 0 4h-1" />
              <path d="M10 2c1.5 1.5-1 2.5.5 4" />
              <path d="M14 2c1.5 1.5-1 2.5.5 4" />
            </svg>

            <svg
v-else-if="node.icon === 'memory'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <rect x="5" y="5" width="14" height="14" rx="2" />
              <path d="M9 9h6v6H9z" />
              <path d="M9 1v4" />
              <path d="M15 1v4" />
              <path d="M9 19v4" />
              <path d="M15 19v4" />
              <path d="M1 9h4" />
              <path d="M1 15h4" />
              <path d="M19 9h4" />
              <path d="M19 15h4" />
            </svg>

            <svg
v-else-if="node.icon === 'brain'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <path d="M8 6a3 3 0 0 1 5-2 3 3 0 0 1 5 2 3 3 0 0 1 1 5 3 3 0 0 1-2 5" />
              <path d="M8 6a3 3 0 0 0-1 5 3 3 0 0 0 2 5" />
              <path d="M12 4v16" />
              <path d="M8 20h8" />
            </svg>

            <svg
v-else-if="node.icon === 'image'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <circle cx="8.5" cy="9" r="1.5" />
              <path d="m21 15-4.5-4.5L7 20" />
            </svg>

            <svg
v-else-if="node.icon === 'clock'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            </svg>

            <svg
v-else-if="node.icon === 'alert'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
            </svg>

            <svg
v-else-if="node.icon === 'thinking'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <path d="M9 18h6" />
              <path d="M10 22h4" />
              <path
d="M12 2a7 7 0 0 0-4 12.8V16a2 2 0 0 0 2 2h4a2
                2 0 0 0 2-2v-1.2A7 7 0 0 0 12 2Z" />
            </svg>

            <svg
v-else-if="node.icon === 'system'" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <path d="M4 6h16" />
              <path d="M4 12h16" />
              <path d="M4 18h16" />
              <circle cx="9" cy="6" r="2" />
              <circle cx="15" cy="12" r="2" />
              <circle cx="11" cy="18" r="2" />
            </svg>

            <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4" />
              <path d="M12 16h.01" />
            </svg>
          </div>

          <div class="node-content">
            <span>{{ node.action }}</span>

            <span v-for="(tag, tagIndex) in node.tags" :key="`${node.id}:tag:${tagIndex}:${tag}`" class="code-tag">
              {{ tag }}
            </span>

            <span v-if="node.tail">，{{ node.tail }}</span>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.ai-runtime-timeline {
  flex: 0 0 auto;
  padding: 8px 12px 4px;
  color: #e5e7eb;
  font-size: 14px;
  line-height: 1.7;
}

.agent-line {
  margin: 0 0 8px;
  color: #e5e7eb;
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

.agent-line__toggle {
  margin-top: 6px;
  border: 0;
  border-radius: 6px;
  background: #1f2937;
  background: color-mix(in srgb, #1f2937 86%, transparent);
  padding: 2px 8px;
  color: #9ca3af;
  font-size: 12px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
}

.agent-line__toggle:hover {
  color: #d1d5db;
}

.agent-line__toggle:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}

.agent-line.muted {
  margin: 3px 0 10px;
  color: #9ca3af;
  font-size: 13px;
}

.activity-tree {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0 0 14px 12px;
}

.tree-node {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.tree-node::before {
  content: '';
  position: absolute;
  left: 12px;
  top: 19px;
  bottom: -10px;
  z-index: 1;
  width: 1px;
  background-color: #4b5563;
}

.tree-node:last-child::before {
  display: none;
}

.node-icon {
  position: relative;
  z-index: 2;
  display: flex;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  color: #9ca3af;
}

.node-icon.thinking {
  animation: pulse 1.2s infinite alternate;
}

.node-content {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding-top: 1px;
  color: #e5e7eb;
}

.code-tag {
  display: inline-flex;
  max-width: min(560px, 72vw);
  align-items: center;
  overflow: hidden;
  border-radius: 6px;
  background-color: #1f2937;
  padding: 2px 8px;
  color: #d1d5db;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-node .node-icon {
  color: #a78bfa;
}

.read-node .node-icon {
  color: #60a5fa;
}

.write-node .node-icon {
  color: #34d399;
}

.git-node .node-icon {
  color: #f87171;
}

.browser-node .node-icon {
  color: #38bdf8;
}

.terminal-node .node-icon {
  color: #fbbf24;
}

.task-node .node-icon {
  color: #c084fc;
}

.network-node .node-icon {
  color: #2dd4bf;
}

.diagram-node .node-icon {
  color: #f472b6;
}

.symbol-node .node-icon {
  color: #818cf8;
}

.python-node .node-icon {
  color: #facc15;
}

.java-node .node-icon {
  color: #fb7185;
}

.memory-node .node-icon {
  color: #22c55e;
}

.thinking-node .node-icon {
  color: #fbbf24;
}

.system-node .node-icon {
  color: #94a3b8;
}

.node-icon.icon-file,
.node-icon.icon-files {
  color: #60a5fa;
}

.node-icon.icon-folder {
  color: #93c5fd;
}

.node-icon.icon-patch {
  color: #34d399;
}

.node-icon.icon-globe {
  color: #38bdf8;
}

.node-icon.icon-play {
  color: #22d3ee;
}

.node-icon.icon-book {
  color: #c084fc;
}

.node-icon.icon-chart {
  color: #fb923c;
}

.node-icon.icon-brain {
  color: #fbbf24;
}

.node-icon.icon-image {
  color: #f472b6;
}

.node-icon.icon-clock {
  color: #2dd4bf;
}

.node-icon.icon-alert {
  color: #f87171;
}

@keyframes pulse {
  0% {
    opacity: 0.6;
  }

  100% {
    opacity: 1;
  }
}
</style>
