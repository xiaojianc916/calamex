use serde::{Deserialize, Serialize};
use specta::Type;

use crate::terminal::types::TerminalState;

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EnsureTerminalSessionRequest {
    pub(crate) session_id: String,
    pub(crate) cwd: Option<String>,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
}

/// 重载恢复：某会话当前活动运行的快照，随 ensure_terminal_session 复用分支回传，
/// 让前端在页面重载、运行态镜像被重置后仍能据此复原「运行中 / 取消」UI。
/// pid / started_at_ms 在 RunStarted 事件到达后才填充，故为 Option。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalActiveRunSnapshot {
    pub(crate) run_id: String,
    pub(crate) pid: Option<u32>,
    pub(crate) started_at_ms: Option<f64>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionPayload {
    pub(crate) session_id: String,
    pub(crate) cwd: String,
    pub(crate) shell_label: String,
    pub(crate) created: bool,
    pub(crate) initial_output: Option<String>,
    /// 复用既有会话且该会话仍有活动运行时带回其快照；否则为 None。
    pub(crate) active_run: Option<TerminalActiveRunSnapshot>,
    /// 该会话当前的每会话状态，供前端重载后复原全局 / 会话运行态镜像。
    pub(crate) session_state: TerminalState,
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

/// 前端存活心跳请求：每个挂载中的前端终端会话周期性上报，后端据此判定哪些会话已无前端照管。
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatTerminalSessionRequest {
    pub(crate) session_id: String,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CancelTerminalRunRequest {
    pub(crate) run_id: String,
    pub(crate) mode: Option<String>,
}
