//! 宿主侧 ACP 编排核心（Layer 4）。
//!
//! 这是「先加新模块 → cargo 验证 → 绿了再删旧」迁移路径中按 cargo feature
//! `acp_client` 门控的新增模块，落地阶段不影响现有 HTTP/NDJSON sidecar。
//!
//! 把同目录三层装配成单一编排面，对齐 sidecar 自身的 ACP Agent（见
//! `agent-sidecar/src/acp/agent.ts`）与 Zed `agent_ui/acp_thread.rs` 的回合模型，
//! 不自创协议语义：
//!   * `client`   —— 常驻 stdio 连接 + 命令句柄（new_session / prompt /
//!     set_session_mode / restore_checkpoint / model_chat / web_search / web_fetch /
//!     warmup / health / orchestrate / orchestrate_resume / cancel / shutdown）；
//!   * `approval` —— 回合内反向 `session/request_permission` 的挂起登记表；
//!   * `turn`     —— 把一回合的 `session/update` 通知重建为既有响应信封。
//!
//! 设计要点（均据一手源码核对，不臆造）：
//!   * **会话即线程**：对齐 Zed `session_id = thread.id()`——前端传稳定 `thread_id`，
//!     宿主持有 `thread_id ↔ SessionId` 映射并跨回合复用同一 ACP 会话
//!     （`ensure_session`）。该映射同时为「取消重键」提供回合中途即可用的稳定
//!     `SessionId` 查找（`cancel_thread`），不再依赖前端回传 sessionId。ACP
//!     `SessionId` 仍由 sidecar `newSession` 生成（见 agent.ts `newSession` /
//!     `prompt`）；`chat` 仍接受显式 `session_id` 透传，接线层先 `ensure_session`
//!     拿到稳定会话再投影回合入参。
//!   * **模型配置不入 prompt**：模型凭据由 sidecar 进程环境变量在启动期解析
//!     （见 agent.ts 头注与 models/config.ts、warmup-into-startup），故 `chat` 不在
//!     回合内注入模型配置——不另立 ACP 之外的注入通道。
//!   * **审批即回合内挂起**：危险工具经反向 `session/request_permission` 在回合内
//!     挂起，`prompt` 的 future 自然延后；`resolve_approval` 经登记表唤醒同一回合
//!     续跑，最终由原 `chat` 调用返回完整响应（Zed 做法）。审批以 ACP 原生
//!     `(SessionId, ToolCallId)` 定位——这正是宿主经 `ApprovalRequestInfo` 抹给
//!     webview 的标识，无需解码任何旁路令牌。
//!   * **流式即累积**：单一 `EventSink` 既把每条帧转发给 webview（`ai:sidecar-stream`
//!     契约），又按 `sessionId` 写入当前回合累积器；回合结束后落为响应信封。
//!   * **编排即带外**：`orchestrate` / `orchestrate_resume` 是标准会话回合（`prompt`）
//!     之外的「带外」编排能力，经 sidecar 公示的扩展方法通道下发（标准客户端不识别
//!     会安全忽略）。二者均先 `ensure_session(thread_id)` 拿到稳定 `SessionId` 并随
//!     请求透传，使内部工作流事件经该会话的 `session/update` 流式下发（与 chat 同一
//!     下沉路径，见 agent.ts `handleOrchestrate`）；但编排帧不做回合累积——不调用
//!     `begin_turn`/`end_turn`，`record_frame` 对无活动回合的会话安全忽略，帧仍转发
//!     webview。同 chat，编排不在回合内注入模型配置（sidecar 启动期解析）。

// 过渡期：本模块尚未接线到宿主命令（公开 API 暂无调用点）。接线后移除该 allow。
#![allow(dead_code)]

use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::{SessionId, SessionModeId, ToolCallId};

use crate::commands::contracts::{
    AgentSidecarHealthPayload, AgentSidecarOrchestratePayload, AgentSidecarResponsePayload,
    AgentSidecarWarmupPayload, AiContextReferencePayload, AiWebFetchPayload, AiWebSearchPayload,
};

