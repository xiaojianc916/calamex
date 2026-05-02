import type {
  IAgentActivity,
  IAgentActivityDeltaEvent,
  IAgentActivityDetail,
  IAgentActivitySnapshotEvent,
  TAgentActivityEvent,
  TAgentActivityKind,
  TAgentActivityStatus,
} from '@/types/agent-activity';
import type { IAiToolCall } from '@/types/ai';
import { clipTextPreview, normalizePreviewText } from '@/utils/text-preview';

export interface IBuildAgentActivitiesFromSidecarStateOptions {
  runId: string;
  rootTitle: string;
  status: TAgentActivityStatus;
  toolCalls: readonly IAiToolCall[];
  activityTrail?: readonly string[];
}

const DETAIL_SEPARATOR_PATTERN = /[:：]/u;
const WEB_TOOL_NAME_PATTERN = /(?:web|tavily)/iu;
const FILE_SEARCH_TOOL_NAME_PATTERN = /(?:search_(?:project_)?files|search_text|search_symbols)/iu;
const DIRECTORY_TOOL_NAME_PATTERN = /(?:list_directory|directory_tree|get_project_tree|list_project_files)/iu;
const FILE_READ_TOOL_NAME_PATTERN = /(?:read_|get_file_info|open_nodes)/iu;
const FILE_MUTATION_TOOL_NAME_PATTERN = /(?:write_file|edit_file|create_directory|move_file|delete_file|patch)/iu;
const COMMAND_TOOL_NAME_PATTERN = /(?:run_|shell|command|install_package)/iu;
const GIT_TOOL_NAME_PATTERN = /(?:^git_|get_git_|create_commit|stage_file)/iu;
const MAX_ACTIVITY_TITLE_GRAPHEMES = 96;
const MAX_ACTIVITY_DETAIL_GRAPHEMES = 120;
const MAX_ACTIVITY_DETAILS = 6;
const ACTIVITY_ROOT_ID_SUFFIX = 'activity-root';

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

const DETAIL_PRIORITY_BY_LABEL: Readonly<Record<string, number>> = {
  查询: 100,
  搜索: 96,
  站点: 88,
  平台: 82,
  网址: 80,
  文件: 78,
  目录: 76,
  范围: 72,
  命令: 70,
  结果: 50,
  状态: 30,
  信息: 20,
};

const normalizeActivityText = (value: string): string =>
  normalizePreviewText(value);

const clipActivityText = (value: string, maxGraphemes = MAX_ACTIVITY_TITLE_GRAPHEMES): string =>
  clipTextPreview(value, { maxGraphemes });

const uniqueDetails = (details: readonly IAgentActivityDetail[]): IAgentActivityDetail[] => {
  const seen = new Set<string>();
  const result: IAgentActivityDetail[] = [];

  for (const detail of details) {
    const label = normalizeActivityText(detail.label);
    const value = normalizeActivityText(detail.value);
    const identity = `${label}\u0000${value}`;

    if (!label || !value || seen.has(identity)) {
      continue;
    }

    seen.add(identity);
    result.push({
      label,
      value,
      ...(detail.priority !== undefined ? { priority: detail.priority } : {}),
    });
  }

  return result
    .sort((left, right) => (right.priority ?? 1) - (left.priority ?? 1))
    .slice(0, MAX_ACTIVITY_DETAILS);
};

const createDetail = (
  label: string,
  value: string | null | undefined,
): IAgentActivityDetail | null => {
  const normalizedLabel = normalizeActivityText(label);
  const normalizedValue = normalizeActivityText(value ?? '');

  if (!normalizedLabel || !normalizedValue) {
    return null;
  }

  return {
    label: normalizedLabel,
    value: clipActivityText(normalizedValue, MAX_ACTIVITY_DETAIL_GRAPHEMES),
    priority: DETAIL_PRIORITY_BY_LABEL[normalizedLabel] ?? 1,
  };
};

const parseDetailItem = (item: string): IAgentActivityDetail | null => {
  const normalized = normalizeActivityText(item);

  if (!normalized) {
    return null;
  }

  const separatorIndex = normalized.search(DETAIL_SEPARATOR_PATTERN);
  if (separatorIndex <= 0) {
    return createDetail('信息', normalized);
  }

  return createDetail(
    normalized.slice(0, separatorIndex),
    normalized.slice(separatorIndex + 1),
  );
};

const createStableTextHash = (value: string): string => {
  let hash = 5381;

  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }

    hash = ((hash << 5) + hash + codePoint) >>> 0;
  }

  return hash.toString(36);
};

