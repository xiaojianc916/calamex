import { AI_AGENT_TOOL_NAMES, type TAiAgentToolName } from '@/types/ai-tools';
import {
  appendAgentActivityEvents,
  buildAgentActivitiesFromSidecarState,
  materializeAgentActivities,
} from '@/utils/agent-activity';
import { normalizeFileSystemPath } from '@/utils/path';
import {
  clipTextPreview,
  formatPrioritizedFieldPreview,
  normalizePreviewText,
  type IPrioritizedPreviewField,
} from '@/utils/text-preview';

import type {
  IAgentActivity,
  TAgentActivityEvent,
  TAgentActivityStatus,
} from '@/types/agent-activity';
import type {
  IAgentPlan,
  IAgentPlanStep,
  IAgentSidecarResponsePayload,
  TAgentRuntimeEvent,
  TAgentUiEvent,
  TJsonValue,
} from '@/types/agent-sidecar';
import type {
  IAiTaskPlanStep,
  IAiToolCall,
  IAiToolConfirmationRequest,
  TAiAgentPlanStepKind,
  TAiAgentPlanStepStatus,
} from '@/types/ai';

export interface IAgentSidecarPlanProjection {
  goal: string;
  steps: IAiTaskPlanStep[];
  toolCalls: IAiToolCall[];
  assistantContent: string;
  errorMessage: string | null;
}

export interface IAgentSidecarExecuteProjection {
  toolCalls: IAiToolCall[];
  assistantContent: string;
  errorMessage: string | null;
  pendingConfirmation: IAiToolConfirmationRequest | null;
  changedFilePaths: string[];
  hasFileMutations: boolean;
}

export interface IAgentSidecarActivityProjection {
  toolCalls: IAiToolCall[];
  activityText: string;
  activityTrail: string[];
  activities: IAgentActivity[];
  activityEvents: TAgentActivityEvent[];
}

export type TAgentSidecarActivityStreamStatus = 'streaming' | 'completed' | 'cancelled';

const AI_AGENT_TOOL_NAME_SET = new Set<string>(AI_AGENT_TOOL_NAMES);

const SIDECAR_FILE_MUTATION_TOOL_NAMES = new Set<string>([
  'write_file',
  'edit_file',
  'create_directory',
  'move_file',
  'delete_file',
]);

const AGENT_ACTIVITY_TRAIL_LIMIT = 6;
const AGENT_ACTIVITY_PREVIEW_CHARS = 96;

const ACTIVITY_JSON_FIELD_RULES = [
  { key: 'query', label: '查询', priority: 100, minGraphemes: 16, maxGraphemes: 48 },
  { key: 'pattern', label: '搜索', priority: 96, minGraphemes: 14, maxGraphemes: 44 },
  { key: 'site', label: '站点', priority: 86, minGraphemes: 8, maxGraphemes: 28 },
  { key: 'domain', label: '站点', priority: 84, minGraphemes: 8, maxGraphemes: 28 },
  { key: 'url', label: '网址', priority: 78, minGraphemes: 12, maxGraphemes: 42 },
  { key: 'path', label: '路径', priority: 70, minGraphemes: 14, maxGraphemes: 44 },
  { key: 'file', label: '文件', priority: 70, minGraphemes: 14, maxGraphemes: 44 },
  { key: 'filePath', label: '文件', priority: 70, minGraphemes: 14, maxGraphemes: 44 },
  { key: 'summary', label: '摘要', priority: 36, minGraphemes: 12, maxGraphemes: 40 },
  { key: 'message', label: '信息', priority: 32, minGraphemes: 12, maxGraphemes: 40 },
  { key: 'title', label: '标题', priority: 28, minGraphemes: 12, maxGraphemes: 36 },
] as const;

type TActivityJsonFieldRule = (typeof ACTIVITY_JSON_FIELD_RULES)[number];
type TActivityJsonRecord = Record<string, unknown>;

const SIDECAR_FILE_PATH_KEYS = new Set<string>([
  'path',
  'file',
  'filePath',
  'relativePath',
  'targetPath',
  'sourcePath',
  'destinationPath',
  'newPath',
]);

const SIDECAR_QUERY_KEYS = new Set<string>([
  'query',
  'q',
  'pattern',
  'keyword',
  'keywords',
  'search',
  'searchTerm',
  'search_term',
]);

const SIDECAR_COMMAND_KEYS = new Set<string>([
  'command',
  'cmd',
  'script',
]);

const SIDECAR_URL_KEYS = new Set<string>([
  'url',
  'uri',
  'href',
]);

const SIDECAR_DOMAIN_KEYS = new Set<string>([
  'domain',
  'domains',
  'site',
  'sites',
  'includeDomains',
  'include_domains',
  'includeDomain',
  'include_domain',
]);

const SIDECAR_PATH_SCOPE_KEYS = new Set<string>([
  ...SIDECAR_FILE_PATH_KEYS,
  'path',
  'paths',
  'root',
  'directory',
  'dir',
  'folder',
  'cwd',
  'basePath',
  'base_path',
]);

const WEB_SEARCH_TOOL_NAMES = new Set<string>([
  'web_search',
  'tavily-search',
  'tavily-map',
  'tavily_search',
  'tavily_map',
  'tavily_research',
]);

const WEB_FETCH_TOOL_NAMES = new Set<string>([
  'web_fetch',
  'tavily-extract',
  'tavily-crawl',
  'tavily_extract',
  'tavily_crawl',
]);

const FILE_SEARCH_TOOL_NAMES = new Set<string>([
  'search_files',
  'search_text',
  'search_symbols',
  'search_project_files',
  'search_nodes',
]);

const FILE_READ_TOOL_NAMES = new Set<string>([
  'read_text_file',
  'read_media_file',
  'read_multiple_files',
  'read_current_file',
  'read_selected_text',
  'read_file',
  'read_project_file',
  'get_file_info',
  'open_nodes',
]);

const DIRECTORY_TOOL_NAMES = new Set<string>([
  'list_directory',
  'list_directory_with_sizes',
  'directory_tree',
  'list_allowed_directories',
  'list_project_files',
  'get_project_tree',
]);

