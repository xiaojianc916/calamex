import type {
  IAiAgentPlanMetadata,
  IAiAgentPlanVersionSummary,
  IAiLanguageModelUsage,
  IAiTaskPlanStep,
  IAiToolCall,
  IAiToolConfirmationRequest,
  TAiAgentPlanRiskLevel,
  TAiAgentPlanStepKind,
  TAiAgentPlanStepStatus,
} from '@/types/ai';
import { AI_AGENT_PLAN_RISK_LEVELS } from '@/types/ai/agent';
import type {
  IAgentPlan,
  IAgentPlanRecord,
  IAgentPlanStep,
  IAgentSidecarResponsePayload,
  TAgentRuntimeEvent,
  TAgentUiEvent,
  TJsonValue,
} from '@/types/ai/sidecar';
import { AI_AGENT_TOOL_NAMES, type TAiAgentToolName } from '@/types/ai/tools';
import { normalizeFileSystemPath } from '@/utils/path';
import { clipTextPreview } from '@/utils/text-preview';

/* ============================================================================
 * Plan validation status
 *
 * passed       = 全部通过
 * failed       = 检测出阻塞性问题
 * needs_replan = 步骤之间冲突或依赖错位,需要重新生成计划
 * ========================================================================== */

export const AGENT_SIDECAR_PLAN_VALIDATION_STATUSES = ['passed', 'failed', 'needs_replan'] as const;

export type TAgentSidecarPlanValidationStatus =
  (typeof AGENT_SIDECAR_PLAN_VALIDATION_STATUSES)[number];

/* ============================================================================
 * Public projection types
 * ========================================================================== */

export interface IAgentSidecarPlanProjection {
  goal: string;
  summary: string | null;
  planMetadata: IAiAgentPlanMetadata | null;
  steps: IAiTaskPlanStep[];
  toolCalls: IAiToolCall[];
  assistantContent: string;
  errorMessage: string | null;
}