const mapToolStatusToActivityStatus = (status: IAiToolCall['status']): TAgentActivityStatus => {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'running':
      return 'running';
    case 'succeeded':
      return 'success';
    case 'failed':
      return 'error';
    case 'denied':
      return 'cancelled';
  }
};

const inferToolActivityKind = (toolName: string): TAgentActivityKind => {
  if (FILE_SEARCH_TOOL_NAME_PATTERN.test(toolName) || WEB_TOOL_NAME_PATTERN.test(toolName)) {
    return 'search';
  }

  if (FILE_READ_TOOL_NAME_PATTERN.test(toolName) || DIRECTORY_TOOL_NAME_PATTERN.test(toolName)) {
    return 'read_file';
  }

  if (FILE_MUTATION_TOOL_NAME_PATTERN.test(toolName)) {
    return 'edit_file';
  }

  if (COMMAND_TOOL_NAME_PATTERN.test(toolName) || GIT_TOOL_NAME_PATTERN.test(toolName)) {
    return 'command';
  }

  return 'tool_call';
};

const getToolActivityTitle = (toolName: string): string => {
  const explicitTitle = TOOL_DISPLAY_BY_NAME[toolName];

  if (explicitTitle) {
    return explicitTitle;
  }

  if (WEB_TOOL_NAME_PATTERN.test(toolName)) {
    return '联网搜索';
  }

  if (FILE_SEARCH_TOOL_NAME_PATTERN.test(toolName)) {
    return '文件搜索';
  }

  if (DIRECTORY_TOOL_NAME_PATTERN.test(toolName)) {
    return '查看目录';
  }

  if (FILE_READ_TOOL_NAME_PATTERN.test(toolName)) {
    return '查看文件';
  }

  if (FILE_MUTATION_TOOL_NAME_PATTERN.test(toolName)) {
    return '修改文件';
  }

  if (COMMAND_TOOL_NAME_PATTERN.test(toolName)) {
    return '执行命令';
  }

  if (GIT_TOOL_NAME_PATTERN.test(toolName)) {
    return '查看 Git 信息';
  }

  return '处理任务';
};

const hasDetailValue = (
  details: readonly IAgentActivityDetail[],
  label: string,
  value: string,
): boolean =>
  details.some((detail) => detail.label === label && detail.value === value);

const getToolTarget = (toolCall: IAiToolCall): string | null => {
  const target = normalizeActivityText(toolCall.targetPreview ?? '');
  if (target) {
    return clipActivityText(target);
  }

  const summary = normalizeActivityText(toolCall.summary);

  return summary ? clipActivityText(summary) : null;
};

const buildToolActivityDetails = (
  toolCall: IAiToolCall,
  target: string | null,
): IAgentActivityDetail[] => {
  const parsedDetails = (toolCall.detailItems ?? [])
    .map(parseDetailItem)
    .filter((detail): detail is IAgentActivityDetail => Boolean(detail));
  const summary = normalizeActivityText(toolCall.summary);
  const summaryDetail = summary && summary !== target && !hasDetailValue(parsedDetails, '结果', summary)
    ? createDetail('结果', summary)
    : null;

  return uniqueDetails([
    ...parsedDetails,
    ...(summaryDetail ? [summaryDetail] : []),
  ]);
};

const createProcessActivity = (
  runId: string,
  parentId: string,
  text: string,
  index: number,
  status: TAgentActivityStatus,
): IAgentActivity | null => {
  const title = clipActivityText(text);

  if (!title) {
    return null;
  }

  return {
    id: `${runId}:summary:${index}:${createStableTextHash(title)}`,
    runId,
    parentId,
    kind: 'reasoning_summary',
    status: status === 'running' ? 'running' : 'success',
    title,
  };
};

const createToolActivity = (
  runId: string,
  parentId: string,
  toolCall: IAiToolCall,
): IAgentActivity => {
  const title = getToolActivityTitle(toolCall.name);
  const target = getToolTarget(toolCall);
  const details = buildToolActivityDetails(toolCall, target);

  return {
    id: `${runId}:tool:${toolCall.id}`,
    runId,
    kind: inferToolActivityKind(toolCall.name),
    status: mapToolStatusToActivityStatus(toolCall.status),
    title,
    ...(target ? { description: target, inputSummary: target } : {}),
    ...(details.length ? { details } : {}),
    tool: {
      callId: toolCall.id,
      name: toolCall.name,
    },
  };
};

