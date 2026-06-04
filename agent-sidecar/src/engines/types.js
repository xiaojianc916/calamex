import { DurableStepIds } from '@mastra/core/agent/durable';
import { WORKSPACE_TOOLS } from '@mastra/core/workspace';
export const DEFAULT_MASTRA_LOG_FILE = './.agent-sidecar/mastra.log';
export const DEFAULT_EXECUTION_AGENT_ID = 'calamex-agent-sidecar';
export const DEFAULT_EXECUTION_AGENT_NAME = 'Calamex Agent Sidecar';
export const DEFAULT_VALIDATOR_AGENT_ID = 'calamex-agent-sidecar-validator';
export const DEFAULT_REPLANNER_AGENT_ID = 'calamex-agent-sidecar-replanner';
export const RUNTIME_TOOL_PREVIEW_CHARS = 1200;
export const CURRENT_FILE_TOOL_CONTENT_MAX_CHARS = 2_000;
export const CURRENT_FILE_TOOL_MODEL_OUTPUT_MAX_CHARS = 2_600;
export const EXPLICIT_CONTEXT_MESSAGE_LIMIT = 12;
export const TOOL_PREVIEW_REDACTED_TEXT = '[工具参数已收敛显示]';
export const MAX_CONSECUTIVE_SIMILAR_TOOL_ERRORS = 3;
export const MASTRA_GUARDRAIL_MODEL = 'openrouter/openai/gpt-oss-safeguard-20b';
export const MASTRA_WORKSPACE_REDACTED_PREVIEW_TOOL_NAMES = new Set([
    WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
    WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
    WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT,
    WORKSPACE_TOOLS.FILESYSTEM.DELETE,
    WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
]);
export const WINDOWS_POWERSHELL_RELATIVE_PATH = 'System32\\WindowsPowerShell\\v1.0\\powershell.exe';
export const WINDOWS_POWERSHELL_CORE_RELATIVE_PATH = 'PowerShell\\7\\pwsh.exe';
export const DEFAULT_ROLLBACK_STEP = [
    DurableStepIds.AGENTIC_EXECUTION,
    DurableStepIds.LLM_EXECUTION,
];
