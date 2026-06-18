//! 宿主侧 ACP 编排核心（Layer 4）。
//!
//! 这是「先加新模块 → cargo 验证 → 绿了再删旧」迁移路径中按 cargo feature
//! `acp_client` 门控的新增模块，落地阶段不影响现有 HTTP/NDJSON sidecar。
//!
//! 把同目录两层装配成单一编排面，对齐 sidecar 自身的 ACP Agent（见
//! `agent-sidecar/src/acp/agent.ts`）与 Zed `agent_ui/acp_thread.rs` 的回合模型，
//! 不自创协议语义：
//!   * `client`   —— 常驻 stdio 连接 + 命令句柄（new_session / prompt /
//!     set_session_mode / restore_checkpoint / model_chat / web_search / web_fetch /
//!     warmup / health / orchestrate / orchestrate_resume / agent_chat /
//!     agent_chat_resolve / agent_ask_user_resume / cancel / shutdown）；
//!   * `approval` —— 回合内反向 `session/request_permission` 的挂起登记表。
//!
//! 设计要点（均据一手源码核对，不臆造）：
//!   * **会话即线程**：对齐 Zed `session_id = thread.id()`——前端传稳定 `thread_id`，
//!     宿主持有 `thread_id ↔ SessionId` 映射并跨回合复用同一 ACP 会话
//!     （`ensure_session`）。
//!   * **模型配置不入 prompt**：模型凭据由 sidecar 进程环境变量在启动期解析。
//!   * **审批即回合内挂起**：危险工具经反向 `session/request_permission` 在回合内
//!     挂起，`resolve_approval` 经登记表唤醒同一回合续跑。
//!   * **流式即转发**：单一 `EventSink` 把每条 `session/update` 帧原样转发给接线层的
//!     emit（`runtime::stream_emitter`）；帧 → 前端 `TAgentUiEvent` 的投影由该 emit
//!     单点负责（见 `ui_event`），本层不投影。权威结果由各扩展方法（agent_chat /
//!     orchestrate 等）的返回信封承载。
//!   * **编排/对话即带外**：`orchestrate` / `orchestrate_resume` / `agent_chat` /
//!     `agent_chat_resolve` 是标准会话回合（`prompt`）之外的「带外」能力，经
//!     sidecar 公示的扩展方法通道下发（标准客户端不识别会安全忽略）。agent_chat
//!     承载 agent 模式富对话回合：原生 `session/prompt` 的 `session/update` 投影有损
//!     （仅文本/思考增量，丢结构化补丁/检查点/回滚/富审批/plan_ready 等 agent UI
//!     词表），故 agent_chat 跑到审批门或终态，过程增量经 `session/update` 仅作实时
//!     预览，真正权威的富事件由返回信封承载（与旧 http /agent/chat 同构，前端无感）。
//!
//! 外部 ACP 编码 agent（Kimi Code / Codex 等，见 ADR-0015）走的是标准回合 `prompt`
//! 而非上述带外扩展方法：它们不认识 `calamex.dev/*`，只实现标准 session/prompt；
//! 过程增量全部经 `session/update` 帧由 `EventSink` 转发（投影见 `ui_event`）。

// 过渡期：本模块部分薄宿主方法（web_search / web_fetch / restore_checkpoint / prompt 等）尚未
// 全部接线到宿主命令，crate 外暂无调用点；接线后移除该 allow。
#![allow(dead_code)]

use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::{ContentBlock, SessionId, SessionModeId, StopReason, ToolCallId};

use crate::commands::contracts::{
    AgentSidecarHealthPayload, AgentSidecarOrchestratePayload, AgentSidecarResponsePayload,
    AgentSidecarWarmupPayload, AiWebFetchPayload, AiWebSearchPayload,
};

use super::approval::{ApprovalError, ApprovalRegistry, ApprovalRequestInfo};
use super::client::{
    AcpClientConfig, AcpClientError, AcpClientHandle, AcpStreamFrame, AgentAskUserResumeExtRequest,
    AgentChatExtRequest, AgentChatResolveExtRequest, CheckpointRestoreRequest, EventSink,
    HealthExtRequest, ModelChatExtRequest, OrchestrateExtRequest, OrchestrateResumeExtRequest,
    WarmupExtRequest, WebFetchExtRequest, WebSearchExtRequest, spawn_acp_client,
};

/// 流式帧下沉口：把每条 `session/update` 帧转发给 webview（对齐 `ai:sidecar-stream`
/// 的 `{sessionId, seq, event}` 契约）。由宿主接线层提供 emit 闭包。
pub type StreamEmitter = Arc<dyn Fn(AcpStreamFrame) + Send + Sync>;

