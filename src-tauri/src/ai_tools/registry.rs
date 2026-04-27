use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiToolDefinition {
    pub name: &'static str,
    pub read_only: bool,
    pub destructive: bool,
    pub requires_confirmation: bool,
}

pub const PHASE0_TOOLS: &[AiToolDefinition] = &[
    AiToolDefinition {
        name: "read_current_file",
        read_only: true,
        destructive: false,
        requires_confirmation: false,
    },
    AiToolDefinition {
        name: "read_selected_text",
        read_only: true,
        destructive: false,
        requires_confirmation: false,
    },
    AiToolDefinition {
        name: "search_files",
        read_only: true,
        destructive: false,
        requires_confirmation: false,
    },
    AiToolDefinition {
        name: "search_text",
        read_only: true,
        destructive: false,
        requires_confirmation: false,
    },
    AiToolDefinition {
        name: "search_symbols",
        read_only: true,
        destructive: false,
        requires_confirmation: false,
    },
    AiToolDefinition {
        name: "get_diagnostics",
        read_only: true,
        destructive: false,
        requires_confirmation: false,
    },
    AiToolDefinition {
        name: "get_git_diff",
        read_only: true,
        destructive: false,
        requires_confirmation: false,
    },
    AiToolDefinition {
        name: "get_terminal_log",
        read_only: true,
        destructive: false,
        requires_confirmation: false,
    },
    AiToolDefinition {
        name: "propose_patch",
        read_only: false,
        destructive: false,
        requires_confirmation: true,
    },
];

pub fn list_tools() -> Vec<AiToolDefinition> {
    PHASE0_TOOLS.to_vec()
}

pub fn is_tool_allowed(name: &str, allow_write: bool) -> bool {
    PHASE0_TOOLS
        .iter()
        .any(|tool| tool.name == name && (tool.read_only || (!tool.destructive && allow_write)))
}

#[cfg(test)]
mod tests {
    use super::{is_tool_allowed, list_tools};

    #[test]
    fn write_tools_require_explicit_write_gate() {
        assert!(is_tool_allowed("read_current_file", false));
        assert!(!is_tool_allowed("propose_patch", false));
        assert!(is_tool_allowed("propose_patch", true));
        assert_eq!(list_tools().len(), 9);
    }
}