use super::approval::{ApprovalError, ApprovalRegistry, ApprovalRequestInfo};
use super::client::{
    AcpClientConfig, AcpClientError, AcpClientHandle, AcpStreamFrame, CheckpointRestoreRequest,
    EventSink, HealthExtRequest, ModelChatExtRequest, OrchestrateExtRequest,
    OrchestrateResumeExtRequest, WarmupExtRequest, WebFetchExtRequest, WebSearchExtRequest,
    spawn_acp_client,
};
use super::turn::TurnAccumulator;

/// 流式帧下沉口：把每条 `session/update` 帧转发给 webview（对齐 `ai:sidecar-stream`
/// 的 `{sessionId, seq, event}` 契约）。由宿主接线层提供 emit 闭包。
pub type StreamEmitter = Arc<dyn Fn(AcpStreamFrame) + Send + Sync>;

/// 待决审批下沉口：把回合内挂起的权限请求详情推给 webview 渲染审批 UI。
/// 由宿主接线层提供 emit 闭包；其回传决策经 `resolve_approval` 唤醒回合。
pub type ApprovalEmitter = Arc<dyn Fn(ApprovalRequestInfo) + Send + Sync>;

/// 一次 `chat` 回合的宿主侧入参（已从 Tauri 契约/凭据类型解耦的最小面）。
///
/// 接线层负责把 `AgentSidecarChatRequest` 投影到此：`prompt` 取自其 messages 的
/// 文本归并，`session_id`/`mode`/`workspace_root_path` 原样透传；`model_config`
/// 不在此出现——模型配置在 sidecar 启动期由环境变量解析，不入 ACP prompt 回合。
#[derive(Debug, Clone, Default)]
pub struct AcpChatTurn {
    /// 复用既有会话的 ACP `SessionId`（前端从上一回合响应回传）；缺省则新建会话。
    pub session_id: Option<String>,
    /// 会话运行模式（ask/plan/agent/patch/review）；仅在显式提供且非空时切换。
    pub mode: Option<String>,
    /// 本回合新输入文本（历史由 sidecar 按 sessionId 自持，不在此重放）。
    pub prompt: String,
    /// 新建会话时作为 cwd（→ sidecar workspaceRootPath）；复用会话时忽略。
    pub workspace_root_path: Option<String>,
    /// 本回合随附的上下文引用（@文件 / 选区 / 符号等），由接线层从
    /// `AgentSidecarChatRequest.context` 投影而来；经 `bridge` 进一步投影为 ACP
    /// `resource` / `resource_link` 内容块附加到 prompt。空切片表示无附加上下文，
    /// 此时仅投影用户文本块（与既有行为等价）。
    pub context: Vec<AiContextReferencePayload>,
}

/// 一次 `orchestrate` 编排启动的宿主侧入参。
///
/// 接线层负责把 `AgentSidecarOrchestrateRequest` 投影到此：`goal` 原样透传，
/// `thread_id` 用于 `ensure_session` 拿到稳定会话并随请求透传，`execution_mode`
/// 以字符串原样透传（合法取值由 sidecar zod 校验；为空时整字段省略交由 sidecar
/// 套默认），`workspace_root_path` 仅在新建会话时作为 cwd。`model_config` 不在此
/// 出现——同 chat，模型配置在 sidecar 启动期由环境变量解析，不入编排请求。
#[derive(Debug, Clone, Default)]
pub struct AcpOrchestrateStart {
    /// 编排目标（自然语言），原样透传给 sidecar。
    pub goal: String,
    /// 稳定线程标识：用于 `ensure_session` 复用/新建会话，并随请求透传以便内部
    /// 工作流事件经该会话的 `session/update` 流式下发。为空白时退化为「新建、不登记」。
    pub thread_id: Option<String>,
    /// 每次运行的执行偏好（interactive/autonomous）；合法取值由 sidecar zod 统一校验，
    /// 宿主以字符串原样透传、不在此重复取值表，为空白时整字段省略交由 sidecar 套默认。
    pub execution_mode: Option<String>,
    /// 新建会话时作为 cwd（→ sidecar workspaceRootPath）；复用会话时忽略。
    pub workspace_root_path: Option<String>,
}

