//! IPC 契约类型（前后端共享）。
//!
//! 本目录由原单文件 `contracts.rs` 按域拆分而来；各子模块仅承载类型定义，
//! 通过下方 `pub use *` 重导出，保持 `commands::contracts::*` 公共路径与原来一致。
mod builtin_agent;
mod ai_agent;
mod ai_chat;
mod ai_config;
mod ai_edit;
mod format;
mod script;
mod secret;
mod skills;
mod ssh;
mod workspace;

pub use builtin_agent::*;
pub use ai_agent::*;
pub use ai_chat::*;
pub use ai_config::*;
pub use ai_edit::*;
pub use format::*;
pub use script::*;
pub use secret::*;
pub use skills::*;
pub use ssh::*;
pub use workspace::*;
