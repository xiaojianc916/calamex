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
mod turn;

// 过渡期：本模块尚未接线到宿主命令，公开项暂时无人引用。接线后移除该 allow。
#[allow(unused_imports)]
pub use client::{
    AcpClientConfig, AcpClientError, AcpClientHandle, AcpStreamFrame, EventSink,
    PermissionDecision, PermissionResolver, spawn_acp_client,
};

#[allow(unused_imports)]
pub use approval::{
    ApprovalError, ApprovalOptionInfo, ApprovalRegistry, ApprovalRequestInfo,
};

#[allow(unused_imports)]
pub use launch::build_acp_client_config;

// 接线层：把 Tauri 契约请求投影为客户端层 ACP 扩展请求（接线前暂无调用点）。
#[allow(unused_imports)]
pub use bridge::chat_request_to_model_chat_ext;

#[allow(unused_imports)]
pub use turn::TurnAccumulator;

#[allow(unused_imports)]
pub use host::{AcpChatTurn, AcpHost, ApprovalEmitter, StreamEmitter};
