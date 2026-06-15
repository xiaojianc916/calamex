//! 宿主侧 ACP(Agent Client Protocol)stdio 客户端。
//!
//! 这是「先加新模块 → cargo 验证 → 绿了再删旧」迁移路径中新增、可逆、按 cargo
//! feature `acp_client` 门控的模块。默认构建(`default = ["desktop"]`)不会编译它,
//! 因此落地阶段不影响现有 HTTP/NDJSON sidecar。

#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use agent_client_protocol::schema::{
    CancelNotification, ContentBlock, InitializeRequest, NewSessionRequest, PermissionOptionId,
    PromptRequest, ProtocolVersion, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome, SessionId, SessionModeId,
    SessionNotification, SetSessionModeRequest, StopReason,
};
use agent_client_protocol::{
    AcpAgent, Agent, BoxFuture, Client, ConnectionTo, JsonRpcRequest, Responder,
    on_receive_notification, on_receive_request,
};

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpStreamFrame {
    pub session_id: Option<String>,
    pub seq: u64,
    pub event: serde_json::Value,
}

pub type EventSink = Arc<dyn Fn(AcpStreamFrame) + Send + Sync>;

pub enum PermissionDecision {
    Selected(PermissionOptionId),
    Cancelled,
}

pub type PermissionResolver =
    Arc<dyn Fn(RequestPermissionRequest) -> BoxFuture<'static, PermissionDecision> + Send + Sync>;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtModelConfig {
    pub model_id: String,
    pub api_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase")]
