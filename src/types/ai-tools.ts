export interface IAiToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  readOnly: boolean;
  destructive: boolean;
  requiresConfirmation: boolean;
}

export const AI_READONLY_TOOL_NAMES = [
  'read_current_file',
  'read_selected_text',
  'search_files',
  'search_text',
  'search_symbols',
  'get_diagnostics',
  'get_git_diff',
  'get_terminal_log',
  'get_project_tree',
] as const;

export const AI_CONFIRMATION_TOOL_NAMES = [
  'propose_patch',
  'apply_patch',
  'run_test',
  'run_command',
  'stage_file',
  'create_commit',
] as const;
