//! LSP (Language Server Protocol) 集成
//!
//! 管理 bash-language-server 进程，通过 JSON-RPC over stdio 通信。
//! 诊断通过 Tauri 事件 `lsp-diagnostics` 推送到前端；
//! 补全 / 悬停采用同步 request/response，由 oneshot channel 关联 id。
//!
//! 设计要点:
//! - LSP 位置使用 UTF-16 code units (LSP 3.x 默认)。前端列号需按 UTF-16 计算。
//! - 子进程由独立 watcher 任务 own；进程崩溃会把 state 置回 Stopped 并 emit `lsp-crashed`。
//! - 启动流程被 `startup` 互斥锁串行化，避免 TOCTOU 双实例。
//! - 反向 request (server → client) 对常见方法返回合规响应，对未知方法返回 MethodNotFound。
//! - shellcheck 路径:bash-language-server 的 onInitialize 不读 initializationOptions,
//!   只从环境变量 SHELLCHECK_PATH 或 workspace/configuration 读。我们通过前者传入。
//!
//! 模块拆分(纯搬运,零行为改动):
//! - `types`:数据结构与会话/管理器状态
//! - `protocol`:JSON-RPC 帧编解码与 path↔uri 转换
//! - `io`:stdin/stdout 读写、消息分派、请求-响应
//! - `diagnostics`:ShellCheck 中文化与诊断批量推送
//! - `discovery`:node / shellcheck / bash-language-server CLI 路径解析
//! - `commands`:对外 `#[tauri::command]` 入口

mod commands;
mod diagnostics;
mod discovery;
mod io;
mod protocol;
mod types;

pub use self::commands::{
    lsp_completion, lsp_did_change, lsp_did_close, lsp_did_open, lsp_hover, lsp_start, lsp_stop,
};
pub use self::types::LspManager;
