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

// 过渡期：本模块部分公开项已接线到宿主命令；仍有部分（如 spawn_acp_client / 权限决策等
// 仅在 acp 模块内经 `super::` 直接消费的项）在 crate 外暂无消费者，故保留该 allow。
#[allow(unused_imports)]
pub use client::{
    AcpClientConfig, AcpClientError, AcpClientHandle, AcpStreamFrame, CheckpointRestoreRequest,
    EventSink, ExtModelConfig, PermissionDecision, PermissionResolver, WarmupExtRequest,
    WebFetchExtRequest, WebSearchExtRequest, spawn_acp_client,
};

#[allow(unused_imports)]
pub use approval::{ApprovalError, ApprovalOptionInfo, ApprovalRegistry, ApprovalRequestInfo};

#[allow(unused_imports)]
pub use launch::build_acp_client_config;

// 接线层：把 Tauri 契约请求投影为客户端层 ACP 扩展请求 / 把一轮用户输入投影为 ACP
// prompt 内容块。agent/chat 两条投影已由命令层 live 调用；model/chat 与 prompt 内容块
// 投影接线前暂无调用点，故保留 allow。
#[allow(unused_imports)]
pub use bridge::{
    approval_resolve_to_agent_chat_resolve_ext, chat_request_to_agent_chat_ext,
    chat_request_to_model_chat_ext, user_turn_to_content_blocks,
};

#[allow(unused_imports)]
pub use turn::TurnAccumulator;

#[allow(unused_imports)]
pub use host::{
    AcpChatTurn, AcpHost, AcpOrchestrateResume, AcpOrchestrateStart, ApprovalEmitter,
    StreamEmitter,
};

// 进程级生命周期：把单一 AcpHost 作为 Tauri 托管状态持有（对齐 Zed 连接持有模型）。
#[allow(unused_imports)]
pub use runtime::AcpRuntime;

// 主聊天 ACP 路径复用「流式帧 webview 事件名」常量（runtime 内单一定义）。
#[allow(unused_imports)]
pub(crate) use runtime::ACP_STREAM_EVENT;

// ACP session/update 通知 → 前端 TAgentUiEvent 的纯映射适配（接线前暂无调用点）。
#[allow(unused_imports)]
pub use ui_event::{build_done_ui_event, build_error_ui_event, session_notification_to_ui_event};