const GIT_TOOL_NAMES = new Set<string>([
  'git_status',
  'git_diff_unstaged',
  'git_diff_staged',
  'git_log',
  'git_show',
  'get_git_diff',
]);

const TOOL_PLATFORM_BY_NAME: Readonly<Record<string, string>> = {
  'tavily-search': 'Tavily',
  'tavily-extract': 'Tavily',
  'tavily-map': 'Tavily',
  'tavily-crawl': 'Tavily',
  tavily_search: 'Tavily',
  tavily_extract: 'Tavily',
  tavily_map: 'Tavily',
  tavily_crawl: 'Tavily',
  tavily_research: 'Tavily',
  web_search: '联网搜索',
  web_fetch: '网页读取',
};

const SIDECAR_TOOL_TO_AI_TOOL: Readonly<Record<string, TAiAgentToolName>> = {
  read_text_file: 'read_file',
  read_media_file: 'read_file',
  read_multiple_files: 'read_file',
  list_directory: 'get_project_tree',
  list_directory_with_sizes: 'get_project_tree',
  directory_tree: 'get_project_tree',
  search_files: 'search_text',
  get_file_info: 'read_file',
  list_allowed_directories: 'get_project_tree',
  list_project_files: 'get_project_tree',
  read_project_file: 'read_file',
  search_project_files: 'search_text',
  write_file: 'auto_apply_patch',
  edit_file: 'auto_apply_patch',
  create_directory: 'auto_apply_patch',
  move_file: 'auto_apply_patch',
  delete_file: 'run_command',
  run_shell_command: 'run_command',
  install_package: 'run_command',
  git_status: 'get_git_diff',
  git_diff_unstaged: 'get_git_diff',
  git_diff_staged: 'get_git_diff',
  git_log: 'get_git_diff',
  git_show: 'get_git_diff',
  git_add: 'stage_file',
  git_reset: 'run_command',
  git_create_branch: 'run_command',
  git_checkout: 'run_command',
  git_init: 'run_command',
  git_commit: 'create_commit',
  'tavily-search': 'web_search',
  'tavily-extract': 'web_fetch',
  'tavily-map': 'web_search',
  'tavily-crawl': 'web_fetch',
  tavily_search: 'web_search',
  tavily_extract: 'web_fetch',
  tavily_map: 'web_search',
  tavily_crawl: 'web_fetch',
  tavily_research: 'web_search',
  create_entities: 'get_project_tree',
  create_relations: 'get_project_tree',
  add_observations: 'get_project_tree',
  delete_entities: 'run_command',
  delete_observations: 'run_command',
  delete_relations: 'run_command',
  read_graph: 'get_project_tree',
  search_nodes: 'search_text',
  open_nodes: 'read_file',
  sequentialthinking: 'get_diagnostics',
  get_current_time: 'get_diagnostics',
  convert_time: 'get_diagnostics',
};

const isAiAgentToolName = (value: string): value is TAiAgentToolName =>
  AI_AGENT_TOOL_NAME_SET.has(value);

export const mapSidecarToolNameToAiToolName = (toolName: string): TAiAgentToolName => {
  if (isAiAgentToolName(toolName)) {
    return toolName;
  }

  return SIDECAR_TOOL_TO_AI_TOOL[toolName] ?? 'get_project_tree';
};

const normalizeStatus = (status: IAgentPlanStep['status']): TAiAgentPlanStepStatus => status;

const inferStepKind = (tools: readonly string[]): TAiAgentPlanStepKind => {
  if (tools.some((tool) =>
    tool === 'search_project_files' ||
    tool === 'search_files' ||
    tool === 'search_text' ||
    tool === 'search_symbols' ||
    tool === 'tavily-search' ||
    tool === 'tavily-map' ||
    tool === 'tavily_search' ||
    tool === 'tavily_map' ||
    tool === 'tavily_research' ||
    tool === 'search_nodes'
  )) {
    return 'search';
  }

  if (tools.some((tool) =>
    tool === 'write_file' ||
    tool === 'edit_file' ||
    tool === 'create_directory' ||
    tool === 'move_file' ||
    tool === 'delete_file' ||
    tool === 'propose_patch' ||
    tool === 'auto_apply_patch'
  )) {
    return 'edit';
  }

  if (tools.some((tool) =>
    tool === 'run_shell_command' ||
    tool === 'install_package' ||
    tool === 'run_command' ||
    tool === 'run_test'
  )) {
    return 'verify';
  }

  if (tools.some((tool) =>
    tool === 'git_commit' ||
    tool === 'git_status' ||
    tool === 'git_log' ||
    tool === 'git_show' ||
    tool === 'git_diff_unstaged' ||
    tool === 'git_diff_staged' ||
    tool === 'create_commit' ||
    tool === 'stage_file'
  )) {
    return 'summarize';
  }

  return 'inspect';
};

export const mapSidecarPlanToTaskSteps = (plan: IAgentPlan): IAiTaskPlanStep[] =>
  plan.steps.map((step, index) => ({
    id: step.id,
    index,
    title: step.title,
    goal: step.goal,
    kind: inferStepKind(step.tools),
    status: normalizeStatus(step.status),
    expectedOutput: step.expectedOutput,
    tools: step.tools.map(mapSidecarToolNameToAiToolName),
    requiresUserApproval: step.requiresApproval,
    riskLevel: step.riskLevel,
    ...(step.requiresApproval
      ? { rollbackStrategy: '执行前由后端生成快照，失败或用户不满意时可按任务回滚。' }
      : {}),
  }));

const stringifyJsonValue = (value: TJsonValue): string => JSON.stringify(value);

const toJsonValueOrNull = (value: unknown): TJsonValue | null => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(toJsonValueOrNull).map((item) => item ?? null);
  }

  if (typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;

  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, toJsonValueOrNull(item)]),
  );
};

const parseJsonString = (value: string): TJsonValue | null => {
  const trimmed = value.trim();

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return null;
  }

  try {
    return toJsonValueOrNull(JSON.parse(trimmed));
  } catch {
    return null;
  }
};

