<script setup lang="ts">
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from '@/components/ai-elements/chain-of-thought';
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
import { computed, ref, type Component } from 'vue';

const REASONING_SEGMENT_CHARS = 420;
const PREVIEW_TAG_LIMIT = 96;
const MAX_TOOL_TAGS = 3;

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
  action: string;
  tags: string[];
  status: TTaskStatus;
  tail?: string;
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

const props = withDefaults(defineProps<{
  events: TAgentRuntimeEvent[];
  isStreaming?: boolean;
}>(), {
  isStreaming: false,
});

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

const createToolNode = (event: TToolRuntimeEvent, eventIndex: number): ITaskNodeItem => {
  const id = createEventKey(event, eventIndex);

  if (event.type === 'agent.tool.progress') {
    return {
      id,
      kind: 'thinking',
      icon: 'brain',
      action: '工具执行中',
      tags: parsePreviewValue(event.dataPreview),
      status: 'running',
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
      status: 'running',
      tail: '执行中',
    };
  }

  return {
    id,
    kind,
    icon,
    action: `完成调用 ${toolName}`,
    tags: [toolName, ...parsePreviewValue(event.resultPreview)].slice(0, MAX_TOOL_TAGS),
    status: event.ok ? 'succeeded' : 'failed',
    tail: event.ok ? '成功' : `失败：${event.errorMessage ?? '未知错误'}`,
  };
};

const buildTimelineItems = (events: readonly TAgentRuntimeEvent[]): TTimelineItem[] => {
  const stableEvents = getStableRuntimeEvents(events);
  const items: TTimelineItem[] = [];
  let reasoningBuffer = '';
  let reasoningBufferId = '';

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

      reasoningBuffer += event.text;
      return;
    }

    if (event.type === 'agent.text.delta' || event.type === 'agent.debug') {
      return;
    }

    if (isToolEvent(event)) {
      flushReasoningLine();
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

const getTaskIcon = (node: ITaskNodeItem): Component =>
  TASK_ICON_MAP[node.icon];

const getTaskStepStatus = (node: ITaskNodeItem): 'complete' | 'active' | 'pending' => {
  if (node.status === 'running') {
    return 'active';
  }

  if (node.status === 'pending') {
    return 'pending';
  }

  return 'complete';
};

const shouldShowTaskStatus = (node: ITaskNodeItem): boolean =>
  node.status !== 'succeeded';
</script>

<template>
  <ChainOfThought
    v-if="timelineItems.length > 0"
    class="ai-runtime-timeline"
    default-open
    aria-label="Agent Chain of Thought"
  >
    <ChainOfThoughtHeader class="ai-runtime-chain-header" />

    <ChainOfThoughtContent class="ai-runtime-chain-content">
      <template v-for="item in timelineItems" :key="item.id">
        <ChainOfThoughtStep
          v-if="item.type === 'reasoning'"
          class="ai-runtime-step is-reasoning"
          label="Reasoning"
          status="complete"
        >
          <template #icon>
            <Dot class="ai-runtime-step-icon" aria-hidden="true" />
          </template>

          <div class="agent-line">
            <p
              v-for="(segment, segmentIndex) in (
                isReasoningCollapsed(item.id)
                  ? item.segments.slice(0, 1)
                  : item.segments
              )"
              :key="`${item.id}:segment:${segmentIndex}`"
              class="agent-line__segment"
            >
              {{ segment }}
            </p>

            <button
              v-if="item.isLong"
              type="button"
              class="agent-line__toggle"
              @click="toggleReasoningCollapsed(item.id)"
            >
              {{ isReasoningCollapsed(item.id) ? '展开全部推理' : '收起长推理' }}
            </button>
          </div>
        </ChainOfThoughtStep>

        <ChainOfThoughtStep
          v-else-if="item.type === 'event'"
          class="ai-runtime-step is-event"
          :label="item.text"
          status="complete"
        >
          <template #icon>
            <Activity class="ai-runtime-step-icon" aria-hidden="true" />
          </template>
        </ChainOfThoughtStep>

        <ChainOfThoughtStep
          v-else
          class="ai-runtime-step is-task"
          :label="item.node.action"
          :status="getTaskStepStatus(item.node)"
        >
          <template #icon>
            <component
              :is="getTaskIcon(item.node)"
              class="ai-runtime-step-icon"
              :class="`is-icon-${item.node.icon}`"
              aria-hidden="true"
            />
          </template>

          <Task v-if="item.node.tags.length || item.node.tail" class="ai-runtime-task">
            <TaskContent v-if="item.node.tags.length || item.node.tail" class="ai-runtime-task-content">
              <ChainOfThoughtSearchResults v-if="item.node.tags.length" class="ai-runtime-task-search-results">
                <ChainOfThoughtSearchResult
                  v-for="tag in item.node.tags"
                  :key="`${item.node.id}:tag:${tag}`"
                  class="ai-runtime-task-file"
                  :title="tag"
                >
                  {{ tag }}
                </ChainOfThoughtSearchResult>
              </ChainOfThoughtSearchResults>

              <TaskItem
                v-if="shouldShowTaskStatus(item.node) && item.node.tail"
                class="ai-runtime-task-item"
                :class="`is-${item.node.status}`"
              >
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

.agent-line__segment + .agent-line__segment {
  margin-top: 6px;
}

.agent-line__toggle {
  margin-top: 6px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--surface-soft);
  padding: 2px 8px;
  color: var(--text-quaternary);
  font-size: 12px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
}

.agent-line__toggle:hover {
  color: var(--text-primary);
}

.agent-line__toggle:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent-strong) 46%, transparent);
  outline-offset: 2px;
}

.ai-runtime-task {
  min-width: 0;
}

.ai-runtime-task-content :deep(> div) {
  margin-top: 0;
  border-left-width: 1px;
  border-color: var(--border);
  padding-left: 24px;
}

.ai-runtime-task-item {
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.ai-runtime-task-item.is-failed {
  color: color-mix(in srgb, var(--danger) 84%, var(--text-tertiary));
}

.ai-runtime-task-file {
  max-width: min(560px, 72vw);
  overflow: hidden;
  text-overflow: ellipsis;
  unicode-bidi: plaintext;
  white-space: nowrap;
}

</style>
