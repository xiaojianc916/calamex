export const AI_AGENT_TOOL_NAMES = [
  'read_current_file',
  'read_selected_text',
  'search_files',
  'search_text',
  'search_symbols',
  'get_diagnostics',
  'get_git_diff',
  'get_terminal_log',
  'web_search',
  'web_fetch',
  'propose_patch',
  'auto_apply_patch',
  'run_test',
  'run_command',
  'stage_file',
  'create_commit',
  'get_project_tree',
  'read_file',
  'list_open_files',
  'get_package_scripts',
  'get_test_targets',
] as const;

const AI_TOOL_RISKS = ['read', 'network', 'write', 'command', 'git'] as const;

export const AI_AGENT_PERMISSION_LEVELS = ['standard', 'elevated'] as const;

export type TAiAgentToolName = (typeof AI_AGENT_TOOL_NAMES)[number];
export type TAiToolRisk = (typeof AI_TOOL_RISKS)[number];
export type TAiAgentPermissionLevel = (typeof AI_AGENT_PERMISSION_LEVELS)[number];

export interface IAiToolDefinition {
  name: TAiAgentToolName;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  risk: TAiToolRisk;
  readOnly: boolean;
  destructive: boolean;
  requiresConfirmation: boolean;
  minPermissionLevel: TAiAgentPermissionLevel;
  emitsAuditEvent: boolean;
}