const isActivityRecord = (value: unknown): value is TActivityJsonRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const clipActivityText = (value: string): string =>
  clipTextPreview(normalizePreviewText(value), { maxGraphemes: AGENT_ACTIVITY_PREVIEW_CHARS });

const createActivityPreviewField = (
  rule: TActivityJsonFieldRule | undefined,
  value: string,
): IPrioritizedPreviewField => ({
  value,
  priority: rule?.priority ?? 1,
  ...(rule ? { label: rule.label } : {}),
  ...(rule?.minGraphemes !== undefined ? { minGraphemes: rule.minGraphemes } : {}),
  ...(rule?.maxGraphemes !== undefined ? { maxGraphemes: rule.maxGraphemes } : {}),
});

const collectActivityPreviewFields = (
  value: unknown,
  fields: IPrioritizedPreviewField[],
  sourceRule?: TActivityJsonFieldRule,
  depth = 0,
): void => {
  if (depth > 3 || fields.length >= 8 || value === null || value === undefined) {
    return;
  }

  if (typeof value === 'string' && value.trim()) {
    fields.push(createActivityPreviewField(sourceRule, value.trim()));
    return;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    fields.push(createActivityPreviewField(sourceRule, String(value)));
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectActivityPreviewFields(item, fields, sourceRule, depth + 1);
      if (fields.length >= 8) {
        return;
      }
    }
    return;
  }

  if (!isActivityRecord(value)) {
    return;
  }

  for (const rule of ACTIVITY_JSON_FIELD_RULES) {
    if (Object.hasOwn(value, rule.key)) {
      collectActivityPreviewFields(value[rule.key], fields, rule, depth + 1);
    }
  }
};

const normalizeRuntimePreviewText = (value: string | undefined): string | null => {
  if (!value?.trim()) {
    return null;
  }

  const parsed = parseJsonString(value);
  if (parsed !== null) {
    const fields: IPrioritizedPreviewField[] = [];
    collectActivityPreviewFields(parsed, fields);
    const preview = formatPrioritizedFieldPreview(fields, {
      maxFields: 3,
      maxGraphemes: AGENT_ACTIVITY_PREVIEW_CHARS,
    });

    return preview || null;
  }

  return clipActivityText(value) || null;
};

const clipSummary = (value: string, limit = 96): string => {
  return clipTextPreview(value, { maxGraphemes: limit });
};

const getRecordValue = (
  value: TJsonValue,
  key: string,
): TJsonValue | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value[key];
};

const getStringField = (value: TJsonValue, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const candidate = getRecordValue(value, key);
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
};

const collectStringValuesForKeys = (
  value: TJsonValue,
  keys: ReadonlySet<string>,
  values: string[],
  depth = 0,
): void => {
  if (depth > 4 || value === null) {
    return;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringValuesForKeys(item, keys, values, depth + 1);
    }
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key)) {
      if (typeof item === 'string' && item.trim()) {
        values.push(item.trim());
        continue;
      }

      if (Array.isArray(item)) {
        for (const candidate of item) {
          if (typeof candidate === 'string' && candidate.trim()) {
            values.push(candidate.trim());
          }
        }
        continue;
      }
    }

    collectStringValuesForKeys(item, keys, values, depth + 1);
  }
};

const uniqueNonEmptyStrings = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = value.replace(/\s+/gu, ' ').trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
};

const formatStringList = (values: readonly string[], limit = 2): string | null => {
  const normalized = uniqueNonEmptyStrings(values);
  if (!normalized.length) {
    return null;
  }

  const visible = normalized.slice(0, limit).map((value) => clipSummary(value, 42));
  const restCount = normalized.length - visible.length;

  return restCount > 0 ? `${visible.join('、')} 等 ${normalized.length} 项` : visible.join('、');
};

const collectFirstString = (
  value: TJsonValue,
  keys: ReadonlySet<string>,
): string | null => {
  const values: string[] = [];
  collectStringValuesForKeys(value, keys, values);

  return formatStringList(values, 1);
};

const collectStringList = (
  value: TJsonValue,
  keys: ReadonlySet<string>,
  limit = 2,
): string | null => {
  const values: string[] = [];
  collectStringValuesForKeys(value, keys, values);

  return formatStringList(values, limit);
};

