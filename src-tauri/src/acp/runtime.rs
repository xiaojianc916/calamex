//! 宿主侧 ACP 连接的进程级生命周期管理（Tauri 托管状态）。
//!
//! 严格对齐 Zed `agent_servers::acp::AcpConnection`（crates/agent_servers/src/acp.rs）
//! 的连接持有模型，不自创：
//!   * **连接由宿主实体持有，而非进程级隐藏全局**——Zed 把 `AcpConnection`（其内部
//!     持有派生的子进程 `child` 与 I/O / dispatch / wait / stderr 等后台任务）作为
//!     `Rc<dyn AgentConnection>` 交由 GPUI 实体持有；本模块把单一 `AcpHost` 交由 Tauri
//!     托管状态 `AcpRuntime` 持有，二者同构（集中一处持有、随持有者释放而关停），
//!     而非把连接藏进无句柄可达的全局单例。
//!   * **按需建立、单连接复用**——Zed 在首次开启某个 agent 线程时才 `connect`（派生
//!     stdio 子进程），其后复用同一连接；本模块以 `get_or_spawn` 懒建立并缓存，缺省
//!     不在 App 启动期派生 node 子进程（AI 未被使用时零额外开销）。
//!   * **关停即释放**——Zed 实体 drop 时连接任务结束、子进程被回收；本模块在 App 统一
//!     退出清理（`run_exit_cleanup`）中调用 `shutdown`，令 `AcpHost` 的常驻连接任务结束、
//!     stdio 子进程随之回收。
//!
//! 与 Tauri 事件解耦的 emit 闭包在此由 `AppHandle` 装配为「真实下沉口」：
//!   * 流式帧 → 经 `ui_event` 投影为前端 `TAgentUiEvent` 后转发到 webview 事件
//!     `ai:sidecar-stream`（payload 形状 `{sessionId, seq, event}` 见 `client::AcpStreamFrame`；
//!     event 为 `TAgentUiEvent`，对齐前端原生消费端 src/composables/ai/sidecar-events.ts）；
//!   * 回合内待决审批 → webview 事件 `ai:sidecar-approval`（详情见 `approval::ApprovalRequestInfo`）。
//!
//! 一次性「工具型」`model/chat` 调用不产生 `session/update` 流式帧、亦不触发反向权限
//! 请求，故二者在工具型调用期保持静默；待 Layer 6 接入 agentic 主回合（`session/prompt`）
//! 的实时流式与审批 UI 时即自然生效，无需重建连接——故此处一次装配到位，并非过渡脚手架。
//!
//! 按 cargo feature `acp_client` 门控；`get_or_spawn` 的调用点在 Layer 5 接线，故迁移期
//! 公开项暂无消费者，dead_code 警告为预期之内（与姊妹模块一致）。

#![allow(dead_code)]

use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Runtime};

use super::approval::ApprovalRequestInfo;
use super::client::{AcpClientError, AcpStreamFrame};
use super::host::{AcpHost, ApprovalEmitter, StreamEmitter};
use super::launch::build_acp_client_config;

/// 流式帧 webview 事件名：对齐 `client::AcpStreamFrame` 文档约定的 `ai:sidecar-stream` 契约。
const ACP_STREAM_EVENT: &str = "ai:sidecar-stream";

/// 回合内待决审批 webview 事件名：与流式事件并列的审批下沉口。
const ACP_APPROVAL_EVENT: &str = "ai:sidecar-approval";

/// 宿主侧 ACP 连接的进程级持有者（Tauri 托管状态）。
///
/// 内部以 `Mutex<Option<Arc<AcpHost>>>` 持有「至多一个」常驻 `AcpHost`：缺省为空，
/// 首个请求经 `get_or_spawn` 懒建立后缓存复用；`shutdown` 取出并关停。整体
/// `Send + Sync + 'static`，可直接作为 Tauri 托管状态。
#[derive(Default)]
pub struct AcpRuntime {
    host: Mutex<Option<Arc<AcpHost>>>,
}

impl AcpRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    /// 获取常驻 `AcpHost`；尚未建立时用给定 `AppHandle` 装配真实 emit 闭包并懒建立、缓存。
    ///
    /// `AcpHost::spawn` 为同步调用（内部 `tokio::spawn` 常驻连接任务后立即返回句柄），
    /// 故在持锁期间建立不会跨 await 持锁；后续调用直接返回已缓存 `Arc` 的克隆。
    pub fn get_or_spawn<R: Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<Arc<AcpHost>, AcpClientError> {
        let mut guard = self.host.lock().expect("acp runtime mutex poisoned");
        if let Some(host) = guard.as_ref() {
            return Ok(host.clone());
        }

        // 启动配置解析失败（未找到 node / ACP 入口等）等价于「无法建立传输」，
        // 故归入 Transport 错误，与连接派生失败同类上抛。
        let config = build_acp_client_config().map_err(AcpClientError::Transport)?;
        let host = Arc::new(AcpHost::spawn(
            config,
            stream_emitter(app.clone()),
            approval_emitter(app.clone()),
        )?);
        *guard = Some(host.clone());
        Ok(host)
    }

    /// 关停并释放常驻连接（App 统一退出清理调用）。幂等：未建立时为安全的空操作。
    pub fn shutdown(&self) {
        let host = self.host.lock().expect("acp runtime mutex poisoned").take();
        if let Some(host) = host {
            host.shutdown();
        }
    }
}

/// 装配流式帧下沉口：把每条 `session/update` 帧经 `ui_event` 投影为前端
/// `TAgentUiEvent` 后转发到 webview 事件 `ai:sidecar-stream`，使 ACP 主聊天流可直接
/// 复用既有前端原生消费端（src/composables/ai/sidecar-events.ts）。无对应 UI 事件的
/// `session/update` 变体（工具/计划/usage_update 等，在 ask 主聊天回合不出现）跳过不下发；
/// 回合累积器在 host 侧 `EventSink` 已先行消费原始帧，故此处投影不影响响应信封重建。
fn stream_emitter<R: Runtime>(app: AppHandle<R>) -> StreamEmitter {
    Arc::new(move |frame: AcpStreamFrame| {
        let Some(ui_event) = super::ui_event::session_notification_to_ui_event(&frame.event)
        else {
            return;
        };
        let payload = AcpStreamFrame {
            session_id: frame.session_id,
            seq: frame.seq,
            event: ui_event,
        };
        if let Err(error) = app.emit(ACP_STREAM_EVENT, &payload) {
            log::warn!("failed to emit acp stream frame to webview: {error}");
        }
    })
}

/// 装配待决审批下沉口：把回合内挂起的权限请求详情转发到 webview 事件 `ai:sidecar-approval`。
fn approval_emitter<R: Runtime>(app: AppHandle<R>) -> ApprovalEmitter {
    Arc::new(move |info: ApprovalRequestInfo| {
        if let Err(error) = app.emit(ACP_APPROVAL_EVENT, &info) {
            log::warn!("failed to emit acp approval request to webview: {error}");
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shutdown_on_unestablished_runtime_is_noop() {
        let runtime = AcpRuntime::new();
        // 未建立连接时关停应为安全的空操作（不 panic、不阻塞）；且可重复调用（幂等）。
        runtime.shutdown();
        runtime.shutdown();
        assert!(runtime.host.lock().unwrap().is_none());
    }

    #[test]
    fn webview_event_names_match_documented_contract() {
        // 守护与前端约定的 webview 事件名，防止静默契约漂移。
        assert_eq!(ACP_STREAM_EVENT, "ai:sidecar-stream");
        assert_eq!(ACP_APPROVAL_EVENT, "ai:sidecar-approval");
    }
}
