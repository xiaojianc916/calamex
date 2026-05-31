import {
  extractFileNameFromPath,
  previewHasResultItems,
  resolvePreviewCommand,
  resolvePreviewQuery,
} from './preview';
import {
  extractShellcheckDiagnosticCodes,
  formatShellcheckIssueAction,
  hasShellcheckPassSummary,
  hasShellcheckUnavailableSummary,
} from './shellcheck';
import {
  isWebSearchToolName,
  resolveWebSearchQuery,
  resolveWebSearchSources,
} from './web-search';
import type { IToolActionDescriptor, TToolLifecycleEvent } from './types';

type TToolPhase = 'running' | 'done' | 'failed';

type TToolResourceKind = 'none' | 'file' | 'query' | 'command';

/**
 * 单个具体工具的语义文案。每个工具一条，而不是按大类兜底。
 * - {name} 会被替换为该工具操作的资源名（文件名 / 搜索词 / 命令）。
 * - emptyDone 用于“完成但无结果”的搜索类工具。
 */
interface IToolPhrases {
  resource?: TToolResourceKind;
  running: string;
  done: string;
  failed: string;
  emptyDone?: string;
}

const RESOURCE_FALLBACK_LABEL: Record<Exclude<TToolResourceKind, 'none'>, string> = {
  file: '文件',
  query: '搜索词',
  command: '命令',
};

const READ_FILE_PHRASES: IToolPhrases = {
  resource: 'file',
  running: '正在查看 {name}',
  done: '已查看 {name}',
  failed: '查看失败 {name}',
};

const WRITE_FILE_PHRASES: IToolPhrases = {
  resource: 'file',
  running: '正在编辑 {name}',
  done: '编辑完成 {name}',
  failed: '编辑失败 {name}',
};

const COMMAND_PHRASES: IToolPhrases = {
  resource: 'command',
  running: '正在执行 {name}',
  done: '执行完成 {name}',
  failed: '执行失败 {name}',
};

const DIRECTORY_PHRASES: IToolPhrases = {
  running: '正在读取工作区目录',
  done: '工作区目录读取完成',
  failed: '工作区目录读取失败',
};

const TEXT_SEARCH_PHRASES: IToolPhrases = {
  resource: 'query',
  running: '正在搜索 {name}',
  done: '成功读取到 {name}',
  emptyDone: '未读取到 {name}',
  failed: '未读取到 {name}',
};

const SYMBOL_SEARCH_PHRASES: IToolPhrases = {
  resource: 'query',
  running: '正在结构化搜索 {name}',
  done: '成功搜索到 {name}',
  emptyDone: '未搜索到 {name}',
  failed: '未搜索到 {name}',
};

const GIT_PHRASES: IToolPhrases = {
  running: '正在执行版本控制操作',
  done: '版本控制操作完成',
  failed: '版本控制操作失败',
};

const BROWSER_PHRASES: IToolPhrases = {
  running: '正在操作浏览器',
  done: '浏览器操作完成',
  failed: '浏览器操作失败',
};

const PYLANCE_PHRASES: IToolPhrases = {
  running: '正在分析 Python 代码',
  done: 'Python 代码分析完成',
  failed: 'Python 代码分析失败',
};

const DEBUG_PHRASES: IToolPhrases = {
  running: '正在调试',
  done: '调试完成',
  failed: '调试失败',
};

const WORKING_MEMORY_PHRASES: IToolPhrases = {
  running: '正在更新工作记忆',
  done: '工作记忆已更新',
  failed: '工作记忆更新失败',
};