const extractUrlHost = (value: string): string | null => {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./iu, '').trim();

    return host || null;
  } catch {
    const match = value.match(/^(?:https?:\/\/)?([^/\s?#]+)(?:[/?#]|$)/iu);
    const host = match?.[1]?.replace(/^www\./iu, '').trim();

    return host || null;
  }
};

const collectUrlDomains = (
  value: TJsonValue,
  limit = 2,
): string | null => {
  const urls: string[] = [];
  collectStringValuesForKeys(value, SIDECAR_URL_KEYS, urls);

  return formatStringList(urls.map(extractUrlHost).filter((host): host is string => Boolean(host)), limit);
};

const getToolPlatform = (toolName: string): string | null =>
  TOOL_PLATFORM_BY_NAME[toolName] ?? null;

const createDetailItem = (label: string, value: string | null): string | null =>
  value ? `${label}：${value}` : null;

const compactDetailItems = (items: readonly (string | null)[]): string[] =>
  uniqueNonEmptyStrings(items.filter((item): item is string => Boolean(item)));

interface IToolPayloadDescriptor {
  targetPreview: string;
  summary: string;
  detailItems: string[];
}

const joinTargetParts = (
  parts: readonly (string | null)[],
  fallback: string,
): string => {
  const normalized = uniqueNonEmptyStrings(parts.filter((part): part is string => Boolean(part)));

  return normalized.length ? normalized.map((part) => clipSummary(part, 52)).join(' · ') : fallback;
};

const describeToolPayload = (
  toolName: string,
  value: TJsonValue,
): IToolPayloadDescriptor => {
  const platform = getToolPlatform(toolName);
  const query = collectFirstString(value, SIDECAR_QUERY_KEYS);
  const scope = collectStringList(value, SIDECAR_PATH_SCOPE_KEYS, 2);
  const url = collectFirstString(value, SIDECAR_URL_KEYS);
  const domains = collectStringList(value, SIDECAR_DOMAIN_KEYS, 2) ?? collectUrlDomains(value, 2);
  const command = collectFirstString(value, SIDECAR_COMMAND_KEYS);

  if (WEB_SEARCH_TOOL_NAMES.has(toolName)) {
    const targetPreview = joinTargetParts([
      query,
      domains,
    ], '联网搜索');

    return {
      targetPreview,
      summary: targetPreview,
      detailItems: compactDetailItems([
        createDetailItem('平台', platform),
        createDetailItem('查询', query),
        createDetailItem('站点', domains),
      ]),
    };
  }

  if (WEB_FETCH_TOOL_NAMES.has(toolName)) {
    const targetPreview = joinTargetParts([url ?? domains ?? query], '网页');

    return {
      targetPreview,
      summary: targetPreview,
      detailItems: compactDetailItems([
        createDetailItem('平台', platform),
        createDetailItem('网址', url),
        createDetailItem('站点', domains),
      ]),
    };
  }

  if (FILE_SEARCH_TOOL_NAMES.has(toolName)) {
    const targetPreview = joinTargetParts([query, scope ?? '工作区'], '工作区');

    return {
      targetPreview,
      summary: targetPreview,
      detailItems: compactDetailItems([
        createDetailItem('搜索', query),
        createDetailItem('范围', scope ?? '工作区'),
      ]),
    };
  }

  if (FILE_READ_TOOL_NAMES.has(toolName)) {
    const targetPreview = joinTargetParts([scope], '文件');

    return {
      targetPreview,
      summary: targetPreview,
      detailItems: compactDetailItems([
        createDetailItem('文件', scope),
      ]),
    };
  }

  if (DIRECTORY_TOOL_NAMES.has(toolName)) {
    const targetPreview = joinTargetParts([scope], '项目结构');

    return {
      targetPreview,
      summary: targetPreview,
      detailItems: compactDetailItems([
        createDetailItem('目录', scope ?? '项目结构'),
      ]),
    };
  }

  if (GIT_TOOL_NAMES.has(toolName)) {
    const targetPreview = joinTargetParts([scope], 'Git 变更');

    return {
      targetPreview,
      summary: targetPreview,
      detailItems: compactDetailItems([
        createDetailItem('范围', scope ?? '当前仓库'),
      ]),
    };
  }

  if (command) {
    return {
      targetPreview: command,
      summary: command,
      detailItems: compactDetailItems([
        createDetailItem('命令', command),
      ]),
    };
  }

  const fallback = summarizeJsonValue(value);

  return {
    targetPreview: fallback,
    summary: fallback,
    detailItems: [],
  };
};

const TOOL_RESULT_TEXT_KEYS = new Set([
  'text',
  'content',
  'summary',
  'message',
  'title',
  'description',
]);

const TOOL_RESULT_CONTAINER_KEYS = new Set([
  'toolResult',
  'result',
  'output',
  'data',
  'response',
  'artifact',
]);

const RESULT_HEADING_PATTERN =
  /^(?:Detailed Results?|Results?|Tool Result|Output)\s*:?\s*$/iu;

const RESULT_FIELD_LABEL_PATTERN =
  /^(?:Title|Summary|Content|Result|Answer|Description)\s*:\s*/iu;

const URL_FIELD_LABEL_PATTERN = /^URL\s*:\s*/iu;

const cleanReadableToolText = (value: string): string | null => {
  const lines = value
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .filter((line) => line && !RESULT_HEADING_PATTERN.test(line));

  const contentLine = lines.find((line) =>
    RESULT_FIELD_LABEL_PATTERN.test(line) && !URL_FIELD_LABEL_PATTERN.test(line)
  ) ?? lines.find((line) => !URL_FIELD_LABEL_PATTERN.test(line));

  if (!contentLine) {
    return null;
  }

  const normalized = contentLine.replace(RESULT_FIELD_LABEL_PATTERN, '').trim();

  return normalized ? clipSummary(normalized) : null;
};

const collectReadableToolTexts = (
  value: TJsonValue,
  texts: string[],
  depth = 0,
): void => {
  if (depth > 5 || texts.length >= 4 || value === null) {
    return;
  }

  if (typeof value === 'string') {
    const parsed = parseJsonString(value);
    if (parsed) {
      collectReadableToolTexts(parsed, texts, depth + 1);
      return;
    }

    const cleaned = cleanReadableToolText(value);
    if (cleaned) {
      texts.push(cleaned);
    }
    return;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectReadableToolTexts(item, texts, depth + 1);
      if (texts.length >= 4) {
        return;
      }
    }
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    if (TOOL_RESULT_TEXT_KEYS.has(key)) {
      collectReadableToolTexts(item, texts, depth + 1);
    }
  }

  for (const [key, item] of Object.entries(value)) {
    if (TOOL_RESULT_CONTAINER_KEYS.has(key)) {
      collectReadableToolTexts(item, texts, depth + 1);
    }
  }
};

const collectPathCandidates = (value: TJsonValue, paths: string[]): void => {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPathCandidates(item, paths);
    }
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    if (SIDECAR_FILE_PATH_KEYS.has(key) && typeof item === 'string' && item.trim()) {
      paths.push(item.trim());
      continue;
    }

    collectPathCandidates(item, paths);
  }
};

const isSidecarFileMutationEvent = (
  event: TAgentUiEvent,
): event is Extract<TAgentUiEvent, { type: 'tool_start' | 'tool_result' }> =>
  (event.type === 'tool_start' || event.type === 'tool_result') &&
  SIDECAR_FILE_MUTATION_TOOL_NAMES.has(event.toolName);

const isAgentRuntimeToolEvent = (
  event: TAgentRuntimeEvent,
): event is Extract<
  TAgentRuntimeEvent,
  { type: 'agent.tool.started' | 'agent.tool.completed' }
