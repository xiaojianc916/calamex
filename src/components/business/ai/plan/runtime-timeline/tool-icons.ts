import { normalizeRuntimeToolName, type TAiRuntimeToolKind } from '@/constants/ai/runtime-tools';
import { extractShellcheckDiagnosticCodes, hasShellcheckUnavailableSummary } from './shellcheck';
import type { IToolIconMatcher, TTaskIcon, TToolLifecycleEvent } from './types';

export const TOOL_ICON_MATCHERS: readonly IToolIconMatcher[] = [
  {
    icon: 'catalog',
    patterns: [/^mcp_list_tools$/u],
  },
  {
    icon: 'folder',
    patterns: [
      /mastra_workspace_list_files/u,
      /directory_tree/u,
      /list_dir/u,
      /list_directory/u,
      /list_workspace_entries/u,
      /list_project_files/u,
      /get_project_tree/u,
      /list_allowed_directories/u,
    ],
  },
  {
    icon: 'files',
    patterns: [/read_multiple_files/u, /copilot_getnotebooksummary/u],
  },
  {
    icon: 'image',
    patterns: [/view_image/u, /read_media_file/u],
  },
  {
    icon: 'file',
    patterns: [
      /read_file/u,
      /read_file_window/u,
      /read_text_file/u,
      /read_current_file/u,
      /read_project_file/u,
      /read_selected_text/u,
      /get_file_info/u,
      /open_nodes/u,
      /mastra_list_logs/u,
      /mastra_workspace_read_file/u,
    ],
  },
  {
    icon: 'patch',
    patterns: [
      /apply_patch/u,
      /apply_file_edits/u,
      /edit_file/u,
      /propose_patch/u,
      /propose_file_patch/u,
      /auto_apply_patch/u,
      /mastra_workspace_edit_file/u,
      /mastra_workspace_write_file/u,
      /mastra_workspace_ast_edit/u,
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
    patterns: [/^git_/u, /get_git_/u, /github_repo/u, /stage_file/u, /create_commit/u],
  },
  {
    icon: 'book',
    patterns: [/query-docs/u, /query_docs/u, /docs/u],
  },
  {
    icon: 'play',
    patterns: [/^browser_/u, /browser_evaluate/u, /run_vscode_command/u, /create_and_run_task/u],
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
      /grep_in_files/u,
      /mastra_workspace_grep/u,
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
    patterns: [/get_errors/u, /test_failure/u],
  },
  {
    icon: 'brain',
    patterns: [/sequentialthinking/u, /thinking/u, /reason/u],
  },
  {
    icon: 'task',
    patterns: [/manage_todo_list/u, /runsubagent/u, /vscode_askquestions/u],
  },
  {
    icon: 'clock',
    patterns: [/get_current_time/u, /convert_time/u, /time/u],
  },
  {
    icon: 'alert',
    patterns: [/debug_/u, /get_debug_/u, /stop_debug_session/u],
  },
  {
    icon: 'diagram',
    patterns: [/rendermermaiddiagram/u],
  },
  {
    icon: 'memory',
    patterns: [
      /^memory$/u,
      /working_?memory/u,
      /resolve_memory_file_uri/u,
      /read_graph/u,
      /search_nodes/u,
      /create_entities/u,
      /create_relations/u,
      /add_observations/u,
    ],
  },
];

export const TASK_ICON_MAP: Record<TTaskIcon, string> = {
  search: 'search',
  read: 'file-text',
  write: 'pencil',
  git: 'git-branch',
  browser: 'globe',
  terminal: 'terminal',
  task: 'list-todo',
  network: 'globe',
  diagram: 'workflow',
  symbol: 'file-code',
  python: 'file-code',
  java: 'coffee',
  memory: 'hard-drive',
  thinking: 'brain',
  system: 'activity',
  file: 'file-text',
  files: 'files',
  folder: 'folder-tree',
  patch: 'pencil',
  globe: 'globe',
  play: 'play',
  book: 'book-open',
  chart: 'chart-column',
  brain: 'brain',
  image: 'image',
  clock: 'clock-3',
  catalog: 'list-tree',
  check: 'badge-check',
  note: 'notebook-pen',
  log: 'scroll-text',
  plug: 'plug',
  bug: 'bug',
  alert: 'circle-alert',
};

export const isMcpListToolsName = (toolName: string | undefined): boolean =>
  toolName === 'mcp_list_tools';

export const resolveRuntimeToolIcon = (
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

export const resolveToolEventIcon = (
  event: TToolLifecycleEvent,
  toolName: string,
  fallbackIcon: TTaskIcon,
): TTaskIcon => {
  if (isMcpListToolsName(toolName)) {
    return event.type === 'agent.tool.completed' && !event.ok ? 'alert' : 'catalog';
  }

  if (toolName !== 'shellcheck') {
    return fallbackIcon;
  }

  if (
    event.type === 'agent.tool.completed' &&
    (extractShellcheckDiagnosticCodes(event.resultPreview).length > 0 ||
      hasShellcheckUnavailableSummary(event.resultPreview) ||
      !event.ok)
  ) {
    return 'alert';
  }

  return 'check';
};