/** 逐工具注册表：键为规范化后的小写工具名。 */
const TOOL_PHRASE_ENTRIES: Record<string, IToolPhrases> = {
  mcp_list_tools: {
    running: '正在查找MCP工具集',
    done: '成功获取MCP工具集',
    failed: '查找MCP工具集失败',
  },
  mcp_call_tool: {
    running: '正在调用 MCP 工具',
    done: 'MCP 工具调用完成',
    failed: 'MCP 工具调用失败',
  },

  read_file: READ_FILE_PHRASES,
  read_text_file: READ_FILE_PHRASES,
  read_file_window: READ_FILE_PHRASES,
  read_project_file: READ_FILE_PHRASES,
  mastra_workspace_read_file: READ_FILE_PHRASES,
  mastra_workspace_lsp_inspect: READ_FILE_PHRASES,
  read_multiple_files: {
    running: '正在批量读取文件',
    done: '文件批量读取完成',
    failed: '文件批量读取失败',
  },
  get_file_info: {
    resource: 'file',
    running: '正在读取文件信息 {name}',
    done: '文件信息读取完成',
    failed: '文件信息读取失败',
  },
  view_image: { running: '正在查看图片', done: '图片查看完成', failed: '图片查看失败' },
  read_media_file: { running: '正在查看媒体文件', done: '媒体文件查看完成', failed: '媒体文件查看失败' },
  copilot_getnotebooksummary: {
    running: '正在读取笔记本摘要',
    done: '笔记本摘要读取完成',
    failed: '笔记本摘要读取失败',
  },
  get_errors: { running: '正在检查错误', done: '错误检查完成', failed: '错误检查失败' },
  get_changed_files: { running: '正在读取改动文件', done: '改动文件读取完成', failed: '改动文件读取失败' },
  mastra_list_logs: { running: '正在读取日志', done: '日志读取完成', failed: '日志读取失败' },
  read_current_file: {
    running: '正在读取当前文件',
    done: '当前文件读取完成',
    failed: '当前文件读取失败',
  },

  mastra_workspace_list_files: DIRECTORY_PHRASES,
  list_dir: DIRECTORY_PHRASES,
  list_directory: DIRECTORY_PHRASES,
  list_workspace_entries: DIRECTORY_PHRASES,
  directory_tree: { running: '正在读取目录结构', done: '目录结构读取完成', failed: '目录结构读取失败' },

  grep_in_files: TEXT_SEARCH_PHRASES,
  mastra_workspace_grep: TEXT_SEARCH_PHRASES,
  grep_search: { running: '正在搜索', done: '搜索完成', failed: '搜索失败' },
  file_search: { resource: 'query', running: '正在查找文件 {name}', done: '文件查找完成', failed: '文件查找失败' },
  search_files: { resource: 'query', running: '正在查找文件 {name}', done: '文件查找完成', failed: '文件查找失败' },
  semantic_search: { resource: 'query', running: '正在语义搜索 {name}', done: '语义搜索完成', failed: '语义搜索失败' },
  search_project_files: { resource: 'query', running: '正在搜索项目文件 {name}', done: '项目文件搜索完成', failed: '项目文件搜索失败' },
  search_text: { resource: 'query', running: '正在搜索文本 {name}', done: '文本搜索完成', failed: '文本搜索失败' },

  search_symbols: SYMBOL_SEARCH_PHRASES,
  vscode_listcodeusages: {
    resource: 'query',
    running: '正在查找代码引用 {name}',
    done: '代码引用查找完成',
    failed: '代码引用查找失败',
  },
  vscode_renamesymbol: {
    resource: 'query',
    running: '正在重命名符号 {name}',
    done: '符号重命名完成',
    failed: '符号重命名失败',
  },

  write_file: WRITE_FILE_PHRASES,
  apply_patch: WRITE_FILE_PHRASES,
  apply_file_edits: WRITE_FILE_PHRASES,
  string_replace_lsp: WRITE_FILE_PHRASES,
  propose_file_patch: WRITE_FILE_PHRASES,
  mastra_workspace_write_file: WRITE_FILE_PHRASES,
  mastra_workspace_edit_file: WRITE_FILE_PHRASES,
  mastra_workspace_ast_edit: WRITE_FILE_PHRASES,
  create_file: {
    resource: 'file',
    running: '正在创建文件 {name}',
    done: '文件已创建 {name}',
    failed: '文件创建失败 {name}',
  },
  create_directory: { running: '正在创建目录', done: '目录已创建', failed: '目录创建失败' },
  mastra_workspace_mkdir: { running: '正在创建目录', done: '目录已创建', failed: '目录创建失败' },
  move_file: { running: '正在移动文件', done: '文件已移动', failed: '文件移动失败' },
  delete_file: {
    resource: 'file',
    running: '正在删除文件 {name}',
    done: '文件已删除 {name}',
    failed: '文件删除失败 {name}',
  },
  mastra_workspace_delete: {
    resource: 'file',
    running: '正在删除 {name}',
    done: '已删除 {name}',
    failed: '删除失败 {name}',
  },
  edit_notebook_file: { running: '正在编辑笔记本', done: '笔记本编辑完成', failed: '笔记本编辑失败' },
  create_new_jupyter_notebook: { running: '正在创建笔记本', done: '笔记本已创建', failed: '笔记本创建失败' },
  create_new_workspace: { running: '正在创建工作区', done: '工作区已创建', failed: '工作区创建失败' },

  run_command: COMMAND_PHRASES,
  run_in_terminal: COMMAND_PHRASES,
  mastra_workspace_execute_command: COMMAND_PHRASES,
  send_to_terminal: { running: '正在向终端发送命令', done: '命令已发送', failed: '命令发送失败' },
  get_terminal_output: { running: '正在读取终端输出', done: '终端输出读取完成', failed: '终端输出读取失败' },
  terminal_last_command: { running: '正在读取上一条命令', done: '命令读取完成', failed: '命令读取失败' },
  terminal_selection: { running: '正在读取终端选区', done: '终端选区读取完成', failed: '终端选区读取失败' },
  mastra_workspace_get_process_output: { running: '正在读取进程输出', done: '进程输出读取完成', failed: '进程输出读取失败' },
  mastra_workspace_kill_process: { running: '正在结束进程', done: '进程已结束', failed: '进程结束失败' },

  open_browser_page: { running: '正在打开网页', done: '网页已打开', failed: '网页打开失败' },
  fetch_webpage: { running: '正在抓取网页', done: '网页抓取完成', failed: '网页抓取失败' },
  web_fetch: { running: '正在读取网页', done: '网页读取完成', failed: '网页读取失败' },
  'query-docs': { resource: 'query', running: '正在查阅文档 {name}', done: '文档查阅完成', failed: '文档查阅失败' },
  query_docs: { resource: 'query', running: '正在查阅文档 {name}', done: '文档查阅完成', failed: '文档查阅失败' },

  github_repo: { running: '正在查询代码仓库', done: '代码仓库查询完成', failed: '代码仓库查询失败' },

  manage_todo_list: { running: '正在更新待办清单', done: '待办清单已更新', failed: '待办清单更新失败' },
  runsubagent: { running: '正在运行子代理', done: '子代理运行完成', failed: '子代理运行失败' },
  vscode_askquestions: { running: '正在向你确认问题', done: '确认完成', failed: '确认失败' },
  test_failure: { running: '正在分析测试失败', done: '测试失败分析完成', failed: '测试失败分析失败' },
  create_and_run_task: { running: '正在运行任务', done: '任务运行完成', failed: '任务运行失败' },

  install_extension: { running: '正在安装扩展', done: '扩展安装完成', failed: '扩展安装失败' },
  run_vscode_command: { running: '正在执行编辑器命令', done: '编辑器命令执行完成', failed: '编辑器命令执行失败' },
  configure_python_environment: { running: '正在配置 Python 环境', done: 'Python 环境配置完成', failed: 'Python 环境配置失败' },
  install_python_packages: { running: '正在安装 Python 依赖', done: 'Python 依赖安装完成', failed: 'Python 依赖安装失败' },
  get_python_environment_details: { running: '正在读取 Python 环境信息', done: 'Python 环境信息读取完成', failed: 'Python 环境信息读取失败' },
  get_python_executable_details: { running: '正在读取 Python 解释器信息', done: 'Python 解释器信息读取完成', failed: 'Python 解释器信息读取失败' },
  mcp_pylance_mcp_s_pylanceruncodesnippet: { running: '正在运行 Python 代码', done: 'Python 代码运行完成', failed: 'Python 代码运行失败' },

  rendermermaiddiagram: { running: '正在绘制图示', done: '图示绘制完成', failed: '图示绘制失败' },

  get_current_time: { running: '正在读取当前时间', done: '当前时间读取完成', failed: '当前时间读取失败' },
  convert_time: { running: '正在转换时间', done: '时间转换完成', failed: '时间转换失败' },

  updateworkingmemory: WORKING_MEMORY_PHRASES,
  getworkingmemory: {
    running: '正在读取工作记忆',
    done: '工作记忆读取完成',
    failed: '工作记忆读取失败',
  },
  memory: { running: '正在更新记忆', done: '记忆已更新', failed: '记忆更新失败' },
  read_graph: { running: '正在读取知识图谱', done: '知识图谱读取完成', failed: '知识图谱读取失败' },
  search_nodes: { resource: 'query', running: '正在检索记忆节点 {name}', done: '记忆节点检索完成', failed: '记忆节点检索失败' },
  open_nodes: { running: '正在打开记忆节点', done: '记忆节点已打开', failed: '记忆节点打开失败' },
  create_entities: { running: '正在写入记忆实体', done: '记忆实体已写入', failed: '记忆实体写入失败' },
  create_relations: { running: '正在建立记忆关联', done: '记忆关联已建立', failed: '记忆关联建立失败' },
  add_observations: { running: '正在补充记忆观察', done: '记忆观察已补充', failed: '记忆观察补充失败' },
  resolve_memory_file_uri: { running: '正在解析记忆文件路径', done: '记忆文件路径已解析', failed: '记忆文件路径解析失败' },

  sequentialthinking: { running: '正在推理', done: '推理完成', failed: '推理失败' },
};