const cloneJsonValue = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item)) as T;
  }

  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .reduce<Record<string, unknown>>((result, [key, item]) => {
        result[key] = cloneJsonValue(item);
        return result;
      }, {}) as T;
  }

  return value;
};

const cloneActivity = (activity: IAgentActivity): IAgentActivity =>
  cloneJsonValue(activity);

const cloneEvent = (event: TAgentActivityEvent): TAgentActivityEvent =>
  cloneJsonValue(event);

const normalizeComparableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeComparableValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = normalizeComparableValue((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  }

  return value;
};

const areActivityValuesEqual = (left: unknown, right: unknown): boolean => {
  if (left === undefined && right === undefined) {
    return true;
  }

  if (left === undefined || right === undefined) {
    return false;
  }

  return JSON.stringify(normalizeComparableValue(left))
    === JSON.stringify(normalizeComparableValue(right));
};

const escapeJsonPointerSegment = (segment: string): string =>
  segment.replace(/~/gu, '~0').replace(/\//gu, '~1');

const unescapeJsonPointerSegment = (segment: string): string =>
  segment.replace(/~1/gu, '/').replace(/~0/gu, '~');

const toActivityType = (kind: TAgentActivityKind): IAgentActivitySnapshotEvent['activityType'] =>
  kind.toUpperCase() as IAgentActivitySnapshotEvent['activityType'];

const setPointerValue = (
  target: Record<string, unknown> | unknown[],
  pointer: string,
  value: unknown,
): void => {
  const segments = pointer
    .split('/')
    .slice(1)
    .map(unescapeJsonPointerSegment);

  if (segments.length === 0) {
    return;
  }

  let current: Record<string, unknown> | unknown[] = target;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const nextSegment = segments[index + 1];

    if (segment === undefined || nextSegment === undefined) {
      return;
    }

    if (Array.isArray(current)) {
      const arrayIndex = Number.parseInt(segment, 10);
      const nextValue = current[arrayIndex];

      if (nextValue && typeof nextValue === 'object') {
        current = nextValue as Record<string, unknown> | unknown[];
        continue;
      }

      const created = /^\d+$/u.test(nextSegment) ? [] : {};
      current[arrayIndex] = created;
      current = created;
      continue;
    }

    const existing = current[segment];

    if (existing && typeof existing === 'object') {
      current = existing as Record<string, unknown> | unknown[];
      continue;
    }

    const created = /^\d+$/u.test(nextSegment) ? [] : {};
    current[segment] = created;
    current = created;
  }

  const lastSegment = segments.at(-1);

  if (!lastSegment) {
    return;
  }

  if (Array.isArray(current)) {
    const arrayIndex = Number.parseInt(lastSegment, 10);
    current[arrayIndex] = cloneJsonValue(value);
    return;
  }

  current[lastSegment] = cloneJsonValue(value);
};

const removePointerValue = (
  target: Record<string, unknown> | unknown[],
  pointer: string,
): void => {
  const segments = pointer
    .split('/')
    .slice(1)
    .map(unescapeJsonPointerSegment);

  if (segments.length === 0) {
    return;
  }

  let current: Record<string, unknown> | unknown[] = target;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];

    if (segment === undefined) {
      return;
    }

    if (Array.isArray(current)) {
      const arrayIndex = Number.parseInt(segment, 10);
      const nextValue = current[arrayIndex];

      if (!nextValue || typeof nextValue !== 'object') {
        return;
      }

      current = nextValue as Record<string, unknown> | unknown[];
      continue;
    }

    const nextValue = current[segment];
    if (!nextValue || typeof nextValue !== 'object') {
      return;
    }

    current = nextValue as Record<string, unknown> | unknown[];
  }

  const lastSegment = segments.at(-1);

  if (!lastSegment) {
    return;
  }

  if (Array.isArray(current)) {
    const arrayIndex = Number.parseInt(lastSegment, 10);
    current.splice(arrayIndex, 1);
    return;
  }

  delete current[lastSegment];
};

const applyActivityDelta = (
  activity: IAgentActivity,
  event: IAgentActivityDeltaEvent,
): IAgentActivity => {
  const nextActivity = cloneActivity(activity) as Record<string, unknown>;

  for (const operation of event.patch) {
    if (operation.op === 'remove') {
      removePointerValue(nextActivity, operation.path);
      continue;
    }

    setPointerValue(nextActivity, operation.path, operation.value);
  }

  return nextActivity as IAgentActivity;
};