> =>
  event.type === 'agent.tool.started' || event.type === 'agent.tool.completed';

const isRuntimeFileMutationEvent = (
  event: TAgentUiEvent,
): event is Extract<TAgentUiEvent, { type: 'agent_event' }> =>
  event.type === 'agent_event' &&
  isAgentRuntimeToolEvent(event.event) &&
  SIDECAR_FILE_MUTATION_TOOL_NAMES.has(event.event.toolName);

export const hasSidecarFileMutationEvent = (events: readonly TAgentUiEvent[]): boolean =>
  events.some((event) => isSidecarFileMutationEvent(event) || isRuntimeFileMutationEvent(event));

export const extractVisibleAgentRuntimeEvents = (
  events: readonly TAgentUiEvent[],
): TAgentRuntimeEvent[] =>
  events
    .filter((event): event is Extract<TAgentUiEvent, { type: 'agent_event' }> =>
      event.type === 'agent_event' && event.event.visibility === 'user'
    )
    .map((event) => event.event);

export const extractSidecarChangedFilePaths = (
  events: readonly TAgentUiEvent[],
): string[] => {
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    if (isSidecarFileMutationEvent(event)) {
      collectPathCandidates(event.type === 'tool_start' ? event.input : event.output, paths);
      continue;
    }

    if (isRuntimeFileMutationEvent(event)) {
      const runtimeEvent = event.event;
      const preview = runtimeEvent.type === 'agent.tool.started'
        ? runtimeEvent.inputPreview
        : runtimeEvent.resultPreview;
      const parsedPreview = preview ? parseJsonString(preview) ?? preview : null;

      if (parsedPreview !== null) {
        collectPathCandidates(parsedPreview, paths);
      }
    }
  }

  return paths.filter((path) => {
    const normalized = normalizeFileSystemPath(path, {
      collapseDuplicateSeparators: true,
      trimTrailingSeparator: true,
    });

    if (!normalized || seen.has(normalized)) {
      return false;
    }

    seen.add(normalized);
    return true;
  });
};

const summarizeJsonValue = (value: TJsonValue): string => {
  if (typeof value === 'string') {
    const parsed = parseJsonString(value);
    if (parsed) {
      return summarizeJsonValue(parsed);
    }

    return cleanReadableToolText(value) ?? clipSummary(value);
  }

  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    const readableTexts: string[] = [];
    collectReadableToolTexts(value, readableTexts);
    if (readableTexts[0]) {
      return readableTexts[0];
    }

    const firstText = value.find((item): item is string => typeof item === 'string' && item.trim().length > 0);
    return firstText ? summarizeJsonValue(firstText) : clipSummary(stringifyJsonValue(value));
  }

  const priority = getStringField(value, [
    'path',
    'file',
    'filePath',
    'relativePath',
    'query',
    'pattern',
    'command',
    'url',
    'summary',
    'reason',
    'root',
  ]);

  if (priority) {
    return priority;
  }

  const readableTexts: string[] = [];
  collectReadableToolTexts(value, readableTexts);

  return readableTexts[0] ?? clipSummary(stringifyJsonValue(value));
};

const getRuntimePreviewValue = (preview: string | undefined): TJsonValue => {
  const normalized = preview?.trim();

  if (!normalized) {
    return '';
  }

  return parseJsonString(normalized) ?? normalized;
};

const describeRuntimeToolPreview = (
  toolName: string,
  preview: string | undefined,
): IToolPayloadDescriptor => {
  const descriptor = describeToolPayload(toolName, getRuntimePreviewValue(preview));

  return {
    targetPreview: descriptor.targetPreview || '任务',
    summary: descriptor.summary || '正在执行',
    detailItems: descriptor.detailItems,
  };
};

const createToolCallId = (event: TAgentUiEvent, index: number): string => {
  if (event.type === 'approval_required') {
    return `sidecar-approval:${event.request.id}`;
  }

  if (event.type === 'tool_start' || event.type === 'tool_result') {
    return `sidecar-tool:${index}:${event.toolName}`;
  }

  return `sidecar-event:${index}:${event.type}`;
};

const createRuntimeToolCallId = (
  event: Extract<TAgentRuntimeEvent, { type: 'agent.tool.started' | 'agent.tool.completed' }>,
): string => event.toolUseId ? `runtime-tool:${event.toolUseId}` : `runtime-tool:${event.id}`;

const findRuntimeToolCallIndex = (
  toolCalls: readonly IAiToolCall[],
  event: Extract<TAgentRuntimeEvent, { type: 'agent.tool.started' | 'agent.tool.completed' }>,
): number => {
  const runtimeId = createRuntimeToolCallId(event);
  const idIndex = toolCalls.findIndex((toolCall) => toolCall.id === runtimeId);

  if (idIndex >= 0) {
    return idIndex;
  }

  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index];
    if (toolCall?.name === event.toolName && toolCall.status === 'running') {
      return index;
    }
  }

  return -1;
};

const appendRuntimeToolStarted = (
  toolCalls: IAiToolCall[],
  event: Extract<TAgentRuntimeEvent, { type: 'agent.tool.started' }>,
): void => {
  if (findRuntimeToolCallIndex(toolCalls, event) >= 0) {
    return;
  }

  const descriptor = describeRuntimeToolPreview(event.toolName, event.inputPreview);

  toolCalls.push({
    id: createRuntimeToolCallId(event),
    name: event.toolName,
    status: 'running',
    summary: descriptor.summary,
    targetPreview: descriptor.targetPreview,
    ...(descriptor.detailItems.length ? { detailItems: descriptor.detailItems } : {}),
  });
};