const TOOL_PREFIX_PHRASES: ReadonlyArray<{ test: (name: string) => boolean; phrases: IToolPhrases }> = [
  { test: (name) => name.startsWith('git_') || name.startsWith('get_git_'), phrases: GIT_PHRASES },
  {
    test: (name) =>
      name.startsWith('debug_') ||
      name.startsWith('get_debug_') ||
      name.startsWith('set_java_') ||
      name.startsWith('remove_java_') ||
      name.startsWith('stop_debug'),
    phrases: DEBUG_PHRASES,
  },
  { test: (name) => name.startsWith('browser_'), phrases: BROWSER_PHRASES },
  { test: (name) => name.startsWith('mcp_pylance'), phrases: PYLANCE_PHRASES },
  { test: (name) => name.includes('workingmemory'), phrases: WORKING_MEMORY_PHRASES },
];

const resolveToolPhase = (event: TToolLifecycleEvent): TToolPhase => {
  if (event.type === 'agent.tool.started') {
    return 'running';
  }

  return event.ok ? 'done' : 'failed';
};

const resolveResourceLabel = (
  event: TToolLifecycleEvent,
  resource: TToolResourceKind,
  fallbackResourceLabel?: string,
): string | undefined => {
  if (resource === 'none') {
    return undefined;
  }

  if (fallbackResourceLabel) {
    return fallbackResourceLabel;
  }

  if (resource === 'file') {
    return (
      extractFileNameFromPath(
        event.type === 'agent.tool.started' ? event.inputPreview : event.resultPreview,
      ) ?? RESOURCE_FALLBACK_LABEL.file
    );
  }

  const startedPreview = event.type === 'agent.tool.started' ? event.inputPreview : undefined;

  if (resource === 'query') {
    return resolvePreviewQuery(startedPreview) ?? RESOURCE_FALLBACK_LABEL.query;
  }

  return resolvePreviewCommand(startedPreview) ?? RESOURCE_FALLBACK_LABEL.command;
};

