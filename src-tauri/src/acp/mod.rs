//! 宿主侧 ACP（Agent Client Protocol）接入。
//!
//! 迁移期（\"先加新模块 → cargo 验证 → 绿了再删旧\"）的新增模块，按 cargo feature
//! `acp_client` 门控。本目录已是 builtin-agent 的唯一接入层，
//! 旧 HTTP/NDJSON 实现已移除。

mod approval;
mod bridge;
mod client;
mod host;
mod launch;
mod provisioner;
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

// 默认后端（自家边车）启动配置解析入口 + 后端标识枚举。外部 ACP agent（Kimi/Codex 等）的
// 启动配置 / 凭证预置改由 provisioner 模块各 ExternalAgentProvisioner 自包含（见下）。
// build_acp_client_config 经 BuiltinProvisioner 消费；AcpBackendId 由 runtime/provisioner 直接消费。
#[allow(unused_imports)]
pub use launch::{AcpBackendId, build_acp_client_config};

// 外部/内置 ACP 后端「凭证预置 + 启动配置」的统一抽象与注册表(ADR-0015 通用化)。
// 本阶段仅委托到 launch 既有自由函数,runtime 接线见后续阶段,迁移期暂无 crate 外消费者。
#[allow(unused_imports)]
pub use provisioner::{
    BuiltinProvisioner, CodexProvisioner, ExternalAgentProvisioner, KimiProvisioner,
    provisioner_for,
};

// 接线层：把 Tauri 契约请求投影为客户端层 ACP 扩展请求（一次性 model/chat），已由网关 live 调用。
pub use bridge::chat_request_to_model_chat_ext;

#[allow(unused_imports)]
pub use host::{
    AcpHost, ApprovalEmitter, StreamEmitter,
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
