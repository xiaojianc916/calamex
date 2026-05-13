export type TAiRuntimeToolKind =
    | 'search'
    | 'read'
    | 'write'
    | 'git'
    | 'browser'
    | 'terminal'
    | 'task'
    | 'network'
    | 'diagram'
    | 'symbol'
    | 'python'
    | 'java'
    | 'memory'
    | 'thinking'
    | 'system';

interface IToolKindMatcher {
    kind: TAiRuntimeToolKind;
    patterns: RegExp[];
}

const TOOL_KIND_MATCHERS: readonly IToolKindMatcher[] = [
    {
        kind: 'search',
        patterns: [
            /grep_search/u,
            /file_search/u,
            /semantic_search/u,
            /search_project_files/u,
            /search_text/u,
            /search_symbols/u,
            /grep_in_files/u,
            /mastra_workspace_grep/u,
            /list_workspace_entries/u,
            /directory_tree/u,
            /sequentialthinking/u,
        ],
    },
    {
        kind: 'read',
        patterns: [
            /read_file/u,
            /read_file_window/u,
            /read_multiple_files/u,
            /get_file_info/u,
            /open_nodes/u,
            /view_image/u,
            /copilot_getnotebooksummary/u,
            /get_errors/u,
            /get_changed_files/u,
            /terminal_last_command/u,
            /terminal_selection/u,
            /mastra_list_logs/u,
        ],
    },
    {
        kind: 'write',
        patterns: [
            /apply_patch/u,
            /apply_file_edits/u,
            /propose_file_patch/u,
            /create_file/u,
            /create_directory/u,
            /edit_notebook_file/u,
            /create_new_jupyter_notebook/u,
            /create_new_workspace/u,
            /vscode_renamesymbol/u,
            /mcp_pylance_mcp_s_pylanceinvokerefactoring/u,
            /^memory$/u,
        ],
    },
    {
        kind: 'git',
        patterns: [
            /get_changed_files/u,
            /github_repo/u,
            /git_/u,
        ],
    },
    {
        kind: 'browser',
        patterns: [
            /open_browser_page/u,
            /^browser_/u,
            /browser_navigate/u,
            /browser_evaluate/u,
            /fetch_webpage/u,
            /query-docs/u,
        ],
    },
    {
        kind: 'terminal',
        patterns: [
            /mastra_workspace_execute_command/u,
            /mastra_workspace_get_process_output/u,
            /mastra_workspace_kill_process/u,
            /run_in_terminal/u,
            /get_terminal_output/u,
            /send_to_terminal/u,
            /kill_terminal/u,
            /create_and_run_task/u,
        ],
    },
    {
        kind: 'task',
        patterns: [
            /runsubagent/u,
            /manage_todo_list/u,
            /vscode_askquestions/u,
            /test_failure/u,
            /resolve_memory_file_uri/u,
        ],
    },
    {
        kind: 'network',
        patterns: [
            /install_extension/u,
            /run_vscode_command/u,
            /vscode_searchextensions_internal/u,
            /container-tools_get-config/u,
            /configure_python_environment/u,
            /install_python_packages/u,
            /get_python_environment_details/u,
            /get_python_executable_details/u,
            /create_and_run_task/u,
            /^web_(?:search|fetch)$/u,
            /^tavily(?:-|_)/u,
        ],
    },
    {
        kind: 'diagram',
        patterns: [
            /rendermermaiddiagram/u,
        ],
    },
    {
        kind: 'symbol',
        patterns: [
            /vscode_listcodeusages/u,
            /search_symbols/u,
            /mastra_workspace_lsp_inspect/u,
            /vscode_renamesymbol/u,
            /mcp_pylance_mcp_s_pylancedocstring/u,
            /mcp_pylance_mcp_s_pylancefilesyntaxerrors/u,
            /mcp_pylance_mcp_s_pylanceworkspaceuserfiles/u,
            /mcp_pylance_mcp_s_pylanceimports/u,
            /mcp_pylance_mcp_s_pylancesettings/u,
        ],
    },
    {
        kind: 'python',
        patterns: [
            /mcp_pylance_mcp_s_pylanceruncodesnippet/u,
            /mcp_pylance_mcp_s_pylancesyntaxerrors/u,
            /mcp_pylance_mcp_s_pylancepythonenvironments/u,
            /mcp_pylance_mcp_s_pylanceupdatepythonenvironment/u,
            /mcp_pylance_mcp_s_pylanceinstalledtoplevelmodules/u,
        ],
    },
    {
        kind: 'java',
        patterns: [
            /debug_java_application/u,
            /get_debug_session_info/u,
            /get_debug_threads/u,
            /get_debug_stack_trace/u,
            /get_debug_variables/u,
            /evaluate_debug_expression/u,
            /debug_step_operation/u,
            /set_java_breakpoint/u,
            /remove_java_breakpoints/u,
            /stop_debug_session/u,
        ],
    },
    {
        kind: 'memory',
        patterns: [
            /^memory$/u,
            /resolve_memory_file_uri/u,
        ],
    },
    {
        kind: 'thinking',
        patterns: [
            /sequentialthinking/u,
            /thinking/u,
            /reason/u,
        ],
    },
];

export const normalizeRuntimeToolName = (toolName: string): string =>
    toolName
        .replace(/^mcp\./u, '')
        .replace(/^functions\./u, '')
        .trim();

export const classifyRuntimeToolKind = (toolName: string): TAiRuntimeToolKind => {
    const normalized = normalizeRuntimeToolName(toolName).toLowerCase();

    for (const matcher of TOOL_KIND_MATCHERS) {
        if (matcher.patterns.some((pattern) => pattern.test(normalized))) {
            return matcher.kind;
        }
    }

    return 'system';
};
