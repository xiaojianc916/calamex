//! 集成终端命令模块。
//!
//! 按职责拆分为四个子模块：
//! - `commands`：对前端暴露的 Tauri 命令入口。
//! - `state`：会话、快照、活动运行等共享状态及其存取。
//! - `events`：终端事件发射与状态机转移。
//! - `tests`：单元测试。

pub(crate) mod commands;
mod events;
mod state;
#[cfg(test)]
mod tests;

pub use commands::{
    cancel_terminal_run, close_terminal_session, dispatch_script_to_terminal,
    ensure_terminal_session, resize_terminal_session, shutdown_all_terminal_sessions,
    write_terminal_input,
};
pub use state::TerminalSessionState;

pub(crate) fn to_wsl_path(path: &std::path::Path) -> Result<String, String> {
    crate::terminal::wsl::to_wsl_path(path)
}