export interface IAgentSidecarPlanRecordProjection {
  record: IAgentPlanRecord | null;
  versions: IAiAgentPlanVersionSummary[];
  metadata: IAiAgentPlanMetadata | null;
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

export interface IAgentSidecarPlanValidationFinding {
  stepId: string | null;
  /** 复用 ai-agent 域的 risk level —— low/medium/high 集合一致,避免双 SoT。 */
  severity: TAiAgentPlanRiskLevel;
  title: string;
  detail: string;
  retryable: boolean;
}

export interface IAgentSidecarPlanValidationAcceptance {
  criterion: string;
  passed: boolean;
  detail: string;
}

export interface IAgentSidecarPlanValidationReport {
  status: TAgentSidecarPlanValidationStatus;
  summary: string;
  checkedStepIds: string[];
  needsReplan: boolean;
  findings: IAgentSidecarPlanValidationFinding[];
  acceptance: IAgentSidecarPlanValidationAcceptance[];
}

export interface IAgentSidecarPlanValidationProjection {
  report: IAgentSidecarPlanValidationReport | null;
  errorMessage: string | null;
}

export interface ISidecarOfficialUsageResolution {
  resolved: boolean;
  /** 用项目自有的 schema-inferred 类型,不依赖外部 SDK 的 LanguageModelUsage 形状。 */
  usage: IAiLanguageModelUsage | null;
}

export interface IAgentSidecarToolProjection {
  toolCalls: IAiToolCall[];
  activityText: string;
}

export type TAgentSidecarToolStreamStatus = 'streaming' | 'completed' | 'cancelled';

type TAgentRuntimeToolEvent = Extract<
  TAgentRuntimeEvent,
  { type: 'agent.tool.started' | 'agent.tool.completed' }
>;

type TAgentUiRuntimeToolEvent = Extract<TAgentUiEvent, { type: 'agent_event' }> & {
  event: TAgentRuntimeToolEvent;
};

/* ============================================================================
 * Tool name catalogs
 * ========================================================================== */

const AI_AGENT_TOOL_NAME_SET = new Set<string>(AI_AGENT_TOOL_NAMES);

const SIDECAR_FILE_MUTATION_TOOL_NAMES = new Set<string>([
  'write_file',
  'edit_file',
  'apply_file_edits',
  'propose_file_patch',
  'mastra_workspace_edit_file',
  'mastra_workspace_write_file',
  'mastra_workspace_ast_edit',
  'create_directory',
  'move_file',
  'delete_file',
]);

// 内部运维类工具（如 Mastra 工作内存写入）禁止对外展示为工具调用或动态提示文本。
// 这类工具会传输 { memory: { currentTask: ... } } 格式原始数据，导致“正在思考”折叠栏上方
// 出现带「处理」前缀的杂乱内容。tool_start、tool_result 及运行时智能体事件三条链路均需拦截。
const SIDECAR_HIDDEN_TOOL_NAMES = new Set<string>([
  'updateWorkingMemory',
  'update_working_memory',
  '__updateWorkingMemory',
  '__update_working_memory__',
]);

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

const TIMELINE_DEBUG_EVENT_TYPES: ReadonlySet<TAgentRuntimeEvent['type']> = new Set([
  'acontext.token.checked',
  'acontext.provider_payload.checked',
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

const SIDECAR_COMMAND_KEYS = new Set<string>(['command', 'cmd', 'script']);

const SIDECAR_URL_KEYS = new Set<string>(['url', 'uri', 'href']);

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
  'grep_in_files',
  'mastra_workspace_grep',
]);

const FILE_READ_TOOL_NAMES = new Set<string>([
  'read_text_file',
  'read_media_file',
  'read_multiple_files',
  'read_current_file',
  'read_file_window',
  'read_selected_text',
  'read_file',
  'read_project_file',
  'get_file_info',
  'open_nodes',
  'mastra_workspace_read_file',
  'mastra_workspace_lsp_inspect',
]);

const DIRECTORY_TOOL_NAMES = new Set<string>([
  'mastra_workspace_list_files',
  'list_dir',
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
  list_dir: 'get_project_tree',
  directory_tree: 'get_project_tree',
  search_files: 'search_text',
  grep_in_files: 'search_text',
  search_symbols: 'search_symbols',
  get_file_info: 'read_file',
  read_file_window: 'read_file',
  list_allowed_directories: 'get_project_tree',
  list_project_files: 'get_project_tree',
  read_project_file: 'read_file',
  search_project_files: 'search_text',
  apply_file_edits: 'auto_apply_patch',
  propose_file_patch: 'auto_apply_patch',
  mastra_workspace_edit_file: 'auto_apply_patch',
  mastra_workspace_write_file: 'auto_apply_patch',
  mastra_workspace_ast_edit: 'auto_apply_patch',
  mastra_workspace_list_files: 'get_project_tree',
  mastra_workspace_lsp_inspect: 'get_diagnostics',
  mastra_workspace_grep: 'search_text',
  mastra_workspace_read_file: 'read_file',
  mastra_workspace_execute_command: 'run_command',
  mastra_workspace_delete: 'run_command',
  mastra_workspace_mkdir: 'auto_apply_patch',
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

/* ============================================================================
 * Plan step mapping
 * ========================================================================== */

const normalizeStatus = (status: IAgentPlanStep['status']): TAiAgentPlanStepStatus => status;

const inferStepKind = (tools: readonly string[]): TAiAgentPlanStepKind => {
  if (
    tools.some(
      (tool) =>
        tool === 'search_project_files' ||
        tool === 'search_files' ||
        tool === 'search_text' ||
        tool === 'search_symbols' ||
        tool === 'grep_in_files' ||
        tool === 'mastra_workspace_grep' ||
        tool === 'tavily-search' ||
        tool === 'tavily-map' ||
        tool === 'tavily_search' ||
        tool === 'tavily_map' ||
        tool === 'tavily_research' ||
        tool === 'search_nodes',
    )
  ) {
    return 'search';
  }
  if (
    tools.some(
      (tool) =>
        tool === 'write_file' ||
        tool === 'edit_file' ||
        tool === 'apply_file_edits' ||
        tool === 'propose_file_patch' ||
        tool === 'mastra_workspace_edit_file' ||
        tool === 'mastra_workspace_write_file' ||
        tool === 'mastra_workspace_ast_edit' ||
        tool === 'create_directory' ||
        tool === 'move_file' ||
        tool === 'delete_file' ||
        tool === 'propose_patch' ||
        tool === 'auto_apply_patch',
    )
  ) {
    return 'edit';
  }
  if (
    tools.some(
      (tool) =>
        tool === 'run_shell_command' ||
        tool === 'install_package' ||
        tool === 'run_command' ||
        tool === 'run_test',
    )
  ) {
    return 'verify';
  }
  if (
    tools.some(
      (tool) =>
        tool === 'git_commit' ||
        tool === 'git_status' ||
        tool === 'git_log' ||
        tool === 'git_show' ||
        tool === 'git_diff_unstaged' ||
        tool === 'git_diff_staged' ||
        tool === 'create_commit' ||
        tool === 'stage_file',
    )
  ) {
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
    ...(step.description ? { description: step.description } : {}),
    kind: inferStepKind(step.tools),
    status: normalizeStatus(step.status),
    expectedOutput: step.expectedOutput,
    tools: step.tools.map(mapSidecarToolNameToAiToolName),
    ...(step.files?.length ? { files: step.files } : {}),
    ...(step.commands?.length ? { commands: step.commands } : {}),
    ...(step.risks?.length ? { risks: step.risks } : {}),
    ...(step.acceptanceCriteria?.length ? { acceptanceCriteria: step.acceptanceCriteria } : {}),
    requiresUserApproval: step.requiresApproval,
    riskLevel: step.riskLevel,
    ...(step.requiresApproval
      ? { rollbackStrategy: '执行前由后端生成快照，失败或用户不满意时可按任务回滚。' }
      : {}),
  }));

/* ============================================================================
 * JSON helpers
 * ========================================================================== */

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

const clipSummary = (value: string, limit = 96): string => {
  return clipTextPreview(value, { maxGraphemes: limit });
};

const getRecordValue = (value: TJsonValue, key: string): TJsonValue | undefined => {
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

const isJsonObject = (value: TJsonValue): value is { readonly [key: string]: TJsonValue } =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const getBooleanField = (value: TJsonValue, key: string): boolean | null => {
  const candidate = getRecordValue(value, key);
  return typeof candidate === 'boolean' ? candidate : null;
};

const getStringArrayField = (value: TJsonValue, key: string): string[] => {
  const candidate = getRecordValue(value, key);
  if (!Array.isArray(candidate)) {
    return [];
  }
  return candidate.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0,
  );
};

const getObjectArrayField = (
  value: TJsonValue,
  key: string,
): { readonly [key: string]: TJsonValue }[] => {
  const candidate = getRecordValue(value, key);
  if (!Array.isArray(candidate)) {
    return [];
  }
  return candidate.filter(isJsonObject);
};

/* ============================================================================
 * Validation report parsing
 * ========================================================================== */

const toValidationSeverity = (value: string | null): TAiAgentPlanRiskLevel =>
  AI_AGENT_PLAN_RISK_LEVELS.includes(value as TAiAgentPlanRiskLevel)
    ? (value as TAiAgentPlanRiskLevel)
    : 'medium';

const toValidationStatus = (value: string | null): TAgentSidecarPlanValidationStatus | null =>
  AGENT_SIDECAR_PLAN_VALIDATION_STATUSES.includes(value as TAgentSidecarPlanValidationStatus)
    ? (value as TAgentSidecarPlanValidationStatus)
    : null;

const parseValidationFinding = (value: {
  readonly [key: string]: TJsonValue;
}): IAgentSidecarPlanValidationFinding => ({
  stepId: getStringField(value, ['stepId']) ?? null,
  severity: toValidationSeverity(getStringField(value, ['severity'])),
  title: getStringField(value, ['title']) ?? '验证发现',
  detail: getStringField(value, ['detail']) ?? '',
  retryable: getBooleanField(value, 'retryable') ?? false,
});

const parseValidationAcceptance = (value: {
  readonly [key: string]: TJsonValue;
}): IAgentSidecarPlanValidationAcceptance => ({
  criterion: getStringField(value, ['criterion']) ?? '验收项',
  passed: getBooleanField(value, 'passed') ?? false,
  detail: getStringField(value, ['detail']) ?? '',
});

const parseValidationReport = (value: TJsonValue): IAgentSidecarPlanValidationReport | null => {
  const reportValue = isJsonObject(value) && isJsonObject(value.report) ? value.report : value;
  if (!isJsonObject(reportValue)) {
    return null;
  }
  const status = toValidationStatus(getStringField(reportValue, ['status']));
  const summary = getStringField(reportValue, ['summary']);
  const needsReplan = getBooleanField(reportValue, 'needsReplan');
  if (!status || !summary || needsReplan === null) {
    return null;
  }
  return {
    status,
    summary,
    checkedStepIds: getStringArrayField(reportValue, 'checkedStepIds'),
    needsReplan,
    findings: getObjectArrayField(reportValue, 'findings').map(parseValidationFinding),
    acceptance: getObjectArrayField(reportValue, 'acceptance').map(parseValidationAcceptance),
  };
};

/* ============================================================================
 * Tool payload introspection
 * ========================================================================== */

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

const collectFirstString = (value: TJsonValue, keys: ReadonlySet<string>): string | null => {
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

const collectUrlDomains = (value: TJsonValue, limit = 2): string | null => {
  const urls: string[] = [];
  collectStringValuesForKeys(value, SIDECAR_URL_KEYS, urls);
  return formatStringList(
    urls.map(extractUrlHost).filter((host): host is string => Boolean(host)),
    limit,
  );
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

const joinTargetParts = (parts: readonly (string | null)[], fallback: string): string => {
  const normalized = uniqueNonEmptyStrings(parts.filter((part): part is string => Boolean(part)));
  return normalized.length ? normalized.map((part) => clipSummary(part, 52)).join(' · ') : fallback;
};

const describeToolPayload = (toolName: string, value: TJsonValue): IToolPayloadDescriptor => {
  const platform = getToolPlatform(toolName);
  const query = collectFirstString(value, SIDECAR_QUERY_KEYS);
  const scope = collectStringList(value, SIDECAR_PATH_SCOPE_KEYS, 2);
  const url = collectFirstString(value, SIDECAR_URL_KEYS);
  const domains = collectStringList(value, SIDECAR_DOMAIN_KEYS, 2) ?? collectUrlDomains(value, 2);
  const command = collectFirstString(value, SIDECAR_COMMAND_KEYS);
  if (WEB_SEARCH_TOOL_NAMES.has(toolName)) {
    const targetPreview = joinTargetParts([query, domains], '联网搜索');
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
      detailItems: compactDetailItems([createDetailItem('文件', scope)]),
    };
  }
  if (DIRECTORY_TOOL_NAMES.has(toolName)) {
    const targetPreview = joinTargetParts([scope], '项目结构');
    return {
      targetPreview,
      summary: targetPreview,
      detailItems: compactDetailItems([createDetailItem('目录', scope ?? '项目结构')]),
    };
  }
  if (GIT_TOOL_NAMES.has(toolName)) {
    const targetPreview = joinTargetParts([scope], 'Git 变更');
    return {
      targetPreview,
      summary: targetPreview,
      detailItems: compactDetailItems([createDetailItem('范围', scope ?? '当前仓库')]),
    };
  }
  if (command) {
    return {
      targetPreview: command,
      summary: command,
      detailItems: compactDetailItems([createDetailItem('命令', command)]),
    };
  }
  const fallback = summarizeJsonValue(value);
  return {
    targetPreview: fallback,
    summary: fallback,
    detailItems: [],
  };
};

/* ============================================================================
 * Tool result text extraction
 * ========================================================================== */

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

const RESULT_HEADING_PATTERN = /^(?:Detailed Results?|Results?|Tool Result|Output)\s*:?\s*$/iu;
const RESULT_FIELD_LABEL_PATTERN = /^(?:Title|Summary|Content|Result|Answer|Description)\s*:\s*/iu;
const URL_FIELD_LABEL_PATTERN = /^URL\s*:\s*/iu;

const cleanReadableToolText = (value: string): string | null => {
  const lines = value
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .filter((line) => line && !RESULT_HEADING_PATTERN.test(line));
  const contentLine =
    lines.find(
      (line) => RESULT_FIELD_LABEL_PATTERN.test(line) && !URL_FIELD_LABEL_PATTERN.test(line),
    ) ?? lines.find((line) => !URL_FIELD_LABEL_PATTERN.test(line));
  if (!contentLine) {
    return null;
  }
  const normalized = contentLine.replace(RESULT_FIELD_LABEL_PATTERN, '').trim();
  return normalized ? clipSummary(normalized) : null;
};

const collectReadableToolTexts = (value: TJsonValue, texts: string[], depth = 0): void => {
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

/* ============================================================================
 * Event predicates & extraction
 * ========================================================================== */

const isSidecarFileMutationEvent = (
  event: TAgentUiEvent,
): event is Extract<TAgentUiEvent, { type: 'tool_start' | 'tool_result' }> =>
  (event.type === 'tool_start' || event.type === 'tool_result') &&
  SIDECAR_FILE_MUTATION_TOOL_NAMES.has(event.toolName);

const isAgentRuntimeToolEvent = (event: TAgentRuntimeEvent): event is TAgentRuntimeToolEvent =>
  event.type === 'agent.tool.started' || event.type === 'agent.tool.completed';

const isRuntimeFileMutationEvent = (event: TAgentUiEvent): event is TAgentUiRuntimeToolEvent =>
  event.type === 'agent_event' &&
  isAgentRuntimeToolEvent(event.event) &&
  SIDECAR_FILE_MUTATION_TOOL_NAMES.has(event.event.toolName);

export const hasSidecarFileMutationEvent = (events: readonly TAgentUiEvent[]): boolean =>
  events.some((event) => isSidecarFileMutationEvent(event) || isRuntimeFileMutationEvent(event));

export const extractVisibleAgentRuntimeEvents = (
  events: readonly TAgentUiEvent[],
): TAgentRuntimeEvent[] =>
  events
    .filter(
      (event): event is Extract<TAgentUiEvent, { type: 'agent_event' }> =>
        event.type === 'agent_event' &&
        (event.event.visibility === 'user' || TIMELINE_DEBUG_EVENT_TYPES.has(event.event.type)),
    )
    .map((event) => event.event);

export const extractSidecarChangedFilePaths = (events: readonly TAgentUiEvent[]): string[] => {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (isSidecarFileMutationEvent(event)) {
      collectPathCandidates(event.type === 'tool_start' ? event.input : event.output, paths);
      continue;
    }
    if (isRuntimeFileMutationEvent(event)) {
      const runtimeEvent = event.event;
      const preview =
        runtimeEvent.type === 'agent.tool.started'
          ? runtimeEvent.inputPreview
          : runtimeEvent.resultPreview;
      const parsedPreview = preview ? (parseJsonString(preview) ?? preview) : null;
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

/* ============================================================================
 * JSON summarization (for tool result preview)
 * ========================================================================== */

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
    const firstText = value.find(
      (item): item is string => typeof item === 'string' && item.trim().length > 0,
    );
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

/* ============================================================================
 * Tool call construction (sidecar lifecycle + runtime events)
 * ========================================================================== */

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
): string => (event.toolUseId ? `runtime-tool:${event.toolUseId}` : `runtime-tool:${event.id}`);

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
    : (event.errorMessage ?? '工具执行失败');
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
      ...(existing.targetPreview
        ? { targetPreview: existing.targetPreview }
        : { targetPreview: descriptor.targetPreview }),
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

/* ============================================================================
 * Activity text generation
 * ========================================================================== */

const WEB_TOOL_NAME_PATTERN = /(?:web|tavily)/iu;
const FILE_SEARCH_TOOL_NAME_PATTERN =
  /(?:search_(?:project_)?files|search_text|search_symbols|grep_in_files|mastra_workspace_grep)/iu;
const DIRECTORY_TOOL_NAME_PATTERN =
  /(?:list_dir|list_directory|directory_tree|get_project_tree|list_project_files|mastra_workspace_list_files)/iu;
const FILE_READ_TOOL_NAME_PATTERN =
  /(?:read_|get_file_info|open_nodes|mastra_workspace_lsp_inspect)/iu;
const FILE_MUTATION_TOOL_NAME_PATTERN =
  /(?:write_file|edit_file|create_directory|move_file|delete_file|patch|mastra_workspace_write_file|mastra_workspace_edit_file|mastra_workspace_ast_edit|mastra_workspace_mkdir|mastra_workspace_delete)/iu;
const COMMAND_TOOL_NAME_PATTERN = /(?:run_|shell|command|install_package)/iu;
const GIT_TOOL_NAME_PATTERN = /(?:^git_|get_git_|create_commit|stage_file)/iu;
const TIME_TOOL_NAME_PATTERN = /(?:time)/iu;

const COMMAND_ACTIVITY_TOOL_NAMES = new Set<string>([
  'run_command',
  'mastra_workspace_execute_command',
]);

const getToolDetailValue = (toolCall: IAiToolCall, label: string): string | null => {
  const prefix = `${label}：`;
  const item = toolCall.detailItems?.find((detail) => detail.startsWith(prefix));
  return item ? item.slice(prefix.length).trim() || null : null;
};

const isActiveToolCall = (toolCall: IAiToolCall): boolean => toolCall.status === 'running';

const isPendingToolCall = (toolCall: IAiToolCall): boolean => toolCall.status === 'pending';

const getMutationVerb = (toolCall: IAiToolCall): string => {
  switch (toolCall.name) {
    case 'create_directory':
      return isActiveToolCall(toolCall) ? '正在创建目录' : '已创建目录';
    case 'move_file':
      return isActiveToolCall(toolCall) ? '正在移动' : '已移动';
    case 'delete_file':
      return isActiveToolCall(toolCall) ? '正在删除' : '已删除';
    case 'write_file':
      return isActiveToolCall(toolCall) ? '正在写入' : '已写入';
    default:
      return isActiveToolCall(toolCall) ? '正在编辑' : '已编辑';
  }
};

const buildToolActivityText = (toolCall: IAiToolCall): string => {
  const target = toolCall.targetPreview?.trim() || toolCall.summary.trim();
  const query = getToolDetailValue(toolCall, '查询') ?? getToolDetailValue(toolCall, '搜索');
  const scope = getToolDetailValue(toolCall, '范围');
  const file = getToolDetailValue(toolCall, '文件');
  const directory = getToolDetailValue(toolCall, '目录');
  const site = getToolDetailValue(toolCall, '站点');
  const url = getToolDetailValue(toolCall, '网址');
  if (isPendingToolCall(toolCall)) {
    return target ? `等待确认 ${target}` : '等待确认';
  }
  if (toolCall.status === 'failed') {
    return target ? `执行失败 ${target}` : '执行失败';
  }
  if (toolCall.status === 'denied') {
    return target ? `已停止 ${target}` : '已停止';
  }
  if (WEB_TOOL_NAME_PATTERN.test(toolCall.name)) {
    const searchTarget = query ?? url ?? site ?? target;
    const isFetch = Boolean(url && !query);
    const verb = isFetch
      ? isActiveToolCall(toolCall)
        ? '正在读取网页'
        : '读取网页'
      : isActiveToolCall(toolCall)
        ? '正在联网搜索'
        : '联网搜索';
    const siteHint = site && query ? `，站点 ${site}` : '';
    return searchTarget ? `${verb}「${searchTarget}」${siteHint}` : verb;
  }
  if (FILE_SEARCH_TOOL_NAME_PATTERN.test(toolCall.name)) {
    const searchTarget = query ?? target;
    if (isActiveToolCall(toolCall)) {
      const scopeHint = scope ? `，范围 ${scope}` : '';
      return searchTarget ? `正在搜索「${searchTarget}」${scopeHint}` : '正在搜索工作区';
    }
    const scopeHint = scope ?? '工作区';
    return searchTarget ? `在 ${scopeHint} 搜索「${searchTarget}」` : `搜索 ${scopeHint}`;
  }
  if (DIRECTORY_TOOL_NAME_PATTERN.test(toolCall.name)) {
    return `${isActiveToolCall(toolCall) ? '正在查看目录' : '查看目录'} ${directory ?? target}`;
  }
  if (FILE_READ_TOOL_NAME_PATTERN.test(toolCall.name)) {
    return `${isActiveToolCall(toolCall) ? '正在读取' : '查看文件'} ${file ?? target}`;
  }
  if (FILE_MUTATION_TOOL_NAME_PATTERN.test(toolCall.name)) {
    return `${getMutationVerb(toolCall)} ${file ?? target}`;
  }
  if (GIT_TOOL_NAME_PATTERN.test(toolCall.name)) {
    return isActiveToolCall(toolCall) ? '正在检查 Git 变更' : '查看 Git 变更';
  }
  if (COMMAND_TOOL_NAME_PATTERN.test(toolCall.name)) {
    const commandTarget = COMMAND_ACTIVITY_TOOL_NAMES.has(toolCall.name)
      ? (getToolDetailValue(toolCall, '命令') ?? '命令')
      : target;
    return `${isActiveToolCall(toolCall) ? '正在运行' : '运行'} ${commandTarget}`;
  }
  if (TIME_TOOL_NAME_PATTERN.test(toolCall.name)) {
    return isActiveToolCall(toolCall) ? '正在获取时间' : '获取时间';
  }
  return target
    ? `${isActiveToolCall(toolCall) ? '正在处理' : '处理'} ${target}`
    : isActiveToolCall(toolCall)
      ? '正在处理任务'
      : '处理任务';
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
  return fallback || '';
};

const buildCompletedSidecarActivityText = (
  toolCalls: readonly IAiToolCall[],
  fallback: string,
): string => {
  const lastToolCall = [...toolCalls]
    .reverse()
    .find(
      (toolCall) =>
        toolCall.status === 'succeeded' ||
        toolCall.status === 'failed' ||
        toolCall.status === 'denied' ||
        toolCall.status === 'pending' ||
        toolCall.status === 'running',
    );
  return lastToolCall ? buildToolActivityText(lastToolCall) : fallback || '请求处理中';
};

/* ============================================================================
 * Tool call mapping (sidecar event stream → IAiToolCall[])
 * ========================================================================== */

export const mapSidecarEventsToToolCalls = (events: readonly TAgentUiEvent[]): IAiToolCall[] => {
  const toolCalls: IAiToolCall[] = [];
  const runtimeToolNames = new Set<string>();
  for (const event of events) {
    if (event.type === 'agent_event' && isAgentRuntimeToolEvent(event.event)) {
      runtimeToolNames.add(event.event.toolName);
    }
  }
  for (const [index, event] of events.entries()) {
    if (event.type === 'tool_start') {
      if (SIDECAR_HIDDEN_TOOL_NAMES.has(event.toolName)) {
        continue;
      }
      if (runtimeToolNames.has(event.toolName)) {
        continue;
      }
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
      if (SIDECAR_HIDDEN_TOOL_NAMES.has(event.toolName)) {
        continue;
      }
      if (runtimeToolNames.has(event.toolName)) {
        continue;
      }
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
        ...(descriptor.detailItems.length
          ? {
              targetPreview: descriptor.targetPreview,
              detailItems: descriptor.detailItems,
            }
          : {}),
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
      if (
        isAgentRuntimeToolEvent(event.event) &&
        SIDECAR_HIDDEN_TOOL_NAMES.has(event.event.toolName)
      ) {
        continue;
      }
      applyRuntimeToolEventToToolCalls(toolCalls, event.event);
    }
  }
  return toolCalls;
};

export const projectSidecarEventsToToolState = (params: {
  events: readonly TAgentUiEvent[];
  fallbackActivityText: string;
  streamStatus: TAgentSidecarToolStreamStatus;
}): IAgentSidecarToolProjection => {
  const toolCalls = mapSidecarEventsToToolCalls(params.events);
  const activityText =
    params.streamStatus === 'streaming'
      ? buildSidecarLiveActivityText(toolCalls, params.fallbackActivityText)
      : buildCompletedSidecarActivityText(toolCalls, params.fallbackActivityText);
  return {
    toolCalls,
    activityText,
  };
};

/* ============================================================================
 * Plan / record / done / message extraction
 *
 * `findLastEventByType` 统一封装"从尾向头扫,找最后一个匹配 type 的事件"的
 * 模式 —— 之前三个 extractLatest* 函数各写了一遍同样的循环。
 * ========================================================================== */

const findLastEventByType = <K extends TAgentUiEvent['type']>(
  events: readonly TAgentUiEvent[],
  type: K,
): Extract<TAgentUiEvent, { type: K }> | null => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === type) {
      return event as Extract<TAgentUiEvent, { type: K }>;
    }
  }
  return null;
};

const extractPlan = (events: readonly TAgentUiEvent[]): IAgentPlan | null =>
  events.find(
    (event): event is Extract<TAgentUiEvent, { type: 'plan_ready' }> => event.type === 'plan_ready',
  )?.plan ?? null;

const extractPlanReadyEvent = (
  events: readonly TAgentUiEvent[],
): Extract<TAgentUiEvent, { type: 'plan_ready' }> | null =>
  events.find(
    (event): event is Extract<TAgentUiEvent, { type: 'plan_ready' }> => event.type === 'plan_ready',
  ) ?? null;

const extractPlanRecordEvent = (
  events: readonly TAgentUiEvent[],
): Extract<TAgentUiEvent, { type: 'plan_record' }> | null =>
  events.find(
    (event): event is Extract<TAgentUiEvent, { type: 'plan_record' }> =>
      event.type === 'plan_record',
  ) ?? null;

const extractErrorMessage = (events: readonly TAgentUiEvent[]): string | null =>
  events.find((event): event is Extract<TAgentUiEvent, { type: 'error' }> => event.type === 'error')
    ?.message ?? null;

const planReadyToMetadata = (
  event: Extract<TAgentUiEvent, { type: 'plan_ready' }>,
): IAiAgentPlanMetadata => ({
  planId: event.planId,
  ...(event.threadId ? { threadId: event.threadId } : {}),
  version: event.version,
  status: event.status,
  ...(event.createdAt ? { createdAt: event.createdAt } : {}),
  ...(event.updatedAt ? { updatedAt: event.updatedAt } : {}),
  ...(event.approvedAt !== undefined ? { approvedAt: event.approvedAt } : {}),
  ...(event.executedAt !== undefined ? { executedAt: event.executedAt } : {}),
  ...(event.rejectionReason !== undefined ? { rejectionReason: event.rejectionReason } : {}),
  ...(event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}),
  ...(event.plan.summary ? { summary: event.plan.summary } : {}),
  ...(event.plan.requiresApproval !== undefined
    ? { requiresApproval: event.plan.requiresApproval }
    : {}),
});

const planRecordToMetadata = (record: IAgentPlanRecord): IAiAgentPlanMetadata => ({
  planId: record.planId,
  threadId: record.threadId,
  version: record.version,
  status: record.status,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  approvedAt: record.approvedAt,
  executedAt: record.executedAt,
  rejectionReason: record.rejectionReason,
  errorMessage: record.errorMessage,
  ...(record.plan.summary ? { summary: record.plan.summary } : {}),
  ...(record.plan.requiresApproval !== undefined
    ? { requiresApproval: record.plan.requiresApproval }
    : {}),
});

const planRecordToVersionSummary = (record: IAgentPlanRecord): IAiAgentPlanVersionSummary => ({
  ...planRecordToMetadata(record),
  userRequest: record.userRequest,
});

const hasMeaningfulText = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const extractDoneResult = (events: readonly TAgentUiEvent[]): string | null => {
  const event = findLastEventByType(events, 'done');
  return event && hasMeaningfulText(event.result) ? event.result : null;
};

/* ============================================================================
 * Language model usage normalization
 *
 * 让所有下游消费者拿到的 IAiLanguageModelUsage 一定有 detail 子结构,而不是
 * 让 store / UI 端到处写 `?? 0` 守卫。原始 sidecar usage 是否真的有这些字段
 * 取决于 mastra 的 LanguageModel,缺失时用 0 占位,语义等价于"未上报"。
 * ========================================================================== */

const DEFAULT_INPUT_TOKEN_DETAILS: NonNullable<IAiLanguageModelUsage['inputTokenDetails']> = {
  noCacheTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

const DEFAULT_OUTPUT_TOKEN_DETAILS: NonNullable<IAiLanguageModelUsage['outputTokenDetails']> = {
  textTokens: 0,
  reasoningTokens: 0,
};

const normalizeLanguageModelUsage = (usage: IAiLanguageModelUsage): IAiLanguageModelUsage => ({
  ...usage,
  inputTokenDetails: usage.inputTokenDetails ?? DEFAULT_INPUT_TOKEN_DETAILS,
  outputTokenDetails: usage.outputTokenDetails ?? DEFAULT_OUTPUT_TOKEN_DETAILS,
});

const extractLatestDoneUsage = (events: readonly TAgentUiEvent[]): IAiLanguageModelUsage | null => {
  const usage = findLastEventByType(events, 'done')?.usage;
  return usage ? normalizeLanguageModelUsage(usage) : null;
};

export const resolveSidecarOfficialUsage = (
  response: IAgentSidecarResponsePayload,
): ISidecarOfficialUsageResolution => ({
  resolved: response.events.some((event) => event.type === 'done' || event.type === 'error'),
  usage: extractLatestDoneUsage(response.events),
});

const extractLatestMessageDelta = (events: readonly TAgentUiEvent[]): string | null => {
  const event = findLastEventByType(events, 'message_delta');
  return event && hasMeaningfulText(event.text) ? event.text : null;
};

/* ============================================================================
 * Assistant content composition
 * ========================================================================== */

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

/* ============================================================================
 * Top-level response projections
 * ========================================================================== */

export const projectSidecarPlanResponse = (
  response: IAgentSidecarResponsePayload,
  fallbackGoal: string,
): IAgentSidecarPlanProjection => {
  const planReady = extractPlanReadyEvent(response.events);
  const plan = planReady?.plan ?? extractPlan(response.events);
  const errorMessage = extractErrorMessage(response.events);
  const goal = plan?.goal ?? fallbackGoal;
  return {
    goal,
    summary: plan?.summary ?? null,
    planMetadata: plan && planReady ? planReadyToMetadata(planReady) : null,
    steps: plan ? mapSidecarPlanToTaskSteps(plan) : [],
    toolCalls: mapSidecarEventsToToolCalls(response.events),
    assistantContent: buildAssistantContent(goal, plan, extractDoneResult(response.events)),
    errorMessage: errorMessage ?? (plan ? null : 'sidecar 未返回 plan_ready 事件，计划没有生成。'),
  };
};

export const projectSidecarPlanRecordResponse = (
  response: IAgentSidecarResponsePayload,
): IAgentSidecarPlanRecordProjection => {
  const event = extractPlanRecordEvent(response.events);
  return {
    record: event?.record ?? null,
    versions: event?.versions.map(planRecordToVersionSummary) ?? [],
    metadata: event ? planRecordToMetadata(event.record) : null,
    errorMessage: extractErrorMessage(response.events),
  };
};

export const projectSidecarPlanValidationResponse = (
  response: IAgentSidecarResponsePayload,
): IAgentSidecarPlanValidationProjection => {
  const validatorResult = response.events.find(
    (event): event is Extract<TAgentUiEvent, { type: 'tool_result' }> =>
      event.type === 'tool_result' && event.toolName === 'plan_validator',
  );
  const report = validatorResult ? parseValidationReport(validatorResult.output) : null;
  return {
    report,
    errorMessage:
      extractErrorMessage(response.events) ??
      (report ? null : 'sidecar 未返回有效的计划验证报告。'),
  };
};

/* ============================================================================
 * Tool confirmation (approval) mapping
 * ========================================================================== */

const TOOL_CONFIRMATION_OPTIONS: IAiToolConfirmationRequest['options'] = [
  { id: 'allow-once', label: '允许', tone: 'primary' },
  { id: 'stop', label: '拒绝', tone: 'danger' },
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
  const approval = response.events.find(
    (event): event is Extract<TAgentUiEvent, { type: 'approval_required' }> =>
      event.type === 'approval_required',
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
  const pendingConfirmation = extractPendingConfirmation(response);
  const assistantContent = errorMessage
    ? `Agent 执行失败：${errorMessage}`
    : (doneResult ??
      responseResult ??
      latestDelta ??
      (pendingConfirmation ? '' : 'Agent 已完成。'));
  return {
    toolCalls: mapSidecarEventsToToolCalls(response.events),
    assistantContent,
    errorMessage,
    pendingConfirmation,
    changedFilePaths,
    hasFileMutations,
  };
};
