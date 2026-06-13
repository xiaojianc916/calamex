//! 宿主侧 ACP（Agent Client Protocol）接入。
//!
//! 迁移期（"先加新模块 → cargo 验证 → 绿了再删旧"）的新增模块，按 cargo feature
//! `acp_client` 门控。完成全量切换后，本目录将成为 agent-sidecar 唯一的接入层，
//! 旧 HTTP/NDJSON 实现随之删除。

mod approval;
mod bridge;
mod client;
mod host;
mod launch;
mod runtime;
mod turn;
mod ui_event;

// 过渡期：本模块尚未接线到宿主命令，公开项暂时无人引用。接线后移除该 allow。
#[allow(unused_imports)]
pub use client::{
    AcpClientConfig, AcpClientError, AcpClientHandle, AcpStreamFrame, EventSink,
    PermissionDecision, PermissionResolver, spawn_acp_client,
};

#[allow(unused_imports)]
pub use approval::{ApprovalError, ApprovalOptionInfo, ApprovalRegistry, ApprovalRequestInfo};

#[allow(unused_imports)]
pub use launch::build_acp_client_config;

// 接线层：把 Tauri 契约请求投影为客户端层 ACP 扩展请求 / 把一轮用户输入投影为 ACP
// prompt 内容块（接线前暂无调用点）。
#[allow(unused_imports)]
pub use bridge::{chat_request_to_model_chat_ext, user_turn_to_content_blocks};

#[allow(unused_imports)]
pub use turn::TurnAccumulator;

#[allow(unused_imports)]
pub use host::{AcpChatTurn, AcpHost, ApprovalEmitter, StreamEmitter};

// 进程级生命周期：把单一 AcpHost 作为 Tauri 托管状态持有（对齐 Zed 连接持有模型）。
#[allow(unused_imports)]
pub use runtime::AcpRuntime;

// 主聊天 ACP 路径复用「流式帧 webview 事件名」常量（runtime 内单一定义）。
#[allow(unused_imports)]
pub(crate) use runtime::ACP_STREAM_EVENT;

// ACP session/update 通知 → 前端 TAgentUiEvent 的纯映射适配（接线前暂无调用点）。
#[allow(unused_imports)]
pub use ui_event::{build_done_ui_event, build_error_ui_event, session_notification_to_ui_event};