/// 待决审批下沉口：把回合内挂起的权限请求详情推给 webview 渲染审批 UI。
/// 由宿主接线层提供 emit 闭包；其回传决策经 `resolve_approval` 唤醒回合。
pub type ApprovalEmitter = Arc<dyn Fn(ApprovalRequestInfo) + Send + Sync>;

/// 一次 `orchestrate` 编排启动的宿主侧入参。
#[derive(Debug, Clone, Default)]
pub struct AcpOrchestrateStart {
    /// 编排目标（自然语言），原样透传给 sidecar。
    pub goal: String,
    /// 稳定线程标识：用于 `ensure_session` 复用/新建会话。
    pub thread_id: Option<String>,
    /// 每次运行的执行偏好（interactive/autonomous）；取值由 sidecar zod 校验。
    pub execution_mode: Option<String>,
    /// 新建会话时作为 cwd（→ sidecar workspaceRootPath）；复用会话时忽略。
    pub workspace_root_path: Option<String>,
}

/// 一次 `orchestrate_resume` 编排续跑的宿主侧入参。
#[derive(Debug, Clone, Default)]
pub struct AcpOrchestrateResume {
    /// 被挂起编排运行的标识，原样透传给 sidecar 以定位续跑目标。
    pub run_id: String,
    /// 审批决策（approve/reject/continue/cancel）；取值由 sidecar zod 校验，原样透传。
    pub decision: String,
    /// 可选的决策理由；为空白时整字段省略。
    pub reason: Option<String>,
    /// 稳定线程标识：用于 `ensure_session` 复用同一会话并随请求透传。
    pub thread_id: Option<String>,
}

/// 宿主侧 ACP 编排句柄。可作为 Tauri 托管状态长驻：内部协作件均为
/// 可克隆/共享句柄，整体 `Send + Sync`。
pub struct AcpHost {
    handle: AcpClientHandle,
    approvals: ApprovalRegistry,
    /// `thread_id ↔ ACP SessionId` 映射（对齐 Zed `session_id = thread.id()`）。
    sessions: Arc<Mutex<HashMap<String, SessionId>>>,
}

