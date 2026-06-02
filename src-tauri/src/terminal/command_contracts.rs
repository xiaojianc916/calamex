use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EnsureTerminalSessionRequest {
    pub(crate) session_id: String,
    pub(crate) cwd: Option<String>,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionPayload {
    pub(crate) session_id: String,
    pub(crate) cwd: String,
    pub(crate) shell_label: String,
    pub(crate) created: bool,
    pub(crate) initial_output: Option<String>,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DispatchTerminalScriptRequest {
    pub(crate) session_id: String,
    pub(crate) path: Option<String>,
    pub(crate) workspace_root_path: Option<String>,
    pub(crate) content: String,
    pub(crate) is_dirty: bool,
    pub(crate) run_id: String,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DispatchTerminalScriptPayload {
    pub(crate) session_id: String,
    pub(crate) cwd: String,
    pub(crate) command_line: String,
    pub(crate) used_temp_file: bool,
    pub(crate) started_at: String,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInputRequest {
    pub(crate) session_id: String,
    pub(crate) data: String,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResizeRequest {
    pub(crate) session_id: String,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CloseTerminalSessionRequest {
    pub(crate) session_id: String,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CancelTerminalRunRequest {
    pub(crate) run_id: String,
    pub(crate) mode: Option<String>,
}