const formatPhrase = (template: string, label?: string): string =>
  (template.includes('{name}') ? template.replace('{name}', label ?? '') : template).trim();

const describeFromPhrases = (
  event: TToolLifecycleEvent,
  phrases: IToolPhrases,
  fallbackResourceLabel?: string,
): IToolActionDescriptor => {
  const resource = phrases.resource ?? 'none';
  const label = resolveResourceLabel(event, resource, fallbackResourceLabel);
  const phase = resolveToolPhase(event);

  let template = phrases.running;

  if (phase === 'failed') {
    template = phrases.failed;
  } else if (phase === 'done') {
    const hasResults =
      event.type === 'agent.tool.completed' && previewHasResultItems(event.resultPreview);
    template = phrases.emptyDone && !hasResults ? phrases.emptyDone : phrases.done;
  }

  return {
    action: formatPhrase(template, label),
    resourceLabel: resource === 'none' ? undefined : label,
    suppressMeta: true,
  };
};

const humanizeToolName = (toolName: string): string => {
  const cleaned = toolName
    .replace(/^mcp_/u, '')
    .replace(/[_-]+/gu, ' ')
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/\s+/gu, ' ')
    .trim();

  return cleaned || toolName;
};

const describeFallbackAction = (
  event: TToolLifecycleEvent,
  toolName: string,
): IToolActionDescriptor => {
  const humanized = humanizeToolName(toolName);
  const phase = resolveToolPhase(event);
  const action =
    phase === 'running'
      ? `正在执行 ${humanized}`
      : phase === 'failed'
        ? `${humanized} 执行失败`
        : `${humanized} 执行完成`;

  return {
    action,
    suppressMeta: true,
  };
};