impl AcpHost {
    /// 启动常驻 ACP 连接并装配编排面。
    pub fn spawn(
        config: AcpClientConfig,
        emit: StreamEmitter,
        on_approval: ApprovalEmitter,
    ) -> Result<Self, AcpClientError> {
        let approvals = ApprovalRegistry::new();
        let resolver = approvals.resolver(on_approval);

        // 单一下沉口：把每条 `session/update` 帧原样转发给 emit 闭包。
        // 帧 → 前端 TAgentUiEvent 的投影由接线层的 emit（runtime::stream_emitter）统一负责：
        // 它经 ui_event::session_notification_to_ui_event 投影，并对无对应 UI 事件的变体
        // （tool_call(_update)/plan/usage_update/current_mode_update 等）返回 None 跳过、不下发。
        // 此处不得再投影，否则会对已投影帧二次投影（其 event 已无 update.sessionUpdate 字段）
        // 必返回 None 而被丢弃，导致各模式 live 增量为零、气泡无流式。
        // 终态 done/error 不走 session/update，由 chat_stream 经 app.emit 直接合成补发。
        let sink: EventSink = Arc::new(move |frame: AcpStreamFrame| emit(frame));

        let handle = spawn_acp_client(config, sink, resolver)?;
        Ok(Self {
            handle,
            approvals,
            sessions: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// 解析某 thread 对应的 ACP 会话（`thread_id ↔ SessionId`，贴 Zed 做法）：
    /// 命中映射则跨回合复用既有 `SessionId`；否则按工作区根新建会话并登记。
    pub async fn ensure_session(
        &self,
        thread_id: &str,
        workspace_root_path: Option<&str>,
    ) -> Result<SessionId, AcpClientError> {
        let thread_key = thread_id.trim();
        if !thread_key.is_empty()
            && let Some(existing) = self.sessions.lock().get(thread_key).cloned()
        {
            return Ok(existing);
        }

        let cwd = workspace_cwd(workspace_root_path);
        let session_id = self.handle.new_session(cwd).await?;
        if !thread_key.is_empty() {
            self.sessions
                .lock()
                .insert(thread_key.to_string(), session_id.clone());
        }
        Ok(session_id)
    }

    /// 驱动一轮**标准 ACP 回合**（`session/prompt`）：解析/复用 thread 的会话后，把内容块
    /// 直接交给标准 `prompt`，返回回合终止原因 `StopReason`。
    ///
    /// 与带外的 `agent_chat` / `orchestrate`（自家 sidecar 扩展方法）不同，本方法走的是
    /// ACP 标准回合通道，供**外部 ACP 编码 agent**（Kimi Code / Codex 等，见 ADR-0015）使用——
    /// 它们不认识 `calamex.dev/*` 扩展方法，只实现标准 `prompt`。过程增量（文本/思考/工具
    /// 调用/计划等）经 `session/update` 帧由 `EventSink` 转发（投影见 `ui_event`），本方法仅
    /// 返回终态原因，不承载富信封（外部 agent 无自家信封）。
    pub async fn prompt(
        &self,
        thread_id: &str,
        workspace_root_path: Option<&str>,
        blocks: Vec<ContentBlock>,
    ) -> Result<StopReason, AcpClientError> {
        let session_id = self.ensure_session(thread_id, workspace_root_path).await?;
        self.handle.prompt(session_id, blocks).await
    }

    /// 投递一个审批决策，唤醒回合内挂起的权限请求（其 `prompt` 随后续跑并最终返回）。
    pub fn resolve_approval(
        &self,
        session_id: &str,
        tool_call_id: &str,
        decision: &str,
    ) -> Result<(), ApprovalError> {
        self.approvals.resolve(
            SessionId::from(session_id.to_string()),
            ToolCallId::from(tool_call_id.to_string()),
            decision,
        )
    }

    /// 切换指定线程当前 ACP 会话的模式（标准 session/set_mode 请求）。
    ///
    /// 仅在本宿主已绑定该 thread_id 的会话时执行：命中则下发 session/set_mode 并返回
    /// Ok(true)；未绑定（空 thread / 无映射）则返回 Ok(false) 作为安全空操作，交由 runtime
    /// 广播给真正持有该线程的后端宿主。绝不在此 ensure_session 新建会话——模式切换只对既有
    /// 会话有意义（对齐 cancel_thread 的「无会话即空操作」语义）。纯转发，不修改本地状态。
    pub async fn set_session_mode(
        &self,
        thread_id: &str,
        mode_id: &str,
    ) -> Result<bool, AcpClientError> {
        let thread_key = thread_id.trim();
        if thread_key.is_empty() {
            return Ok(false);
        }
        let session_id = self.sessions.lock().get(thread_key).cloned();
        let Some(session_id) = session_id else {
            return Ok(false);
        };
        self.handle
            .set_session_mode(session_id, SessionModeId::from(mode_id.to_string()))
            .await?;
        Ok(true)
    }

    /// 触发检查点回滚（扩展方法 `calamex.dev/checkpoint/restore`）。
    pub async fn restore_checkpoint(
        &self,
        request: CheckpointRestoreRequest,
    ) -> Result<AgentSidecarResponsePayload, AcpClientError> {
        let value = self.handle.restore_checkpoint(request).await?;
        serde_json::from_value(value).map_err(|error| {
            AcpClientError::Protocol(format!(
                "invalid checkpoint restore response envelope: {error}"
            ))
        })
    }

    /// 原始模型透传（扩展方法 `calamex.dev/model/chat`）。
    pub async fn model_chat(
        &self,
        request: ModelChatExtRequest,
    ) -> Result<AgentSidecarResponsePayload, AcpClientError> {
        let value = self.handle.model_chat(request).await?;
        serde_json::from_value(value).map_err(|error| {
            AcpClientError::Protocol(format!("invalid model chat response envelope: {error}"))
        })
    }

    /// 联网搜索（扩展方法 `calamex.dev/web/search`）。
    pub async fn web_search(
        &self,
        request: WebSearchExtRequest,
    ) -> Result<AiWebSearchPayload, AcpClientError> {
        let value = self.handle.web_search(request).await?;
        serde_json::from_value(value).map_err(|error| {
            AcpClientError::Protocol(format!("invalid web search response payload: {error}"))
        })
    }

    /// 联网抓取（扩展方法 `calamex.dev/web/fetch`）。
    pub async fn web_fetch(
        &self,
        request: WebFetchExtRequest,
    ) -> Result<AiWebFetchPayload, AcpClientError> {
        let value = self.handle.web_fetch(request).await?;
        serde_json::from_value(value).map_err(|error| {
            AcpClientError::Protocol(format!("invalid web fetch response payload: {error}"))
        })
    }

    /// 预热模型连接（扩展方法 `calamex.dev/warmup`）。
    pub async fn warmup(
        &self,
        request: WarmupExtRequest,
    ) -> Result<AgentSidecarWarmupPayload, AcpClientError> {
        let value = self.handle.warmup(request).await?;
        serde_json::from_value(value).map_err(|error| {
            AcpClientError::Protocol(format!("invalid warmup response payload: {error}"))
        })
    }

    /// 探测 sidecar 健康状态（扩展方法 `calamex.dev/health`）。
    pub async fn health(&self) -> Result<AgentSidecarHealthPayload, AcpClientError> {
        let value = self.handle.health(HealthExtRequest {}).await?;
        serde_json::from_value(value).map_err(|error| {
            AcpClientError::Protocol(format!("invalid health response payload: {error}"))
        })
    }

    /// 启动一次原生计划编排（扩展方法 `calamex.dev/plan/orchestrate`）。
    pub async fn orchestrate(
        &self,
        start: AcpOrchestrateStart,
    ) -> Result<AgentSidecarOrchestratePayload, AcpClientError> {
        let session_id = self
            .ensure_session(
                start.thread_id.as_deref().unwrap_or_default(),
                start.workspace_root_path.as_deref(),
            )
            .await?;
        let request = OrchestrateExtRequest {
            goal: start.goal,
            thread_id: non_empty(start.thread_id.as_deref()).map(str::to_string),
            execution_mode: non_empty(start.execution_mode.as_deref()).map(str::to_string),
            session_id: Some(session_id.to_string()),
            model_config: None,
        };
        let value = self.handle.orchestrate(request).await?;
        serde_json::from_value(value).map_err(|error| {
            AcpClientError::Protocol(format!("invalid orchestrate response payload: {error}"))
        })
    }

    /// 恢复一个被审批门挂起的编排运行（扩展方法 `calamex.dev/plan/orchestrate/resume`）。
    pub async fn orchestrate_resume(
        &self,
        resume: AcpOrchestrateResume,
    ) -> Result<AgentSidecarOrchestratePayload, AcpClientError> {
        let session_id = self
            .ensure_session(resume.thread_id.as_deref().unwrap_or_default(), None)
            .await?;
        let request = OrchestrateResumeExtRequest {
            run_id: resume.run_id,
            decision: resume.decision,
            reason: non_empty(resume.reason.as_deref()).map(str::to_string),
            session_id: Some(session_id.to_string()),
            model_config: None,
        };
        let value = self.handle.orchestrate_resume(request).await?;
        serde_json::from_value(value).map_err(|error| {
            AcpClientError::Protocol(format!(
                "invalid orchestrate resume response payload: {error}"
            ))
        })
    }

    /// 发起一轮 agent 模式对话（扩展方法 `calamex.dev/agent/chat`）。
    ///
    /// 标准会话回合（`prompt`）之外的「带外」能力，承载 agent 模式富对话回合：
    /// run-to-gate（跑到审批门或终态），过程增量经 `session/update` 仅作实时预览，权威
    /// 的富事件（结构化补丁/检查点/回滚/富审批/plan_ready 等）由返回信封承载。同
    /// `orchestrate` 不在此累积回合，帧仅经 `EventSink` 转发 webview。入参为已构造的
    /// 扩展请求（与 contract 的转换、及 `ensure_session(thread_id)` 的会话连续性由接线层
    /// 负责，同 restore_checkpoint / model_chat 的薄宿主方法 + 命令层组装划分）。sidecar 把
    /// 响应投影为与 chat 同构的信封（`toAgentChatExtResult = toAgentSidecarResponse`，
    /// schemaVersion + sessionId + events + result），故此处直接复用既有
    /// `AgentSidecarResponsePayload` 解析（同 restore_checkpoint，多余 `schemaVersion` 字段
    /// 按 serde 默认忽略），与旧 HTTP `/agent/chat` 的返回同形（前端无感）。
    pub async fn agent_chat(
        &self,
        request: AgentChatExtRequest,
    ) -> Result<AgentSidecarResponsePayload, AcpClientError> {
        let value = self.handle.agent_chat(request).await?;
        serde_json::from_value(value).map_err(|error| {
            AcpClientError::Protocol(format!("invalid agent chat response envelope: {error}"))
        })
    }

    /// 恢复一轮挂起在审批门的 agent 对话（扩展方法 `calamex.dev/agent/chat/resolve`）。
    ///
    /// 镜像旧 http `/approval/resolve` → `runtime.resolveApproval(...)`：携带上一段返回信封里
    /// approval_required 的 `request_id` 与 `decision`，裁决后续跑同一回合并返回下一段
    /// 响应信封（若再遇审批门则信封再携 approval_required）。入参为已构造的扩展请求
    /// （同 agent_chat 由接线层负责 contract 转换与会话解析）。响应同 agent_chat：整封
    /// sidecar 信封解析为既有 `AgentSidecarResponsePayload`，与旧 HTTP `/approval/resolve` 返回同形。
    pub async fn agent_chat_resolve(
        &self,
        request: AgentChatResolveExtRequest,
    ) -> Result<AgentSidecarResponsePayload, AcpClientError> {
        let value = self.handle.agent_chat_resolve(request).await?;
        serde_json::from_value(value).map_err(|error| {
            AcpClientError::Protocol(format!(
                "invalid agent chat resolve response envelope: {error}"
            ))
        })
    }

    /// 恢复一轮挂起在 ask_user 反向提问的 agent 对话（扩展方法 `calamex.dev/agent/ask-user/resume`）。
    ///
    /// 与 agent_chat_resolve 同构，但以 ask_user 套件的 outcome + 结构化 answers 取代审批 decision：
    /// 携带上一段返回信封里 ask_user_required 的 `request_id`、用户选择的 `outcome`（selected/
    /// cancelled）与逐题 `answers`，回灌给 sidecar 工具的 resumeSchema 后续跑同一回合并返回
    /// 下一段响应信封（若再遇提问门或审批门则信封再携对应事件）。入参为已构造的扩展请求
    /// （同 agent_chat_resolve 由接线层负责 contract 转换与会话解析）。响应同 agent_chat_resolve：
    /// 整封 sidecar 信封解析为既有 `AgentSidecarResponsePayload`，与旧 HTTP 对话恢复返回同形（前端无感）。
    pub async fn agent_ask_user_resume(
        &self,
        request: AgentAskUserResumeExtRequest,
    ) -> Result<AgentSidecarResponsePayload, AcpClientError> {
        let value = self.handle.agent_ask_user_resume(request).await?;
        serde_json::from_value(value).map_err(|error| {
            AcpClientError::Protocol(format!(
                "invalid agent ask-user resume response envelope: {error}"
            ))
        })
    }

    /// 取消指定会话的当前回合：先清除其全部挂起审批，再下发 ACP `session/cancel` 通知。
    pub fn cancel(&self, session_id: &str) {
        let session_id = SessionId::from(session_id.to_string());
        self.approvals.cancel_session(&session_id);
        if let Err(error) = self.handle.cancel(session_id) {
            log::warn!("acp host cancel failed: {error}");
        }
    }

    /// 按 `thread_id` 取消当前回合（「取消重键」入口）。
    pub fn cancel_thread(&self, thread_id: &str) {
        let thread_key = thread_id.trim();
        if thread_key.is_empty() {
            log::warn!("acp host cancel_thread: empty thread_id");
            return;
        }
        let session_id = self.sessions.lock().get(thread_key).cloned();
        match session_id {
            Some(session_id) => self.cancel(&session_id.to_string()),
            None => log::warn!("acp host cancel_thread: no session bound for thread {thread_key}"),
        }
    }

    /// 请求优雅关停：清空挂起审批并令常驻连接任务结束（子进程随之回收）。
    pub fn shutdown(&self) {
        self.approvals.clear();
        self.handle.shutdown();
    }
}

/// 修剪并过滤空白可选字符串：`None` / 空 / 全空白 → `None`，否则返回修剪后切片。
fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

/// 新建会话的 cwd：优先用提供的工作区根路径；缺省回退到进程当前目录，再退到 `.`。
fn workspace_cwd(workspace_root_path: Option<&str>) -> PathBuf {
    match non_empty(workspace_root_path) {
        Some(path) => PathBuf::from(path),
        None => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_empty_trims_and_filters_blank() {
        assert_eq!(non_empty(None), None);
        assert_eq!(non_empty(Some("")), None);
        assert_eq!(non_empty(Some("   ")), None);
        assert_eq!(non_empty(Some("  agent ")), Some("agent"));
    }

    #[test]
    fn workspace_cwd_prefers_provided_path() {
        assert_eq!(
            workspace_cwd(Some("/work/space")),
            PathBuf::from("/work/space")
        );
    }

    #[test]
    fn workspace_cwd_falls_back_when_blank() {
        // 空白工作区路径 → 回退到进程当前目录（或最终退到 "."）；至少非空。
        let cwd = workspace_cwd(Some("   "));
        assert!(!cwd.as_os_str().is_empty());
    }
}
