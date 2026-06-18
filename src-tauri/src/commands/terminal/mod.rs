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

// 其余终端命令经 `tauri_bindings.rs` 以 `terminal::commands::*` 路径直接登记；
// 此处仅保留 `main.rs` 仍按 `commands::*` 引用的两项。
pub use commands::shutdown_all_terminal_sessions;
pub use commands::spawn_orphan_terminal_session_reaper;
pub use state::TerminalSessionState;

pub(crate) fn to_wsl_path(path: &std::path::Path) -> Result<String, String> {
    crate::terminal::wsl::to_wsl_path(path)
}
