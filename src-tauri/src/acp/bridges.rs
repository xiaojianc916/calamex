//! ACP 客户端 fs/* + terminal/* 桥接回调注入点。
//!
//! 与现有 `PermissionResolver` 同构：由命令层（持有 `AppHandle` + `State<AiEditState>`）
//! 构造后经 `spawn_acp_client` 注入，`client.rs` 保持不依赖 Tauri 具体类型。
#![allow(dead_code)]

use std::sync::Arc;

use agent_client_protocol::BoxFuture;
use agent_client_protocol::schema::{
    CreateTerminalRequest, CreateTerminalResponse, KillTerminalRequest, KillTerminalResponse,
    ReadTextFileRequest, ReadTextFileResponse, ReleaseTerminalRequest, ReleaseTerminalResponse,
    TerminalOutputRequest, TerminalOutputResponse, WaitForTerminalExitRequest,
    WaitForTerminalExitResponse, WriteTextFileRequest, WriteTextFileResponse,
};

/// 本协议版本的错误类型（= JSON-RPC error，构造器见 schema `v1/error.rs`）。
pub type AcpResult<T> = Result<T, agent_client_protocol::Error>;

pub type FsReadResolver = Arc<
    dyn Fn(ReadTextFileRequest) -> BoxFuture<'static, AcpResult<ReadTextFileResponse>> + Send + Sync,
>;
pub type FsWriteResolver = Arc<
    dyn Fn(WriteTextFileRequest) -> BoxFuture<'static, AcpResult<WriteTextFileResponse>> + Send + Sync,
>;
pub type TerminalCreateResolver = Arc<
    dyn Fn(CreateTerminalRequest) -> BoxFuture<'static, AcpResult<CreateTerminalResponse>> + Send + Sync,
>;
pub type TerminalOutputResolver = Arc<
    dyn Fn(TerminalOutputRequest) -> BoxFuture<'static, AcpResult<TerminalOutputResponse>> + Send + Sync,
>;
pub type TerminalWaitResolver = Arc<
    dyn Fn(WaitForTerminalExitRequest) -> BoxFuture<'static, AcpResult<WaitForTerminalExitResponse>>
        + Send
        + Sync,
>;
pub type TerminalKillResolver = Arc<
    dyn Fn(KillTerminalRequest) -> BoxFuture<'static, AcpResult<KillTerminalResponse>> + Send + Sync,
>;
pub type TerminalReleaseResolver = Arc<
    dyn Fn(ReleaseTerminalRequest) -> BoxFuture<'static, AcpResult<ReleaseTerminalResponse>> + Send + Sync,
>;

/// fs/terminal 全部回调的注入包。命令层构造，`spawn_acp_client` 注入。
#[derive(Clone)]
pub struct AcpBridges {
    pub fs_read: FsReadResolver,
    pub fs_write: FsWriteResolver,
    pub terminal_create: TerminalCreateResolver,
    pub terminal_output: TerminalOutputResolver,
    pub terminal_wait: TerminalWaitResolver,
    pub terminal_kill: TerminalKillResolver,
    pub terminal_release: TerminalReleaseResolver,
}

// ── 命令层构造示例（在持有 AppHandle + State<AiEditState> 处填闭包体）──────────────
//
// let bridges = AcpBridges {
//     // 读：该 path 有打开的 CodeMirror 缓冲则返回未存盘文本，否则读磁盘；按 line/limit 切片。
//     //     文件不存在 -> Error::resource_not_found(Some(path))，读失败 -> Error::into_internal_error(e)
//     fs_read: Arc::new(move |req| Box::pin(async move {
//         let content = /* acp_fs_read(app, &req.path, req.line, req.limit).await? */;
//         Ok(ReadTextFileResponse::new(content))
//     })),
//     // 写：不直接落盘，串 ai_propose_patch -> 审批 -> ai_apply_patch + 快照/时间线（edit.rs）。
//     //     被拒/取消 -> Error::request_cancelled()
//     fs_write: Arc::new(move |req| Box::pin(async move {
//         /* propose+approve+apply(req.path, req.content).await? */
//         Ok(WriteTextFileResponse::new())
//     })),
//     // terminal/*：桥接 src-tauri/src/terminal/（portable-pty）：登记 TerminalId、
//     //     output 截断按 char_boundary→最后换行 置 truncated、wait_for_exit 共享 Shared<Task>。
//     terminal_create:  Arc::new(move |req| Box::pin(async move { /* ... */ })),
//     terminal_output:  Arc::new(move |req| Box::pin(async move { /* ... */ })),
//     terminal_wait:    Arc::new(move |req| Box::pin(async move { /* ... */ })),
//     terminal_kill:    Arc::new(move |req| Box::pin(async move { /* ... */ })),
//     terminal_release: Arc::new(move |req| Box::pin(async move { /* ... */ })),
// };
// spawn_acp_client(config, sink, resolver, bridges)?;
