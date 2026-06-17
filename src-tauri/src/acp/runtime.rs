//! 宿主侧 ACP 连接的进程级生命周期管理（Tauri 托管状态）。
//!
//! 严格对齐 Zed `agent_servers::acp::AcpConnection`（crates/agent_servers/src/acp.rs）
//! 的连接持有模型，不自创：
//!   * **连接由宿主实体持有，而非进程级隐藏全局**——Zed 把 `AcpConnection`（其内部
//!     持有派生的子进程 `child` 与 I/O / dispatch / wait / stderr 等后台任务）作为
//!     `Rc<dyn AgentConnection>` 交由 GPUI 实体持有；本模块把按后端（builtin / 外部 agent）
//!     各自的常驻 `AcpHost` 交由 Tauri 托管状态 `AcpRuntime` 持有，二者同构（集中一处
//!     持有、随持有者释放而关停），而非把连接藏进无句柄可达的全局单例。
//!   * **按需建立、单连接复用**——Zed 在首次开启某个 agent 线程时才 `connect`（派生
//!     stdio 子进程），其后复用同一连接；本模块以 `get_or_spawn` 懒建立并缓存（每
//!     个后端一份），缺省不在 App 启动期派生 node 子进程（AI 未被使用时零额外开销）。
//!   * **关停即释放**——Zed 实体 drop 时连接任务结束、子进程被回收；本模块在 App 统一
//!     退出清理（`run_exit_cleanup`）中调用 `shutdown`，令全部后端的常驻连接任务结束、
//!     stdio 子进程随之回收。
//!
//! 多后端（ADR-0015 阶段 2）：自家边车（Builtin）与外部 ACP 编码 agent（Kimi Code /
//! Codex 等）各自是独立的 stdio 子进程，故按 `AcpBackendId` 各持有一个 `AcpHost`。
//! 历史调用点只涉 Builtin，故 `get_or_spawn` / `restart` / `shutdown` 语义与签名不变
//! （内部委托给 `*_backend(Builtin)`）；驱动外部 agent 走新增的 `*_backend` 变体。
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

use parking_lot::Mutex;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Runtime};

use super::approval::ApprovalRequestInfo;
use super::client::{AcpClientError, AcpStreamFrame};
use super::host::{AcpHost, ApprovalEmitter, StreamEmitter};
use super::launch::{AcpBackendId, build_acp_client_config_for};

/// 流式帧 webview 事件名：对齐 `client::AcpStreamFrame` 文档约定的 `ai:sidecar-stream` 契约。
pub(crate) const ACP_STREAM_EVENT: &str = "ai:sidecar-stream";

/// 回合内待决审批 webview 事件名：与流式事件并列的审批下沉口。
const ACP_APPROVAL_EVENT: &str = "ai:sidecar-approval";

/// 按后端持有「至多一个」常驻 `AcpHost` 的显式槽位集合（ADR-0015 阶段 2：多 host）。
///
/// 显式三槽而非 HashMap：槽位与 `AcpBackendId` 一一对应，`slot` 的 match 穷尽，新增后端时
/// 编译器会在 `slot` 处强制更新；`all` / `drain_all` 亦需同步登记（见各自注释）。
#[derive(Default)]
struct BackendHosts {
    builtin: Option<Arc<AcpHost>>,
    kimi: Option<Arc<AcpHost>>,
    codex: Option<Arc<AcpHost>>,
}

impl BackendHosts {
    /// 取某后端的槽位可变引用。match 穷尽：新增 `AcpBackendId` 变体会在此处触发编译错误。
    fn slot(&mut self, backend: AcpBackendId) -> &mut Option<Arc<AcpHost>> {
        match backend {
            AcpBackendId::Builtin => &mut self.builtin,
            AcpBackendId::Kimi => &mut self.kimi,
            AcpBackendId::Codex => &mut self.codex,
        }
    }

    /// 当前已建立的全部宿主（克隆 Arc）。新增后端槽位时需在此同步登记。
    fn all(&self) -> Vec<Arc<AcpHost>> {
        [self.builtin.clone(), self.kimi.clone(), self.codex.clone()]
            .into_iter()
            .flatten()
            .collect()
    }

    /// 取走并清空全部宿主槽位。新增后端槽位时需在此同步登记。
    fn drain_all(&mut self) -> Vec<Arc<AcpHost>> {
        [self.builtin.take(), self.kimi.take(), self.codex.take()]
            .into_iter()
            .flatten()
            .collect()
    }

    /// 是否尚无任何已建立的宿主。
    fn is_empty(&self) -> bool {
        self.builtin.is_none() && self.kimi.is_none() && self.codex.is_none()
    }
}

/// 宿主侧 ACP 连接的进程级持有者（Tauri 托管状态）。
///
/// 内部以 `Mutex<BackendHosts>` 按后端持有「至多一个」常驻 `AcpHost`：缺省全空，
/// 某后端的首个请求经 `get_or_spawn[_backend]` 懒建立后缓存复用；`shutdown` 取出并
/// 关停全部。整体 `Send + Sync + 'static`，可直接作为 Tauri 托管状态。
#[derive(Default)]
pub struct AcpRuntime {
    hosts: Mutex<BackendHosts>,
}