const appendRuntimeToolCompleted = (
  toolCalls: IAiToolCall[],
  event: Extract<TAgentRuntimeEvent, { type: 'agent.tool.completed' }>,
): void => {
  const descriptor = describeRuntimeToolPreview(event.toolName, event.resultPreview);
  const summary = event.ok
    ? summarizeJsonValue(getRuntimePreviewValue(event.resultPreview)) || descriptor.summary
    : event.errorMessage ?? '工具执行失败';
  const existingIndex = findRuntimeToolCallIndex(toolCalls, event);

  if (existingIndex >= 0) {
    const existing = toolCalls[existingIndex];
    if (!existing) {
      return;
    }

    toolCalls[existingIndex] = {
      ...existing,
      status: event.ok ? 'succeeded' : 'failed',
      summary,
      ...(existing.targetPreview ? { targetPreview: existing.targetPreview } : { targetPreview: descriptor.targetPreview }),
      ...(existing.detailItems?.length
        ? { detailItems: existing.detailItems }
        : descriptor.detailItems.length
          ? { detailItems: descriptor.detailItems }
          : {}),
    };
    return;
  }

  toolCalls.push({
    id: createRuntimeToolCallId(event),
    name: event.toolName,
    status: event.ok ? 'succeeded' : 'failed',
    summary,
    targetPreview: descriptor.targetPreview,
    ...(descriptor.detailItems.length ? { detailItems: descriptor.detailItems } : {}),
  });
};

const applyRuntimeToolEventToToolCalls = (
  toolCalls: IAiToolCall[],
  event: TAgentRuntimeEvent,
): void => {
  if (event.type === 'agent.tool.started') {
    appendRuntimeToolStarted(toolCalls, event);
    return;
  }

  if (event.type === 'agent.tool.completed') {
    appendRuntimeToolCompleted(toolCalls, event);
  }
};

const WEB_TOOL_NAME_PATTERN = /(?:web|tavily)/iu;
const FILE_SEARCH_TOOL_NAME_PATTERN = /(?:search_(?:project_)?files|search_text|search_symbols)/iu;
const DIRECTORY_TOOL_NAME_PATTERN = /(?:list_directory|directory_tree|get_project_tree|list_project_files)/iu;
const FILE_READ_TOOL_NAME_PATTERN = /(?:read_|get_file_info|open_nodes)/iu;

const getToolDetailValue = (toolCall: IAiToolCall, label: string): string | null => {
  const prefix = `${label}：`;
  const item = toolCall.detailItems?.find((detail) => detail.startsWith(prefix));

  return item ? item.slice(prefix.length).trim() || null : null;
};

const buildToolActivityText = (toolCall: IAiToolCall): string => {
  const target = toolCall.targetPreview?.trim() || toolCall.summary.trim();
  const query = getToolDetailValue(toolCall, '查询') ?? getToolDetailValue(toolCall, '搜索');
  const scope = getToolDetailValue(toolCall, '范围');
  const file = getToolDetailValue(toolCall, '文件');
  const directory = getToolDetailValue(toolCall, '目录');
  const site = getToolDetailValue(toolCall, '站点');
  const url = getToolDetailValue(toolCall, '网址');

  if (WEB_TOOL_NAME_PATTERN.test(toolCall.name)) {
    const searchTarget = query ?? url ?? site ?? target;
    const isFetch = Boolean(url && !query);
    const verb = isFetch ? '读取网页' : '联网搜索';
    const siteHint = site && query ? `，站点 ${site}` : '';

    return searchTarget ? `${verb}「${searchTarget}」${siteHint}` : verb;
  }

  if (FILE_SEARCH_TOOL_NAME_PATTERN.test(toolCall.name)) {
    const searchTarget = query ?? target;
    const scopeHint = scope ?? '工作区';

    return searchTarget ? `在 ${scopeHint} 搜索「${searchTarget}」` : `搜索 ${scopeHint}`;
  }

  if (DIRECTORY_TOOL_NAME_PATTERN.test(toolCall.name)) {
    return `查看目录 ${directory ?? target}`;
  }

  if (FILE_READ_TOOL_NAME_PATTERN.test(toolCall.name)) {
    return `查看文件 ${file ?? target}`;
  }

  return target ? `处理 ${target}` : '处理任务';
};

const buildSidecarLiveActivityText = (
  toolCalls: readonly IAiToolCall[],
  fallback: string,
): string => {
  const activeToolCall = [...toolCalls]
    .reverse()
    .find((toolCall) => toolCall.status === 'running' || toolCall.status === 'pending');

  if (activeToolCall) {
    return buildToolActivityText(activeToolCall);
  }

  const completedToolCall = [...toolCalls]
    .reverse()
    .find((toolCall) => toolCall.status === 'succeeded');

  if (completedToolCall) {
    return buildToolActivityText(completedToolCall);
  }

  return fallback || '请求处理中';
};

const buildCompletedSidecarActivityText = (
  toolCalls: readonly IAiToolCall[],
  fallback: string,
): string => {
  const lastToolCall = [...toolCalls]
    .reverse()
    .find((toolCall) =>
      toolCall.status === 'succeeded' ||
      toolCall.status === 'failed' ||
      toolCall.status === 'denied' ||
      toolCall.status === 'pending' ||
      toolCall.status === 'running'
    );

  return lastToolCall ? buildToolActivityText(lastToolCall) : fallback || '请求处理中';
};

const appendActivityTrail = (
  currentTrail: readonly string[] | undefined,
  nextText: string | undefined,
): string[] => {
  const normalized = nextText ? normalizePreviewText(nextText) : '';

  if (!normalized) {
    return currentTrail?.length ? [...currentTrail] : [];
  }

  const nextTrail = [...(currentTrail ?? []), normalized];
  const seen = new Set<string>();
  const uniqueTrail: string[] = [];

  for (const item of nextTrail) {
    if (seen.has(item)) {
      continue;
    }

    seen.add(item);
    uniqueTrail.push(item);
  }

  return uniqueTrail.slice(-AGENT_ACTIVITY_TRAIL_LIMIT);
};

const formatRuntimeActivityText = (prefix: string, value: string | undefined): string => {
  const normalized = normalizeRuntimePreviewText(value);

  return normalized ? `${prefix}：${normalized}` : prefix;
};

