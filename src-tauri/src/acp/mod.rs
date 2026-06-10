//! 宿主侧 ACP(Agent Client Protocol)接入。
//!
//! 迁移期("先加新模块 → cargo 验证 → 绿了再删旧")的新增模块,按 cargo feature
//! `acp_client` 门控。完成全量切换后,本目录将成为 agent-sidecar 唯一的接入层,
//! 旧 HTTP/NDJSON 实现随之删除。

mod client;

pub use client::{
    AcpClientConfig, AcpClientError, AcpClientHandle, AcpStreamFrame, EventSink,
    PermissionDecision, PermissionResolver, spawn_acp_client,
};