/// 一次 `orchestrate_resume` 编排续跑的宿主侧入参。
///
/// 接线层负责把 `AgentSidecarOrchestrateResumeRequest` 投影到此：`run_id` 定位被
/// 审批门挂起的编排运行，`decision`（approve/reject/continue/cancel）与可选 `reason`
/// 以字符串原样透传（合法取值由 sidecar zod 校验）。`thread_id` 用于 `ensure_session`
/// 复用同一会话，使续跑阶段的工作流事件仍经该会话的 `session/update` 流式下发。
/// `model_config` 同 chat 不在此出现。
#[derive(Debug, Clone, Default)]
pub struct AcpOrchestrateResume {
    /// 被挂起编排运行的标识，原样透传给 sidecar 以定位续跑目标。
    pub run_id: String,
    /// 审批决策（approve/reject/continue/cancel）；合法取值由 sidecar zod 校验，原样透传。
    pub decision: String,
    /// 可选的决策理由；为空白时整字段省略。
    pub reason: Option<String>,
    /// 稳定线程标识：用于 `ensure_session` 复用同一会话并随请求透传，使续跑阶段的
    /// 工作流事件仍经该会话的 `session/update` 流式下发。为空白时退化为「新建、不登记」。
    pub thread_id: Option<String>,
}

/// 宿主侧 ACP 编排句柄。可作为 Tauri 托管状态长驻：内部协作件均为
/// 可克隆/共享句柄，整体 `Send + Sync`。
pub struct AcpHost {
    handle: AcpClientHandle,
    approvals: ApprovalRegistry,
    /// 按 ACP `SessionId` 字符串键入的「当前回合」累积器。`EventSink` 据帧的
    /// `sessionId` 写入；`chat` 在 prompt 前 `begin_turn`、返回后 `end_turn`。
    turns: Arc<Mutex<HashMap<String, TurnAccumulator>>>,
    /// `thread_id ↔ ACP SessionId` 映射（对齐 Zed `session_id = thread.id()`）。
    /// 前端传稳定 `thread_id`，宿主据此跨回合复用同一 ACP 会话（`ensure_session`），
    /// 并为「取消重键」提供回合中途可用的稳定 `SessionId` 查找（`cancel_thread`）。
    sessions: Arc<Mutex<HashMap<String, SessionId>>>,
}

