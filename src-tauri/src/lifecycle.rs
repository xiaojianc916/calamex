//! 进程级生命周期信号：全局唯一的优雅关停取消令牌（`CancellationToken`）。
//!
//! 统一所有后台常驻循环（终端孤儿会话收割、SSH 连接池清理等）的关停信号——应用退出时由
//! `run_exit_cleanup` 调用 [`trigger_shutdown`] 取消令牌，各循环在 `select!` 中观察
//! `cancelled()` 即时退出，替代此前各自为政的 `AtomicBool` 轮询 / `Notify` 等散装信号，
//! 收敛为单一关停管线。
//!
//! 之所以用进程级全局而非挂在 Tauri 托管状态上：SSH 连接池是 `LazyLock` 全局单例，其清理
//! 任务在首个 `acquire` 时懒启动，并无通往 `AppHandle` / 托管状态的路径；进程级单一取消源
//! 是唯一能被所有后台循环共享的关停信号，也最贴合「单一管线」。
//!
//! 与 `process_guard`（崩溃 / 强杀时由 OS 级 Job Object 连带终结子进程的兜底）互补：本模块
//! 负责优雅退出的协同停止，Job Object 负责非优雅消失的兜底，二者各司其职、不重叠。

use std::sync::LazyLock;

use tokio_util::sync::CancellationToken;

/// 进程级关停令牌：全局唯一，所有后台常驻循环共享其取消状态。
static SHUTDOWN: LazyLock<CancellationToken> = LazyLock::new(CancellationToken::new);

/// 取得共享关停令牌的克隆。`CancellationToken` 内部以 `Arc` 共享同一取消状态，克隆开销可
/// 忽略；持有者可在其上 `cancelled().await`，与 `tokio::select!` 配合实现即时、零轮询的退出。
pub(crate) fn shutdown_token() -> CancellationToken {
    SHUTDOWN.clone()
}

/// 触发进程级优雅关停：取消全局令牌，唤醒所有等待中的后台循环令其退出。幂等——重复调用无副作用。
pub(crate) fn trigger_shutdown() {
    SHUTDOWN.cancel();
}