const buildActivityDeltaEvent = (
  previousActivity: IAgentActivity,
  nextActivity: IAgentActivity,
  timestamp: number,
): IAgentActivityDeltaEvent | null => {
  const keys = new Set<string>([
    ...Object.keys(previousActivity),
    ...Object.keys(nextActivity),
  ]);
  const patch: IAgentActivityDeltaEvent['patch'] = [];

  keys.delete('id');

  for (const key of keys) {
    const previousValue = previousActivity[key as keyof IAgentActivity];
    const nextValue = nextActivity[key as keyof IAgentActivity];

    if (areActivityValuesEqual(previousValue, nextValue)) {
      continue;
    }

    const path = `/${escapeJsonPointerSegment(key)}`;

    if (nextValue === undefined) {
      patch.push({
        op: 'remove',
        path,
      });
      continue;
    }

    patch.push({
      op: previousValue === undefined ? 'add' : 'replace',
      path,
      value: cloneJsonValue(nextValue),
    });
  }

  if (patch.length === 0) {
    return null;
  }

  return {
    type: 'ACTIVITY_DELTA',
    timestamp,
    messageId: nextActivity.id,
    activityType: toActivityType(nextActivity.kind),
    patch,
  };
};

export const buildAgentActivityEvents = (
  previousActivities: readonly IAgentActivity[],
  nextActivities: readonly IAgentActivity[],
  timestamp = Date.now(),
): TAgentActivityEvent[] => {
  const previousById = new Map(previousActivities.map((activity) => [activity.id, activity]));
  const events: TAgentActivityEvent[] = [];

  for (const activity of nextActivities) {
    const previousActivity = previousById.get(activity.id);

    if (!previousActivity) {
      events.push({
        type: 'ACTIVITY_SNAPSHOT',
        timestamp,
        messageId: activity.id,
        activityType: toActivityType(activity.kind),
        replace: true,
        content: cloneActivity(activity),
      });
      continue;
    }

    const deltaEvent = buildActivityDeltaEvent(previousActivity, activity, timestamp);

    if (deltaEvent) {
      events.push(deltaEvent);
    }
  }

  return events;
};

export const materializeAgentActivities = (
  activityEvents: readonly TAgentActivityEvent[],
  currentActivities: readonly IAgentActivity[] = [],
): IAgentActivity[] => {
  const activities = currentActivities.map((activity) => cloneActivity(activity));
  const indexById = new Map(activities.map((activity, index) => [activity.id, index]));

  for (const event of activityEvents) {
    if (event.type === 'ACTIVITY_SNAPSHOT') {
      const existingIndex = indexById.get(event.messageId);
      const snapshot = cloneActivity(event.content);

      if (existingIndex === undefined) {
        indexById.set(snapshot.id, activities.length);
        activities.push(snapshot);
        continue;
      }

      activities[existingIndex] = snapshot;
      continue;
    }

    const existingIndex = indexById.get(event.messageId);

    if (existingIndex === undefined) {
      continue;
    }

    const currentActivity = activities[existingIndex];
    if (!currentActivity) {
      continue;
    }

    activities[existingIndex] = applyActivityDelta(currentActivity, event);
  }

  return activities;
};

export const appendAgentActivityEvents = (
  currentEvents: readonly TAgentActivityEvent[],
  nextActivities: readonly IAgentActivity[],
  timestamp = Date.now(),
): TAgentActivityEvent[] => {
  const previousActivities = materializeAgentActivities(currentEvents);
  const nextEvents = buildAgentActivityEvents(previousActivities, nextActivities, timestamp);

  if (nextEvents.length === 0) {
    return currentEvents.map((event) => cloneEvent(event));
  }

  return [
    ...currentEvents.map((event) => cloneEvent(event)),
    ...nextEvents,
  ];
};

export const buildAgentActivitiesFromSidecarState = (
  options: IBuildAgentActivitiesFromSidecarStateOptions,
): IAgentActivity[] => {
  const rootTitle = clipActivityText(options.rootTitle) || '请求处理中';
  const rootId = `${options.runId}:${ACTIVITY_ROOT_ID_SUFFIX}`;
  const processActivities = (options.activityTrail ?? [])
    .map((item, index) => createProcessActivity(
      options.runId,
      rootId,
      item,
      index,
      options.status,
    ))
    .filter((activity): activity is IAgentActivity => Boolean(activity));
  const toolActivities = options.toolCalls.map((toolCall) =>
    createToolActivity(options.runId, rootId, toolCall)
  );

  return [
    {
      id: rootId,
      runId: options.runId,
      kind: 'run',
      status: options.status,
      title: rootTitle,
    },
    ...processActivities,
    ...toolActivities,
  ];
};