impl AcpHost {
    /// 启动常驻 ACP 连接并装配编排面。
    ///
    /// `emit` 接收每条流式帧（转发 webview）；`on_approval` 接收回合内挂起的权限
    /// 请求详情（弹出审批 UI）。二者均由宿主接线层提供，与 Tauri 事件解耦以便单测。
    pub fn spawn(
        config: AcpClientConfig,
        emit: StreamEmitter,
        on_approval: ApprovalEmitter,
    ) -> Result<Self, AcpClientError> {
        let approvals = ApprovalRegistry::new();
        let resolver = approvals.resolver(on_approval);
        let turns: Arc<Mutex<HashMap<String, TurnAccumulator>>> =
            Arc::new(Mutex::new(HashMap::new()));

        // 单一下沉口：先按 sessionId 写入当前回合累积器，再转发给 webview。
        let sink: EventSink = {
            let turns = turns.clone();
            Arc::new(move |frame: AcpStreamFrame| {
                record_frame(&turns, &frame);
                emit(frame);
            })
        };

        let handle = spawn_acp_client(config, sink, resolver)?;
        Ok(Self {
            handle,
            approvals,
            turns,
            sessions: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// 解析某 thread 对应的 ACP 会话（`thread_id ↔ SessionId`，贴 Zed 做法）：
    /// 命中映射则跨回合复用既有 `SessionId`；否则按工作区根新建会话并登记。
    ///
    /// 这是「取消重键」的基石——回合开始前 `thread_id` 即已绑定稳定 `SessionId`，
    /// 故 `cancel_thread` 可在回合中途定位会话下发 `session/cancel`。`thread_id`
    /// 为空白时退化为「每次新建、不登记」（与无身份回合等价）。
    ///
    /// 锁不跨 `await` 持有：命中分支在表达式内即释放锁；未命中时先释放锁再
    /// `new_session().await`，回来后再短暂持锁登记。
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

    /// 运行一次 `chat` 回合：复用/新建会话 → 可选切换模式 → prompt（阻塞至回合结束，
    /// 含回合内审批挂起→唤醒续跑）→ 把累积的 `session/update` 落为响应信封。
    ///
    /// 流式增量在 prompt 期间已经 `EventSink` 实时下发；本调用的返回值是该回合的
    /// 完整重建信封（`{ sessionId, events, result }`），与既有命令契约同形。
    pub async fn chat(
        &self,
        turn: AcpChatTurn,
    ) -> Result<AgentSidecarResponsePayload, AcpClientError> {
        let session_id = match non_empty(turn.session_id.as_deref()) {
            Some(existing) => SessionId::from(existing.to_string()),
            None => {
                let cwd = workspace_cwd(turn.workspace_root_path.as_deref());
                self.handle.new_session(cwd).await?
            }
        };
        let session_key = session_id.to_string();

        // 仅在显式提供且非空时切换模式；sidecar 负责校验非法模式（见 agent.ts）。
        if let Some(mode) = non_empty(turn.mode.as_deref()) {
            self.handle
                .set_session_mode(session_id.clone(), SessionModeId::new(mode.to_string()))
                .await?;
        }

        self.begin_turn(&session_key);
        // 把本回合用户输入投影为 ACP prompt 内容块（经接线层 `bridge` 统一构造，
        // 与 client 层「只下发、不臆造内容块形态」的分层一致）：用户文本块 +
        // 本回合随附的上下文引用（@文件 / 选区 / 符号等）一并投影。
        let blocks = super::bridge::user_turn_to_content_blocks(&turn.prompt, &turn.context);
        let prompt_result = self.handle.prompt(session_id, blocks).await;
        let accumulator = self.end_turn(&session_key);

        // 无论回合成败都已回收累积器，避免泄漏；失败时错误上抛由宿主映射。
        prompt_result?;
        Ok(accumulator.into_response(session_key))
    }

    /// 投递一个审批决策，唤醒回合内挂起的权限请求（其 `prompt` 随后续跑并最终返回）。
    ///
    /// `session_id` / `tool_call_id` 即宿主经 `ApprovalRequestInfo` 抹给 webview 的
    /// ACP 原生标识；`decision` 取上层线值（`allow-once` / `reject-once` / `approve`
    /// / `reject` / `cancel` 等），映射规则见 `approval` 模块。
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

    /// 触发检查点回滚（扩展方法 `calamex.dev/checkpoint/restore`）。
    ///
    /// sidecar 把回滚响应投影为与 chat 同构的信封（`schemaVersion + sessionId +
    /// events + result`，见 ext-methods.ts `toCheckpointRestoreExtResult`），故此处
    /// 直接复用既有 `AgentSidecarResponsePayload` 解析（多余的 `schemaVersion` 字段
    /// 按 serde 默认忽略）。
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
    ///
    /// 标准会话回合之外的「带外」工具型模型调用，经 sidecar 公示的扩展方法通道下发；
    /// 承载标题生成 / 行内补全 / 连接测试等一次性请求（仿 Zed 把这类 model-backed 功能
    /// 与 Agent Panel 智能体回合分离为独立模型请求）。sidecar 把响应投影为与 chat 同构的
    /// 信封（`toModelChatExtResult = toAgentSidecarResponse`，schemaVersion + sessionId +
    /// events + result），故此处直接复用既有 `AgentSidecarResponsePayload` 解析（同
    /// restore_checkpoint，多余的 `schemaVersion` 字段按 serde 默认忽略）。
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
    ///
    /// 与检查点回滚同属标准会话回合之外的「带外」能力，经 sidecar 公示的扩展方法
    /// 通道下发；标准客户端不识别该方法会安全忽略。入参为客户端层扩展请求类型
    /// （与 contract 的转换由接线层负责，同 restore_checkpoint）；sidecar 按
    /// `aiWebSearchPayloadSchema` 回传，此处解析为既有 `AiWebSearchPayload` 契约，与原
    /// HTTP `web_search` 的返回同形（前端无感）。
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
    ///
    /// 经 sidecar 公示的扩展方法通道下发。入参为客户端层扩展请求类型；sidecar 按
    /// `aiWebFetchPayloadSchema` 回传，此处解析为既有 `AiWebFetchPayload` 契约，与原
    /// HTTP `web_fetch` 的返回同形。
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
    ///
    /// 经 sidecar 公示的扩展方法通道下发；`request` 可携带可选 `modelConfig`，缺省时
    /// sidecar 退回到启动期由环境变量解析的默认模型配置。sidecar 按 `toWarmupExtResult`
    /// 回传，此处解析为既有 `AgentSidecarWarmupPayload` 契约，与原 HTTP `warmup` 的返回同形。
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
    ///
    /// 该方法无入参（线形序列化为 `{}`），故宿主侧内部构造空请求。sidecar 按
    /// `buildHealthExtResult` 回传，此处解析为既有 `AgentSidecarHealthPayload` 契约，与原
    /// HTTP `health` 的返回同形。
    pub async fn health(&self) -> Result<AgentSidecarHealthPayload, AcpClientError> {
        let value = self.handle.health(HealthExtRequest {}).await?;
        serde_json::from_value(value).map_err(|error| {
            AcpClientError::Protocol(format!("invalid health response payload: {error}"))
        })
    }

    /// 启动一次原生计划编排（扩展方法 `calamex.dev/plan/orchestrate`）。
    ///
    /// 标准会话回合（`prompt`）之外的「带外」编排能力，经 sidecar 公示的扩展方法通道
    /// 下发。先 `ensure_session(thread_id)` 拿到稳定 `SessionId` 并随请求透传，使内部
    /// 工作流事件经该会话的 `session/update` 流式下发（与 chat 同一 `EventSink` 下沉
    /// 路径，见 agent.ts `handleOrchestrate`）；但编排不在此累积回合（无
    /// `begin_turn`/`end_turn`），帧仅经 `EventSink` 转发 webview，`record_frame` 对
    /// 无活动回合的会话安全忽略。`execution_mode` 以字符串原样透传（合法取值由 sidecar
    /// zod 校验），为空白时整字段省略交由 sidecar 套默认；`model_config` 同 chat 不注入
    /// （sidecar 启动期解析）。sidecar 回传编排终帧 `{ runId, status, result }`，此处
    /// 解析为既有 `AgentSidecarOrchestratePayload` 契约（多余的 `status` 字段按 serde
    /// 默认忽略），与原 HTTP `orchestrate` 的返回同形（前端无感）。
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
    ///
    /// 经 sidecar 公示的扩展方法通道下发；先 `ensure_session(thread_id)` 复用同一会话
    /// 并随请求透传，使续跑阶段的工作流事件仍经该会话的 `session/update` 流式下发（见
    /// agent.ts `handleOrchestrateResume`）；同 `orchestrate` 不累积回合。`decision`/
    /// `reason` 以字符串原样透传（合法取值由 sidecar zod 校验）；`model_config` 同 chat
    /// 不注入。响应同 `orchestrate`：编排终帧 `{ runId, status, result }` 解析为既有
    /// `AgentSidecarOrchestratePayload` 契约。
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

    /// 取消指定会话的当前回合：先清除其全部挂起审批（令任何挂起 `prompt` 收到
    /// 取消），再下发 ACP `session/cancel` 通知。
    pub fn cancel(&self, session_id: &str) {
        let session_id = SessionId::from(session_id.to_string());
        self.approvals.cancel_session(&session_id);
        if let Err(error) = self.handle.cancel(session_id) {
            log::warn!("acp host cancel failed: {error}");
        }
    }

    /// 按 `thread_id` 取消当前回合（「取消重键」入口）：解析其绑定的 ACP
    /// `SessionId` 后复用 `cancel`。该 thread 尚未绑定会话（从未发起过回合）或
    /// `thread_id` 为空白时安全空操作，仅记一条 warn。
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

    /// 为某会话开启一个新的回合累积器（覆盖同会话遗留的累积器，安全侧）。
    fn begin_turn(&self, session_key: &str) {
        self.turns
            .lock()
            .insert(session_key.to_string(), TurnAccumulator::new());
    }

    /// 取出并移除某会话的回合累积器；若期间未收到任何帧则返回空累积器。
    fn end_turn(&self, session_key: &str) -> TurnAccumulator {
        self.turns.lock().remove(session_key).unwrap_or_default()
    }
}

/// 把一条流式帧按 `sessionId` 写入当前回合累积器。无 `sessionId`、或该会话当前
/// 无活动回合时安全忽略（仍会经 `EventSink` 转发给 webview）。
fn record_frame(turns: &Mutex<HashMap<String, TurnAccumulator>>, frame: &AcpStreamFrame) {
    let Some(session_id) = frame.session_id.as_deref() else {
        return;
    };
    // let-chain（edition 2024）：仅在拿到锁且该会话有活动回合累积器时记录。
    let mut map = turns.lock();
    if let Some(accumulator) = map.get_mut(session_id) {
        accumulator.record(frame.event.clone());
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
    use serde_json::json;

    /// 构造一条 agent_message_chunk 通知帧，线形对齐 turn.rs 的既有 wire 形状
    /// （`{ sessionId, update: { sessionUpdate, content } }`）。
    fn message_frame(session_id: &str, text: &str) -> AcpStreamFrame {
        AcpStreamFrame {
            session_id: Some(session_id.to_string()),
            seq: 0,
            event: json!({
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": text }
                }
            }),
        }
    }

    fn new_turns() -> Arc<Mutex<HashMap<String, TurnAccumulator>>> {
        Arc::new(Mutex::new(HashMap::new()))
    }

    #[test]
    fn record_frame_accumulates_into_active_turn_by_session() {
        let turns = new_turns();
        turns
            .lock()
            .insert("s1".to_string(), TurnAccumulator::new());

        record_frame(&turns, &message_frame("s1", "你好"));
        record_frame(&turns, &message_frame("s1", "，世界"));

        let accumulator = turns.lock().remove("s1").unwrap();
        let response = accumulator.into_response("s1".to_string());
        assert_eq!(response.session_id, "s1");
        assert_eq!(response.result.as_deref(), Some("你好，世界"));
        assert_eq!(response.events.len(), 2);
    }

    #[test]
    fn record_frame_ignores_frames_for_sessions_without_active_turn() {
        let turns = new_turns();
        turns
            .lock()
            .insert("s1".to_string(), TurnAccumulator::new());

        // 另一个会话当前无活动回合：安全忽略，不创建条目、不 panic。
        record_frame(&turns, &message_frame("other", "丢弃"));
        record_frame(&turns, &message_frame("s1", "保留"));

        let map = turns.lock();
        assert!(!map.contains_key("other"));
        assert_eq!(map.get("s1").map(TurnAccumulator::len), Some(1));
    }

    #[test]
    fn record_frame_ignores_frames_without_session_id() {
        let turns = new_turns();
        turns
            .lock()
            .insert("s1".to_string(), TurnAccumulator::new());

        let frame = AcpStreamFrame {
            session_id: None,
            seq: 0,
            event: json!({ "update": { "sessionUpdate": "agent_message_chunk" } }),
        };
        record_frame(&turns, &frame);

        assert_eq!(
            turns.lock().get("s1").map(TurnAccumulator::is_empty),
            Some(true)
        );
    }

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