const getRollbackActivityText = (
  event: Extract<
    TAgentRuntimeEvent,
    {
      type:
      | 'rollback.checkpoint.created'
      | 'rollback.checkpoint.failed'
      | 'rollback.restore.started'
      | 'rollback.restore.completed'
      | 'rollback.restore.failed';
    }
  >,
): string | null => {
  switch (event.type) {
    case 'rollback.checkpoint.created':
      return event.snapshotId
        ? `已创建回滚检查点：${clipActivityText(event.snapshotId)}`
        : '已创建回滚检查点';
    case 'rollback.checkpoint.failed':
      return formatRuntimeActivityText('回滚检查点创建失败', event.errorMessage);
    case 'rollback.restore.started':
      return event.snapshotId
        ? `正在恢复回滚检查点：${clipActivityText(event.snapshotId)}`
        : '正在恢复回滚检查点';
    case 'rollback.restore.completed':
      return normalizeRuntimePreviewText(event.message)
        ?? (event.snapshotId
          ? `已恢复回滚检查点：${clipActivityText(event.snapshotId)}`
          : '已恢复回滚检查点');
    case 'rollback.restore.failed':
      return formatRuntimeActivityText('回滚恢复失败', event.errorMessage);
  }
};

const getSideEffectActivityText = (
  event: Extract<TAgentRuntimeEvent, { type: 'side_effect.recorded' | 'side_effect.warning' }>,
): string | null =>
  normalizeRuntimePreviewText(event.message)
  ?? (event.type === 'side_effect.recorded'
    ? '已记录外部副作用风险'
    : '外部副作用需要人工确认');

const getRuntimeActivityText = (event: TAgentRuntimeEvent): string | null => {
  if (event.visibility !== 'user') {
    return null;
  }

  switch (event.type) {
    case 'agent.run.started':
      return normalizeRuntimePreviewText(event.inputPreview);
    case 'agent.text.delta':
      return normalizeRuntimePreviewText(event.text);
    case 'agent.tool.progress':
      return normalizeRuntimePreviewText(event.dataPreview);
    case 'rollback.checkpoint.created':
    case 'rollback.checkpoint.failed':
    case 'rollback.restore.started':
    case 'rollback.restore.completed':
    case 'rollback.restore.failed':
      return getRollbackActivityText(event);
    case 'side_effect.recorded':
    case 'side_effect.warning':
      return getSideEffectActivityText(event);
    case 'agent.run.completed':
      return normalizeRuntimePreviewText(event.outputPreview);
    case 'agent.run.error':
      return normalizeRuntimePreviewText(event.errorMessage);
    default:
      return null;
  }
};

const buildSidecarActivityTrail = (events: readonly TAgentUiEvent[]): string[] => {
  let trail: string[] = [];
  let latestPublicDelta: string | null = null;
  let hasActivityContext = false;

  for (const event of events) {
    if (event.type === 'tool_start' || event.type === 'tool_result') {
      hasActivityContext = true;
      continue;
    }

    if (event.type === 'message_delta') {
      latestPublicDelta = normalizeRuntimePreviewText(event.text);
      continue;
    }

    if (event.type === 'agent_event') {
      const activityText = getRuntimeActivityText(event.event);
      if (activityText) {
        hasActivityContext = true;
        trail = appendActivityTrail(trail, activityText);
      }
    }
  }

  if (hasActivityContext && latestPublicDelta) {
    trail = appendActivityTrail(trail, latestPublicDelta);
  }

  return trail;
};

const mapStreamStatusToActivityStatus = (
  status: TAgentSidecarActivityStreamStatus,
  hasError: boolean,
): TAgentActivityStatus => {
  if (hasError) {
    return 'error';
  }

  if (status === 'cancelled') {
    return 'cancelled';
  }

  return status === 'streaming' ? 'running' : 'success';
};

const buildSidecarActivities = (params: {
  assistantMessageId: string;
  activityText: string;
  toolCalls: readonly IAiToolCall[];
  activityTrail: readonly string[];
  streamStatus: TAgentSidecarActivityStreamStatus;
  hasError: boolean;
}): IAgentActivity[] => {
  if (!params.toolCalls.length && !params.activityTrail.length) {
    return [];
  }

  return buildAgentActivitiesFromSidecarState({
    runId: params.assistantMessageId,
    rootTitle: params.activityText,
    status: mapStreamStatusToActivityStatus(params.streamStatus, params.hasError),
    toolCalls: params.toolCalls,
    activityTrail: params.activityTrail,
  });
};

export const mapSidecarEventsToToolCalls = (events: readonly TAgentUiEvent[]): IAiToolCall[] => {
  const toolCalls: IAiToolCall[] = [];

  for (const [index, event] of events.entries()) {
    if (event.type === 'tool_start') {
      const descriptor = describeToolPayload(event.toolName, event.input);
      toolCalls.push({
        id: createToolCallId(event, index),
        name: event.toolName,
        status: 'running',
        summary: descriptor.summary,
        targetPreview: descriptor.targetPreview,
        detailItems: descriptor.detailItems,
      });
      continue;
    }

    if (event.type === 'tool_result') {
      let existingIndex = -1;
      for (let itemIndex = toolCalls.length - 1; itemIndex >= 0; itemIndex -= 1) {
        const toolCall = toolCalls[itemIndex];
        if (toolCall?.name === event.toolName && toolCall.status === 'running') {
          existingIndex = itemIndex;
          break;
        }
      }
      const summary = summarizeJsonValue(event.output);

      if (existingIndex >= 0) {
        const existing = toolCalls[existingIndex];
        if (existing) {
          toolCalls[existingIndex] = {
            ...existing,
            status: 'succeeded',
            summary,
            ...(existing.targetPreview ? { targetPreview: existing.targetPreview } : {}),
            ...(existing.detailItems?.length ? { detailItems: existing.detailItems } : {}),
          };
        }
        continue;
      }

      const descriptor = describeToolPayload(event.toolName, event.output);
      toolCalls.push({
        id: createToolCallId(event, index),
        name: event.toolName,
        status: 'succeeded',
        summary,
        ...(descriptor.detailItems.length ? {
          targetPreview: descriptor.targetPreview,
          detailItems: descriptor.detailItems,
        } : {}),
      });
      continue;
    }

    if (event.type === 'approval_required') {
      toolCalls.push({
        id: createToolCallId(event, index),
        name: event.request.toolName,
        status: 'pending',
        summary: `等待审批：${event.request.summary}`,
        targetPreview: event.request.summary,
      });
    }

    if (event.type === 'agent_event') {
      applyRuntimeToolEventToToolCalls(toolCalls, event.event);
    }
  }

  return toolCalls;
};

