import type { TAgentRuntimeEvent } from '@/types/ai/sidecar';

export const REASONING_SEGMENT_CHARS = 420;
export const PREVIEW_TAG_LIMIT = 96;
export const MAX_TOOL_TAGS = 3;

export const FALLBACK_FILE_NAME = '文件';
export const WAITING_DECISION_LABEL = '正在等待决策';

export const tokenNumberFormatter = new Intl.NumberFormat('zh-CN');

export const HIDDEN_RUNTIME_EVENT_TYPES = new Set<TAgentRuntimeEvent['type']>([
  'acontext.token.checked',
  'acontext.provider_payload.checked',
]);

export const PREVIEW_PATH_KEYS = [
  'path',
  'filePath',
  'file_path',
  'targetPath',
  'target_path',
] as const;

export const PREVIEW_QUERY_KEYS = [
  'query',
  'q',
  'pattern',
  'keyword',
  'keywords',
  'search',
  'searchTerm',
  'search_term',
  'command',
  'cmd',
  'script',
] as const;

export const WEB_SEARCH_SOURCE_URL_KEYS = ['url', 'href', 'link'] as const;

export const WEB_SEARCH_SOURCE_HOST_KEYS = [
  'domain',
  'domains',
  'site',
  'sites',
  'includeDomain',
  'include_domain',
  'includeDomains',
  'include_domains',
] as const;

export const WEB_SEARCH_TOOL_NAMES = new Set([
  'web_search',
  'tavily-search',
  'tavily_search',
  'tavily-map',
  'tavily_map',
  'tavily-research',
  'tavily_research',
]);

export const READ_FILE_TOOL_NAMES = new Set([
  'read_file',
  'read_text_file',
  'read_file_window',
  'mastra_workspace_read_file',
  'mastra_workspace_lsp_inspect',
]);

export const CURRENT_FILE_TOOL_NAMES = new Set(['read_current_file']);

export const DIRECTORY_READ_TOOL_NAMES = new Set(['mastra_workspace_list_files', 'list_dir']);

export const TEXT_SEARCH_TOOL_NAMES = new Set(['grep_in_files', 'mastra_workspace_grep']);

export const SYMBOL_SEARCH_TOOL_NAMES = new Set(['search_symbols']);

export const WRITE_FILE_TOOL_NAMES = new Set([
  'write_file',
  'string_replace_lsp',
  'propose_file_patch',
  'mastra_workspace_write_file',
  'mastra_workspace_edit_file',
  'mastra_workspace_ast_edit',
  'mastra_workspace_mkdir',
  'mastra_workspace_delete',
]);

export const APPLY_FILE_EDIT_TOOL_NAMES = new Set(['apply_file_edits']);

export const COMMAND_TOOL_NAMES = new Set(['run_command', 'mastra_workspace_execute_command']);