impl AcpRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    /// 获取**默认后端（自家边车）**的常驻 `AcpHost`。语义与历史一致：
    /// 等价于 `get_or_spawn_backend(app, AcpBackendId::Builtin)`。
    pub fn get_or_spawn<R: Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<Arc<AcpHost>, AcpClientError> {
        self.get_or_spawn_backend(app, AcpBackendId::Builtin)
    }

    /// 获取指定后端的常驻 `AcpHost`；尚未建立时用给定 `AppHandle` 装配真实 emit 闭包并
    /// 懒建立、缓存。不同后端各自持有独立 `AcpHost`（独立 stdio 子进程），互不影响。
    ///
    /// `AcpHost::spawn` 为同步调用（内部 `tokio::spawn` 常驻连接任务后立即返回句柄），
    /// 故在持锁期间建立不会跨 await 持锁；后续调用直接返回已缓存 `Arc` 的克隆。
    pub fn get_or_spawn_backend<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        backend: AcpBackendId,
    ) -> Result<Arc<AcpHost>, AcpClientError> {
        let mut guard = self.hosts.lock();
        if let Some(host) = guard.slot(backend).as_ref() {
            return Ok(host.clone());
        }

        // 启动配置解析失败（未找到 node / ACP 入口等）等价于「无法建立传输」，
        // 故归入 Transport 错误，与连接派生失败同类上抛。
        let config = build_acp_client_config_for(backend).map_err(AcpClientError::Transport)?;
        let host = Arc::new(AcpHost::spawn(
            config,
            stream_emitter(app.clone()),
            approval_emitter(app.clone()),
        )?);
        *guard.slot(backend) = Some(host.clone());
        Ok(host)
    }

    /// 强制重启**默认后端（自家边车）**。语义与历史一致：
    /// 等价于 `restart_backend(app, AcpBackendId::Builtin)`。
    pub fn restart<R: Runtime>(&self, app: &AppHandle<R>) -> Result<Arc<AcpHost>, AcpClientError> {
        self.restart_backend(app, AcpBackendId::Builtin)
    }

    /// 强制重启指定后端：关停其现有宿主（若有）后立即用给定 `AppHandle` 重新派生、
    /// 缓存一个新宿主。语义对齐旧 HTTP sidecar 的「重启」（`agent_sidecar::restart`）：
    /// 不论当前连接状态如何，丢弃并重建。
    ///
    /// 与 `get_or_spawn_backend` 一致由 `AppHandle` 装配真实 emit 闭包；`AcpHost::spawn` 同步
    /// 返回句柄，故在持锁期间「先关停旧者再派生新者」不跨 await 持锁；先 `take` 并
    /// `shutdown` 旧宿主（结束其常驻连接任务、回收 stdio 子进程），保证重建后不残留两份连接。
    pub fn restart_backend<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        backend: AcpBackendId,
    ) -> Result<Arc<AcpHost>, AcpClientError> {
        let mut guard = self.hosts.lock();
        // 先关停旧宿主：结束其常驻连接任务并回收 stdio 子进程，避免重建后残留两份连接。
        if let Some(previous) = guard.slot(backend).take() {
            previous.shutdown();
        }

        let config = build_acp_client_config_for(backend).map_err(AcpClientError::Transport)?;
        let host = Arc::new(AcpHost::spawn(
            config,
            stream_emitter(app.clone()),
            approval_emitter(app.clone()),
        )?);
        *guard.slot(backend) = Some(host.clone());
        Ok(host)
    }

    /// 取消指定线程（thread_id）当前进行中的回合。线程绑定的会话可能落在任一后端宿主，
    /// 故向全部**已建立**宿主广播取消（未绑定该线程的宿主侧为安全空操作 + 一条告警日志）。
    /// 缺省（无任何宿主）时为安全空操作：取消本身绝不应触发 node 子进程派生。
    pub fn cancel_thread(&self, thread_id: &str) {
        // 先取出 Arc 列表并释放锁，避免在广播取消期间持有 runtime 锁。
        let hosts = self.hosts.lock().all();
        for host in hosts {
            host.cancel_thread(thread_id);
        }
    }

    /// 投递一个审批决策，唤醒回合内挂起的权限请求（反向 `session/request_permission`）。
    /// 挂起项落在发起该请求的那个后端宿主的登记表里，故向全部**已建立**宿主广播投递：
    /// 命中（成功唤醒某挂起回合）任一宿主即返回 `true`；无匹配挂起项或无任何宿主时返回
    /// `false`（安全空操作——审批解决绝不应触发 node 子进程派生）。
    pub fn resolve_approval(&self, session_id: &str, tool_call_id: &str, decision: &str) -> bool {
        // 先取出 Arc 列表并释放锁，避免在广播投递期间持有 runtime 锁。
        let hosts = self.hosts.lock().all();
        let mut resolved = false;
        for host in hosts {
            if host
                .resolve_approval(session_id, tool_call_id, decision)
                .is_ok()
            {
                resolved = true;
            }
        }
        resolved
    }

    /// 关停并释放全部后端的常驻连接（App 统一退出清理调用）。幂等：无宿主时为安全空操作。
    pub fn shutdown(&self) {
        // 先取走全部 Arc 并释放锁，避免在逐个关停期间持有 runtime 锁。
        let hosts = self.hosts.lock().drain_all();
        for host in hosts {
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
        let Some(ui_event) = super::ui_event::session_notification_to_ui_event(&frame.event) else {
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
        assert!(runtime.hosts.lock().is_empty());
    }

    #[test]
    fn resolve_approval_on_unestablished_runtime_is_noop() {
        let runtime = AcpRuntime::new();
        // 无任何宿主时，审批解决为安全空操作：返回 false 且绝不派生子进程。
        assert!(!runtime.resolve_approval("sess-1", "tool-1", "allow-once"));
        assert!(runtime.hosts.lock().is_empty());
    }

    #[test]
    fn webview_event_names_match_documented_contract() {
        // 守护与前端约定的 webview 事件名，防止静默契约漂移。
        assert_eq!(ACP_STREAM_EVENT, "ai:sidecar-stream");
        assert_eq!(ACP_APPROVAL_EVENT, "ai:sidecar-approval");
    }
}