export const projectSidecarEventsToActivityState = (params: {
  assistantMessageId: string;
  events: readonly TAgentUiEvent[];
  fallbackActivityText: string;
  streamStatus: TAgentSidecarActivityStreamStatus;
  hasError?: boolean;
  currentActivityEvents?: readonly TAgentActivityEvent[];
}): IAgentSidecarActivityProjection => {
  const toolCalls = mapSidecarEventsToToolCalls(params.events);
  const activityText = params.streamStatus === 'streaming'
    ? buildSidecarLiveActivityText(toolCalls, params.fallbackActivityText)
    : buildCompletedSidecarActivityText(toolCalls, params.fallbackActivityText);
  const activityTrail = buildSidecarActivityTrail(params.events);
  const activities = buildSidecarActivities({
    assistantMessageId: params.assistantMessageId,
    activityText,
    toolCalls,
    activityTrail,
    streamStatus: params.streamStatus,
    hasError: Boolean(params.hasError),
  });
  const activityEvents = appendAgentActivityEvents(params.currentActivityEvents ?? [], activities);

  return {
    toolCalls,
    activityText,
    activityTrail,
    activities: activityEvents.length ? materializeAgentActivities(activityEvents) : activities,
    activityEvents,
  };
};

const extractPlan = (events: readonly TAgentUiEvent[]): IAgentPlan | null =>
  events.find((event): event is Extract<TAgentUiEvent, { type: 'plan_ready' }> =>
    event.type === 'plan_ready'
  )?.plan ?? null;

const extractErrorMessage = (events: readonly TAgentUiEvent[]): string | null =>
  events.find((event): event is Extract<TAgentUiEvent, { type: 'error' }> =>
    event.type === 'error'
  )?.message ?? null;

const hasMeaningfulText = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const extractDoneResult = (events: readonly TAgentUiEvent[]): string | null => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'done') {
      return hasMeaningfulText(event.result) ? event.result : null;
    }
  }

  return null;
};

const extractLatestMessageDelta = (events: readonly TAgentUiEvent[]): string | null => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'message_delta') {
      return hasMeaningfulText(event.text) ? event.text : null;
    }
  }

  return null;
};

const buildAssistantContent = (
  goal: string,
  plan: IAgentPlan | null,
  doneResult: string | null,
): string => {
  if (doneResult) {
    return doneResult;
  }

  if (!plan) {
    return 'Plan 模式没有收到有效计划。';
  }

  return [
    `已生成计划：${goal}`,
    '',
    ...plan.steps.map((step, index) => `${index + 1}. ${step.title}`),
  ].join('\n');
};

export const projectSidecarPlanResponse = (
  response: IAgentSidecarResponsePayload,
  fallbackGoal: string,
): IAgentSidecarPlanProjection => {
  const plan = extractPlan(response.events);
  const errorMessage = extractErrorMessage(response.events);
  const goal = plan?.goal ?? fallbackGoal;

  return {
    goal,
    steps: plan ? mapSidecarPlanToTaskSteps(plan) : [],
    toolCalls: mapSidecarEventsToToolCalls(response.events),
    assistantContent: buildAssistantContent(goal, plan, extractDoneResult(response.events)),
    errorMessage: errorMessage ?? (plan ? null : 'sidecar 未返回 plan_ready 事件，计划没有生成。'),
  };
};

const TOOL_CONFIRMATION_OPTIONS: IAiToolConfirmationRequest['options'] = [
  { id: 'allow-once', label: '允许一次', tone: 'primary' },
  { id: 'skip', label: '跳过' },
  { id: 'stop', label: '停止', tone: 'danger' },
];

const mapSidecarApprovalToToolConfirmation = (
  event: Extract<TAgentUiEvent, { type: 'approval_required' }>,
  sessionId: string,
): IAiToolConfirmationRequest => ({
  id: event.request.id,
  runId: `sidecar:${sessionId}`,
  stepId: `sidecar:${event.request.id}`,
  toolName: mapSidecarToolNameToAiToolName(event.request.toolName),
  question: event.request.question,
  summary: event.request.summary,
  riskLevel: event.request.riskLevel,
  impact: event.request.summary,
  reversible: event.request.reversible,
  createdAt: event.request.createdAt,
  options: TOOL_CONFIRMATION_OPTIONS,
});

const extractPendingConfirmation = (
  response: IAgentSidecarResponsePayload,
): IAiToolConfirmationRequest | null => {
  const approval = response.events.find((event): event is Extract<TAgentUiEvent, { type: 'approval_required' }> =>
    event.type === 'approval_required'
  );

  return approval ? mapSidecarApprovalToToolConfirmation(approval, response.sessionId) : null;
};

export const projectSidecarExecuteResponse = (
  response: IAgentSidecarResponsePayload,
): IAgentSidecarExecuteProjection => {
  const errorMessage = extractErrorMessage(response.events);
  const doneResult = extractDoneResult(response.events);
  const latestDelta = extractLatestMessageDelta(response.events);
  const changedFilePaths = extractSidecarChangedFilePaths(response.events);
  const hasFileMutations = hasSidecarFileMutationEvent(response.events);
  const responseResult = hasMeaningfulText(response.result) ? response.result : null;
  const assistantContent = errorMessage
    ? `Agent 执行失败：${errorMessage}`
    : doneResult ?? responseResult ?? latestDelta ?? 'Agent 已完成。';

  return {
    toolCalls: mapSidecarEventsToToolCalls(response.events),
    assistantContent,
    errorMessage,
    pendingConfirmation: extractPendingConfirmation(response),
    changedFilePaths,
    hasFileMutations,
  };
};