const describeShellcheckAction = (event: TToolLifecycleEvent): IToolActionDescriptor => {
  if (event.type !== 'agent.tool.completed') {
    return { action: '语法校验', suppressMeta: true };
  }

  if (hasShellcheckPassSummary(event.resultPreview)) {
    return { action: '语法校验已通过', suppressMeta: true };
  }

  const diagnosticCodes = extractShellcheckDiagnosticCodes(event.resultPreview);

  if (diagnosticCodes.length > 0) {
    return { action: formatShellcheckIssueAction(diagnosticCodes), suppressMeta: true };
  }

  if (hasShellcheckUnavailableSummary(event.resultPreview) || !event.ok) {
    return { action: '语法校验未完成', suppressMeta: true };
  }

  return { action: '语法校验已完成', suppressMeta: true };
};

const describeWebSearchAction = (
  event: TToolLifecycleEvent,
  fallbackResourceLabel?: string,
): IToolActionDescriptor => {
  const query =
    resolveWebSearchQuery(event.type === 'agent.tool.started' ? event.inputPreview : undefined) ??
    fallbackResourceLabel ??
    undefined;
  const webSearchSources = resolveWebSearchSources(
    event.type === 'agent.tool.completed' ? event.resultPreview : event.inputPreview,
  );

  if (event.type === 'agent.tool.completed' && !event.ok) {
    return { action: '联网搜索失败', resourceLabel: query, suppressMeta: true, webSearchSources };
  }

  return {
    action:
      event.type === 'agent.tool.started' ? `正在联网搜索 ${query ?? '相关内容'}` : '联网搜索完成',
    resourceLabel: query,
    suppressMeta: true,
    webSearchSources,
  };
};

/**
 * 为每个具体工具返回专属的自然语言描述。
 * - 优先精确匹配注册表，其次前缀匹配，最后 humanize 兜底。
 * - 所有描述均 suppressMeta，从根本上避免原始 JSON / 工具名被当作标签泄露。
 */
export const describeToolAction = (
  event: TToolLifecycleEvent,
  toolName: string,
  fallbackResourceLabel?: string,
): IToolActionDescriptor => {
  if (toolName === 'shellcheck') {
    return describeShellcheckAction(event);
  }

  if (isWebSearchToolName(toolName)) {
    return describeWebSearchAction(event, fallbackResourceLabel);
  }

  const key = toolName.toLowerCase();
  const entry =
    TOOL_PHRASE_ENTRIES[key] ?? TOOL_PREFIX_PHRASES.find((matcher) => matcher.test(key))?.phrases;

  if (entry) {
    return describeFromPhrases(event, entry, fallbackResourceLabel);
  }

  return describeFallbackAction(event, toolName);
};
