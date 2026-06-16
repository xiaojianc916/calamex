//! 宿主侧 ACP（Agent Client Protocol）接入。
//!
//! 迁移期（\"先加新模块 → cargo 验证 → 绿了再删旧\"）的新增模块，按 cargo feature
//! `acp_client` 门控。完成全量切换后，本目录将成为 agent-sidecar 唯一的接入层，
//! 旧 HTTP/NDJSON 实现随之删除。

mod approval;
mod bridge;
mod client;
mod host;
mod launch;
mod runtime;
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

// 启动配置解析：默认后端（自家边车）与多后端注册表（ADR-0015 阶段 1）。
// build_acp_client_config_for / AcpBackendId 为外部 ACP agent（Kimi/Codex 等）的启动配置
// 源，接线在阶段 2（runtime 多 host），故迁移期暂无消费者。
#[allow(unused_imports)]
pub use launch::{AcpBackendId, build_acp_client_config, build_acp_client_config_for};

// 接线层：把 Tauri 契约请求投影为客户端层 ACP 扩展请求。四条投影（agent/chat、
// agent/chat/resolve、agent/ask-user/resume、一次性 model/chat）均已由命令层 / 网关 live 调用。
pub use bridge::{
    approval_resolve_to_agent_chat_resolve_ext, ask_user_resume_to_agent_ask_user_resume_ext,
    chat_request_to_agent_chat_ext, chat_request_to_model_chat_ext,
};

#[allow(unused_imports)]
pub use host::{
    AcpHost, AcpOrchestrateResume, AcpOrchestrateStart, ApprovalEmitter, StreamEmitter,
};

// 进程级生命周期：把单一 AcpHost 作为 Tauri 托管状态持有（对齐 Zed 连接持有模型）。
#[allow(unused_imports)]
pub use runtime::AcpRuntime;

// 主聊天 ACP 路径复用「流式帧 webview 事件名」常量（runtime 内单一定义）。
#[allow(unused_imports)]
pub(crate) use runtime::ACP_STREAM_EVENT;

// ACP session/update 通知 → 前端 TAgentUiEvent 的纯映射适配。build_done_ui_event /
// build_error_ui_event 已由主聊天路径 live 调用（合成终态 done/error）；
// session_notification_to_ui_event 为后续 agent/plan 切流预留投影点，暂无调用。
#[allow(unused_imports)]
pub use ui_event::{build_done_ui_event, build_error_ui_event, session_notification_to_ui_event};