#[request(method = "calamex.dev/checkpoint/restore", response = Value)]
pub struct CheckpointRestoreRequest {
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_config: Option<ExtModelConfig>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChatMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase")]
#[request(method = "calamex.dev/model/chat", response = Value)]
pub struct ModelChatExtRequest {
    pub messages: Vec<ModelChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_root_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_config: Option<ExtModelConfig>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase")]
#[request(method = "calamex.dev/web/search", response = Value)]
pub struct WebSearchExtRequest {
    pub query: String,
    pub intent: String,
    pub max_results: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recency: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase")]
#[request(method = "calamex.dev/web/fetch", response = Value)]
pub struct WebFetchExtRequest {
    pub url: String,
    pub reason: String,
    pub max_bytes: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase")]
#[request(method = "calamex.dev/warmup", response = Value)]
pub struct WarmupExtRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_config: Option<ExtModelConfig>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase")]
#[request(method = "calamex.dev/health", response = Value)]
pub struct HealthExtRequest {}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase")]
#[request(method = "calamex.dev/plan/orchestrate", response = Value)]
pub struct OrchestrateExtRequest {
    pub goal: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_config: Option<ExtModelConfig>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase")]
#[request(method = "calamex.dev/plan/orchestrate/resume", response = Value)]
pub struct OrchestrateResumeExtRequest {
    pub run_id: String,
    pub decision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_config: Option<ExtModelConfig>,
}

/// `calamex.dev/agent/chat` 扩展方法的单条消息。
/// 字段镜像 sidecar `agentChatMessageSchema`：role覆盖四类,content 纯文本。
/// role 取值由 sidecar zod 统一校验,宿主侧以字符串原样透传。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatMessage {
    pub role: String,
    pub content: String,
}

/// `calamex.dev/agent/chat` 上下文引用的行范围(1 基正整数)。
/// 字段镜像 sidecar `agentChatContextReferenceSchema.range`。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatContextRange {
    pub start_line: u32,
    pub end_line: u32,
}

/// `calamex.dev/agent/chat` 的上下文引用。
/// 关键设计：path 与 range 是「可空但必填」(zod `.nullable()`,非 `.optional()`),
/// 缺值时序列化为显式 null——不加 skip_serializing_if,否则 sidecar zod 因键缺失而失败。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatContextReference {
    pub id: String,
    pub kind: String,
    pub label: String,
    /// 可空但必填——None 序列化为 null，不省略键。
    pub path: Option<String>,
    /// 可空但必填——None 序列化为 null，不省略键。
    pub range: Option<AgentChatContextRange>,
    pub content_preview: String,
    pub redacted: bool,
}

/// `calamex.dev/agent/chat` 扩展方法的请求(agent 模式对话回合,run-to-gate)。
///
/// messages/context 恒序列化为数组(空则 []);其余可选字段为空时整字段省略,
/// 交由 sidecar 套用回退语义(mode→agent,goal→末条 user 消息 ?? '继续当前任务')。
/// 响应为整封 sidecar 信封(schemaVersion+sessionId+events+result),Value 原样回传。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase")]
#[request(method = "calamex.dev/agent/chat", response = Value)]
pub struct AgentChatExtRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    pub messages: Vec<AgentChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_root_path: Option<String>,
    pub context: Vec<AgentChatContextReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_config: Option<ExtModelConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_step_id: Option<String>,
}

/// `calamex.dev/agent/chat/resolve` 扩展方法的请求(agent 对话审批恢复)。
///
/// = agentChatParamsSchema + requestId + decision。
/// decision 取值(approve/reject/cancel/modify)由 sidecar zod 校验,宿主侧原样透传。
/// 响应同 AgentChatExtRequest:整封 sidecar 信封,Value 原样回传。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase")]
#[request(method = "calamex.dev/agent/chat/resolve", response = Value)]
pub struct AgentChatResolveExtRequest {
    pub request_id: String,
    pub decision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    pub messages: Vec<AgentChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_root_path: Option<String>,
    pub context: Vec<AgentChatContextReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_config: Option<ExtModelConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_step_id: Option<String>,
}

/// `calamex.dev/agent/ask-user/resume` 单题作答。
/// 字段镜像 sidecar `askUserAnswerParamsSchema`：questionId(min 1)、
/// optionIds(string[]，缺省 [])、text(可选)。
/// optionIds 恒序列化为数组(空则 [])；text 为空时整字段省略。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskUserAnswer {
    pub question_id: String,
    pub option_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// `calamex.dev/agent/ask-user/resume` 扩展方法的请求(ask_user 反向提问恢复)。
///
/// = agentChatParamsSchema + requestId + outcome + answers?。
/// 镜像 AgentChatResolveExtRequest 的「base + requestId」结构,但以 outcome + 结构化
/// answers 取代 decision：
///   * outcome 取值(selected/cancelled)由 sidecar zod 校验,宿主侧原样透传;
///   * answers 为每题作答,outcome=cancelled 时整字段省略(对齐 zod `.optional()`)。
/// 响应同 AgentChatResolveExtRequest：整封 sidecar 信封,Value 原样回传。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase")]
#[request(method = "calamex.dev/agent/ask-user/resume", response = Value)]
pub struct AgentAskUserResumeExtRequest {
    pub request_id: String,
    pub outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answers: Option<Vec<AskUserAnswer>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    pub messages: Vec<AgentChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_root_path: Option<String>,
    pub context: Vec<AgentChatContextReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_config: Option<ExtModelConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_step_id: Option<String>,
}

pub struct AcpClientConfig {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

#[derive(Debug, thiserror::Error)]
pub enum AcpClientError {
    #[error("acp transport error: {0}")]
    Transport(String),
    #[error("acp protocol error: {0}")]
    Protocol(String),
    #[error("acp client task is not running")]
    NotRunning,
}

enum Command {
    NewSession {
        cwd: PathBuf,
        reply: oneshot::Sender<Result<SessionId, String>>,
    },
    Prompt {
        session_id: SessionId,
        blocks: Vec<ContentBlock>,
        reply: oneshot::Sender<Result<StopReason, String>>,
    },
    SetSessionMode {
        session_id: SessionId,
        mode_id: SessionModeId,
        reply: oneshot::Sender<Result<(), String>>,
    },
    RestoreCheckpoint {
        request: CheckpointRestoreRequest,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    ModelChat {
        request: ModelChatExtRequest,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    WebSearch {
        request: WebSearchExtRequest,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    WebFetch {
        request: WebFetchExtRequest,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    Warmup {
        request: WarmupExtRequest,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    Health {
        request: HealthExtRequest,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    Orchestrate {
        request: OrchestrateExtRequest,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    OrchestrateResume {
        request: OrchestrateResumeExtRequest,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    AgentChat {
        request: AgentChatExtRequest,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    AgentChatResolve {
        request: AgentChatResolveExtRequest,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    AgentAskUserResume {
        request: AgentAskUserResumeExtRequest,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    Cancel {
        session_id: SessionId,
    },
    Shutdown,
}

#[derive(Clone)]
pub struct AcpClientHandle {
    cmd_tx: mpsc::UnboundedSender<Command>,
}

impl AcpClientHandle {
    pub async fn new_session(&self, cwd: PathBuf) -> Result<SessionId, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::NewSession { cwd, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    pub async fn prompt(
        &self,
        session_id: SessionId,
        blocks: Vec<ContentBlock>,
    ) -> Result<StopReason, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::Prompt { session_id, blocks, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    pub async fn set_session_mode(
        &self,
        session_id: SessionId,
        mode_id: SessionModeId,
    ) -> Result<(), AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::SetSessionMode { session_id, mode_id, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    pub async fn restore_checkpoint(
        &self,
        request: CheckpointRestoreRequest,
    ) -> Result<Value, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::RestoreCheckpoint { request, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    pub async fn model_chat(&self, request: ModelChatExtRequest) -> Result<Value, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::ModelChat { request, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    pub async fn web_search(&self, request: WebSearchExtRequest) -> Result<Value, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::WebSearch { request, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    pub async fn web_fetch(&self, request: WebFetchExtRequest) -> Result<Value, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::WebFetch { request, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    pub async fn warmup(&self, request: WarmupExtRequest) -> Result<Value, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::Warmup { request, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    pub async fn health(&self, request: HealthExtRequest) -> Result<Value, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::Health { request, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    pub async fn orchestrate(
        &self,
        request: OrchestrateExtRequest,
    ) -> Result<Value, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::Orchestrate { request, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    pub async fn orchestrate_resume(
        &self,
        request: OrchestrateResumeExtRequest,
    ) -> Result<Value, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::OrchestrateResume { request, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    /// 发起一轮 agent 模式对话(扩展方法 `calamex.dev/agent/chat`).
    /// run-to-gate:跑到审批门或终态;响应为整封 sidecar 信封(Value),由宿主侧解析。
    pub async fn agent_chat(&self, request: AgentChatExtRequest) -> Result<Value, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::AgentChat { request, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    /// 恢复一轮挂起在审批门的 agent 对话(扩展方法 `calamex.dev/agent/chat/resolve`).
    /// 裁决后续跑同一回合并返回下一段响应信封;响应为整封 sidecar 信封(Value),由宿主侧解析。
    pub async fn agent_chat_resolve(
        &self,
        request: AgentChatResolveExtRequest,
    ) -> Result<Value, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::AgentChatResolve { request, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    /// 恢复一轮挂起在 ask_user 反向提问的 agent 对话(扩展方法 `calamex.dev/agent/ask-user/resume`).
    /// 回灌 outcome + 结构化 answers 后续跑同一回合并返回下一段响应信封;响应为整封 sidecar 信封(Value),由宿主侧解析。
    pub async fn agent_ask_user_resume(
        &self,
        request: AgentAskUserResumeExtRequest,
    ) -> Result<Value, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::AgentAskUserResume { request, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    pub fn cancel(&self, session_id: SessionId) -> Result<(), AcpClientError> {
        self.cmd_tx
            .send(Command::Cancel { session_id })
            .map_err(|_| AcpClientError::NotRunning)
    }

    pub fn shutdown(&self) {
        let _ = self.cmd_tx.send(Command::Shutdown);
    }
}

fn build_agent_args(config: &AcpClientConfig) -> Vec<String> {
    let mut args: Vec<String> = config.env.iter().map(|(k, v)| format!("{k}={v}")).collect();
    args.push(config.program.clone());
    args.extend(config.args.iter().cloned());
    args
}

pub fn spawn_acp_client(
    config: AcpClientConfig,
    sink: EventSink,
    resolver: PermissionResolver,
) -> Result<AcpClientHandle, AcpClientError> {
    let transport = AcpAgent::from_args(build_agent_args(&config))
        .map_err(|e| AcpClientError::Transport(e.to_string()))?;

    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<Command>();
    let seq = Arc::new(AtomicU64::new(0));

    let notif_sink = sink.clone();
    let notif_seq = seq.clone();

    tokio::spawn(async move {
        let result = Client
            .builder()
            .name("calamex")
            .on_receive_notification(
                move |notif: SessionNotification, _cx| {
                    let sink = notif_sink.clone();
                    let seq = notif_seq.clone();
                    async move {
                        let event = serde_json::to_value(&notif).unwrap_or(serde_json::Value::Null);
                        let session_id = event
                            .get("sessionId")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        let n = seq.fetch_add(1, Ordering::SeqCst);
                        sink(AcpStreamFrame { session_id, seq: n, event });
                        Ok::<(), agent_client_protocol::Error>(())
                    }
                },
                on_receive_notification!(),
            )
            .on_receive_request(
                move |req: RequestPermissionRequest,
                      responder: Responder<RequestPermissionResponse>,
                      _cx: ConnectionTo<Agent>| {
                    let resolver = resolver.clone();
                    async move {
                        let outcome = match resolver(req).await {
                            PermissionDecision::Selected(option_id) => {
                                RequestPermissionOutcome::Selected(
                                    SelectedPermissionOutcome::new(option_id),
                                )
                            }
                            PermissionDecision::Cancelled => RequestPermissionOutcome::Cancelled,
                        };
                        responder.respond(RequestPermissionResponse::new(outcome))?;
                        Ok::<(), agent_client_protocol::Error>(())
                    }
                },
                on_receive_request!(),
            )
            .connect_with(transport, async move |cx| {
                cx.send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task()
                    .await?;

                while let Some(command) = cmd_rx.recv().await {
                    match command {
                        Command::NewSession { cwd, reply } => {
                            let res = cx
                                .send_request(NewSessionRequest::new(cwd))
                                .block_task()
                                .await;
                            let _ =
                                reply.send(res.map(|r| r.session_id).map_err(|e| e.to_string()));
                        }
                        Command::Prompt { session_id, blocks, reply } => {
                            let req = PromptRequest::new(session_id, blocks);
                            let res = cx.send_request(req).block_task().await;
                            let _ =
                                reply.send(res.map(|r| r.stop_reason).map_err(|e| e.to_string()));
                        }
                        Command::SetSessionMode { session_id, mode_id, reply } => {
                            let res = cx
                                .send_request(SetSessionModeRequest::new(session_id, mode_id))
                                .block_task()
                                .await;
                            let _ = reply.send(res.map(|_| ()).map_err(|e| e.to_string()));
                        }
                        Command::RestoreCheckpoint { request, reply } => {
                            let res = cx.send_request(request).block_task().await;
                            let _ = reply.send(res.map_err(|e| e.to_string()));
                        }
                        Command::ModelChat { request, reply } => {
                            let res = cx.send_request(request).block_task().await;
                            let _ = reply.send(res.map_err(|e| e.to_string()));
                        }
                        Command::WebSearch { request, reply } => {
                            let res = cx.send_request(request).block_task().await;
                            let _ = reply.send(res.map_err(|e| e.to_string()));
                        }
                        Command::WebFetch { request, reply } => {
                            let res = cx.send_request(request).block_task().await;
                            let _ = reply.send(res.map_err(|e| e.to_string()));
                        }
                        Command::Warmup { request, reply } => {
                            let res = cx.send_request(request).block_task().await;
                            let _ = reply.send(res.map_err(|e| e.to_string()));
                        }
                        Command::Health { request, reply } => {
                            let res = cx.send_request(request).block_task().await;
                            let _ = reply.send(res.map_err(|e| e.to_string()));
                        }
                        Command::Orchestrate { request, reply } => {
                            let res = cx.send_request(request).block_task().await;
                            let _ = reply.send(res.map_err(|e| e.to_string()));
                        }
                        Command::OrchestrateResume { request, reply } => {
                            let res = cx.send_request(request).block_task().await;
                            let _ = reply.send(res.map_err(|e| e.to_string()));
                        }
                        Command::AgentChat { request, reply } => {
                            let res = cx.send_request(request).block_task().await;
                            let _ = reply.send(res.map_err(|e| e.to_string()));
                        }
                        Command::AgentChatResolve { request, reply } => {
                            let res = cx.send_request(request).block_task().await;
                            let _ = reply.send(res.map_err(|e| e.to_string()));
                        }
                        Command::AgentAskUserResume { request, reply } => {
                            let res = cx.send_request(request).block_task().await;
                            let _ = reply.send(res.map_err(|e| e.to_string()));
                        }
                        Command::Cancel { session_id } => {
                            if let Err(error) =
                                cx.send_notification(CancelNotification::new(session_id))
                            {
                                log::warn!("acp cancel notification failed: {error}");
                            }
                        }
                        Command::Shutdown => break,
                    }
                }

                Ok::<(), agent_client_protocol::Error>(())
            })
            .await;

        if let Err(error) = result {
            log::warn!("acp client connection ended with error: {error}");
        }
    });

    Ok(AcpClientHandle { cmd_tx })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- 履历测试 ----

    #[test]
    fn checkpoint_restore_request_serializes_to_camel_case_params() {
        let request = CheckpointRestoreRequest {
            run_id: "run_1".to_string(),
            snapshot_id: Some("snap_1".to_string()),
            step: Some(vec!["step_1".to_string()]),
            session_id: Some("sess_1".to_string()),
            model_config: None,
        };
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["runId"], "run_1");
        assert_eq!(value["snapshotId"], "snap_1");
        assert_eq!(value["step"][0], "step_1");
        assert_eq!(value["sessionId"], "sess_1");
        assert!(value.get("modelConfig").is_none());
    }

    #[test]
    fn model_chat_ext_request_serializes_to_camel_case_params() {
        let request = ModelChatExtRequest {
            messages: vec![ModelChatMessage {
                role: "user".to_string(),
                content: "hello".to_string(),
                tool_call_id: None,
                name: None,
            }],
            goal: Some("test".to_string()),
            session_id: None,
            workspace_root_path: None,
            model_config: None,
        };
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["messages"][0]["role"], "user");
        assert_eq!(value["messages"][0]["content"], "hello");
        assert!(value["messages"][0].get("toolCallId").is_none());
        assert_eq!(value["goal"], "test");
    }

    #[test]
    fn web_search_ext_request_serializes_to_camel_case_params() {
        let request = WebSearchExtRequest {
            query: "rust async".to_string(),
            intent: "research".to_string(),
            max_results: 5,
            recency: None,
        };
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["query"], "rust async");
        assert_eq!(value["intent"], "research");
        assert_eq!(value["maxResults"], 5);
        assert!(value.get("recency").is_none());
    }

    #[test]
    fn orchestrate_ext_request_serializes_to_camel_case_params() {
        let request = OrchestrateExtRequest {
            goal: "build feature".to_string(),
            thread_id: Some("t1".to_string()),
            execution_mode: None,
            session_id: Some("s1".to_string()),
            model_config: None,
        };
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["goal"], "build feature");
        assert_eq!(value["threadId"], "t1");
        assert_eq!(value["sessionId"], "s1");
        assert!(value.get("executionMode").is_none());
    }

    // ---- AgentChat 新增测试 ----

    #[test]
    fn agent_chat_request_serializes_to_camel_case_params() {
        let request = AgentChatExtRequest {
            session_id: Some("sess_1".to_string()),
            mode: Some("agent".to_string()),
            goal: Some("实现登录页".to_string()),
            messages: vec![AgentChatMessage {
                role: "user".to_string(),
                content: "帮我实现登录页".to_string(),
            }],
            workspace_root_path: Some("/repo".to_string()),
            context: vec![AgentChatContextReference {
                id: "ref_1".to_string(),
                kind: "file".to_string(),
                label: "login.vue".to_string(),
                path: Some("src/login.vue".to_string()),
                range: Some(AgentChatContextRange { start_line: 1, end_line: 20 }),
                content_preview: "<template>".to_string(),
                redacted: false,
            }],
            model_config: None,
            thread_id: Some("thread_1".to_string()),
            plan_id: None,
            plan_version: Some(3),
            plan_step_id: None,
        };
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["sessionId"], "sess_1");
        assert_eq!(value["mode"], "agent");
        assert_eq!(value["goal"], "实现登录页");
        assert_eq!(value["messages"][0]["role"], "user");
        assert_eq!(value["messages"][0]["content"], "帮我实现登录页");
        assert_eq!(value["workspaceRootPath"], "/repo");
        assert_eq!(value["context"][0]["id"], "ref_1");
        assert_eq!(value["context"][0]["path"], "src/login.vue");
        assert_eq!(value["context"][0]["range"]["startLine"], 1);
        assert_eq!(value["context"][0]["range"]["endLine"], 20);
        assert_eq!(value["context"][0]["contentPreview"], "<template>");
        assert_eq!(value["context"][0]["redacted"], false);
        assert_eq!(value["threadId"], "thread_1");
        assert_eq!(value["planVersion"], 3);
        assert!(value.get("modelConfig").is_none());
        assert!(value.get("planId").is_none());
        assert!(value.get("planStepId").is_none());
    }

    #[test]
    fn agent_chat_request_emits_empty_arrays_and_nullable_context_fields() {
        // 核心目的:验证 path/range 的「可空但必填」语义——None 序列化为显式 null,不省略键。
        let request = AgentChatExtRequest {
            session_id: None,
            mode: None,
            goal: None,
            messages: vec![],
            workspace_root_path: None,
            context: vec![AgentChatContextReference {
                id: "ref_1".to_string(),
                kind: "selection".to_string(),
                label: "选区".to_string(),
                path: None,
                range: None,
                content_preview: String::new(),
                redacted: true,
            }],
            model_config: None,
            thread_id: None,
            plan_id: None,
            plan_version: None,
            plan_step_id: None,
        };
        let value = serde_json::to_value(&request).unwrap();
        // messages 恒为数组,空则 []
        assert_eq!(value["messages"], serde_json::json!([]));
        // path/range 是「可空但必填」——键必须存在且值为 null
        assert!(value["context"][0]["path"].is_null());
        assert!(value["context"][0]["range"].is_null());
        assert_eq!(value["context"][0]["redacted"], true);
        // 可选字段为空时整字段省略
        assert!(value.get("sessionId").is_none());
        assert!(value.get("mode").is_none());
        assert!(value.get("goal").is_none());
        assert!(value.get("workspaceRootPath").is_none());
        assert!(value.get("threadId").is_none());
        assert!(value.get("planVersion").is_none());
    }

    #[test]
    fn agent_chat_resolve_request_serializes_to_camel_case_params() {
        let request = AgentChatResolveExtRequest {
            request_id: "appr_1".to_string(),
            decision: "approve".to_string(),
            session_id: Some("sess_1".to_string()),
            mode: Some("agent".to_string()),
            goal: None,
            messages: vec![],
            workspace_root_path: None,
            context: vec![],
            model_config: None,
            thread_id: None,
            plan_id: None,
            plan_version: None,
            plan_step_id: None,
        };
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["requestId"], "appr_1");
        assert_eq!(value["decision"], "approve");
        assert_eq!(value["sessionId"], "sess_1");
        assert_eq!(value["mode"], "agent");
        assert_eq!(value["messages"], serde_json::json!([]));
        assert_eq!(value["context"], serde_json::json!([]));
        assert!(value.get("goal").is_none());
        assert!(value.get("planVersion").is_none());
    }

    // ---- AgentAskUserResume 新增测试 ----

    #[test]
    fn agent_ask_user_resume_request_serializes_to_camel_case_params() {
        let request = AgentAskUserResumeExtRequest {
            request_id: "ask_1".to_string(),
            outcome: "selected".to_string(),
            answers: Some(vec![AskUserAnswer {
                question_id: "q1".to_string(),
                option_ids: vec!["opt_a".to_string()],
                text: Some("自定义答案".to_string()),
            }]),
            session_id: Some("sess_1".to_string()),
            mode: Some("agent".to_string()),
            goal: None,
            messages: vec![],
            workspace_root_path: None,
            context: vec![],
            model_config: None,
            thread_id: None,
            plan_id: None,
            plan_version: None,
            plan_step_id: None,
        };
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["requestId"], "ask_1");
        assert_eq!(value["outcome"], "selected");
        assert_eq!(value["answers"][0]["questionId"], "q1");
        assert_eq!(value["answers"][0]["optionIds"][0], "opt_a");
        assert_eq!(value["answers"][0]["text"], "自定义答案");
        assert_eq!(value["sessionId"], "sess_1");
        assert_eq!(value["mode"], "agent");
        assert_eq!(value["messages"], serde_json::json!([]));
        assert_eq!(value["context"], serde_json::json!([]));
        assert!(value.get("goal").is_none());
        assert!(value.get("planVersion").is_none());
    }

    #[test]
    fn agent_ask_user_resume_request_omits_answers_when_cancelled() {
        let request = AgentAskUserResumeExtRequest {
            request_id: "ask_1".to_string(),
            outcome: "cancelled".to_string(),
            answers: None,
            session_id: None,
            mode: None,
            goal: None,
            messages: vec![],
            workspace_root_path: None,
            context: vec![],
            model_config: None,
            thread_id: None,
            plan_id: None,
            plan_version: None,
            plan_step_id: None,
        };
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["outcome"], "cancelled");
        assert!(value.get("answers").is_none());
        assert_eq!(value["messages"], serde_json::json!([]));
        assert_eq!(value["context"], serde_json::json!([]));
    }

    #[test]
    fn ask_user_answer_serializes_option_ids_as_array_and_omits_empty_text() {
        let answer = AskUserAnswer {
            question_id: "q1".to_string(),
            option_ids: vec![],
            text: None,
        };
        let value = serde_json::to_value(&answer).unwrap();
        assert_eq!(value["questionId"], "q1");
        // optionIds 恒为数组,空则 []
        assert_eq!(value["optionIds"], serde_json::json!([]));
        assert!(value.get("text").is_none());
    }
}
