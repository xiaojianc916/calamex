//! 宿主侧 ACP(Agent Client Protocol)stdio 客户端。
//!
//! 这是「先加新模块 → cargo 验证 → 绿了再删旧」迁移路径中新增、可逆、按 cargo
//! feature `acp_client` 门控的模块。该模块已随默认特性（含 `acp_client`）参与编译，
//! 旧 HTTP/NDJSON sidecar 已随迁移完成而移除，本模块为当前唯一路径。

#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::commands::contracts::SecretString;
use crate::acp::bridges::AcpBridges;
use agent_client_protocol::schema::{
    ReadTextFileRequest, ReadTextFileResponse, WriteTextFileRequest, WriteTextFileResponse,
};

use agent_client_protocol::schema::{
	ClientCapabilities, FileSystemCapabilities, Implementation,
    CancelNotification, ContentBlock, InitializeRequest, NewSessionRequest, PermissionOptionId,
    PromptRequest, ProtocolVersion, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome, SessionConfigId,
    SessionConfigOptionValue, SessionConfigValueId, SessionId, SessionNotification,
    SetSessionConfigOptionRequest, StopReason,
};
use agent_client_protocol::{
    ByteStreams, Agent, BoxFuture, Client, ConnectionTo, JsonRpcRequest, Responder,
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
    pub api_key: SecretString,
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

/// `new_session` 的结果：会话标识 + 可选的可用配置项清单。
pub struct NewSessionOutcome {
    pub session_id: SessionId,
    /// ACP `NewSessionResponse.config_options`（`SessionConfigOption[]`：每项含
    /// `id`/`name`/`kind`/`currentValue` 等）的原样 JSON——最小透传，宿主侧不重建 SDK
    /// 类型，交前端 ACL 解释。这是「模型/思考强度/模式等」可切换配置项的目录来源,对任意
    /// 公示 configOptions 的 agent 通用；默认选中项即 agent 在 currentValue 中回填的当前
    /// 模型。`None` 表示 agent 未公示会话级配置项。
    pub config_options: Option<Value>,
}

enum Command {
    NewSession {
        cwd: PathBuf,
        /// 仅 builtin 后端注入的 session/new _meta（模型目录 + 凭据 + 当前选中项，由命令层
        /// 组装）；外部 agent 为 None。经官方 builder 注入 NewSessionRequest（Meta =
        /// serde_json::Map<String, Value>，序列化为线上键 _meta）。
        meta: Option<serde_json::Map<String, Value>>,
        reply: oneshot::Sender<Result<NewSessionOutcome, String>>,
    },
    Prompt {
        session_id: SessionId,
        blocks: Vec<ContentBlock>,
        reply: oneshot::Sender<Result<StopReason, String>>,
    },
    SetSessionConfigOption {
        session_id: SessionId,
        config_id: SessionConfigId,
        value: SessionConfigOptionValue,
        reply: oneshot::Sender<Result<Option<Value>, String>>,
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
    Shutdown,
}

#[derive(Clone)]
pub struct AcpClientHandle {
    cmd_tx: mpsc::UnboundedSender<Command>,
    /// 带外取消通道:连接就绪后存入 `cx.clone()`,让 `cancel()` 绕过串行命令队列,
    /// 即便 Prompt 把命令循环 .await 阻塞,也能直接发 `session/cancel`。
    cancel_cx: Arc<Mutex<Option<ConnectionTo<Agent>>>>,
}

impl AcpClientHandle {
    pub async fn new_session(
        &self,
        cwd: PathBuf,
        meta: Option<serde_json::Map<String, Value>>,
    ) -> Result<NewSessionOutcome, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::NewSession { cwd, meta, reply })
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
            .send(Command::Prompt {
                session_id,
                blocks,
                reply,
            })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    /// 设置一个会话级配置项（ACP `session/set_config_option`）。
    /// `config_id` 路由到具体配置（如 "model"/"thinking"/"mode"），`value` 为所选值 id。
    /// 对协议通用、与具体 agent 无关：任意公示 configOptions 的 agent 均可复用此通道。
    pub async fn set_session_config_option(
        &self,
        session_id: SessionId,
        config_id: String,
        value: String,
    ) -> Result<Option<Value>, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::SetSessionConfigOption {
                session_id,
                config_id: SessionConfigId::from(config_id),
                value: SessionConfigOptionValue::from(SessionConfigValueId::from(value)),
                reply,
            })
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

    pub fn cancel(&self, session_id: SessionId) -> Result<(), AcpClientError> {
        // 带外取消:直接经连接句柄发送 session/cancel,绕过串行命令队列。
        // 即使命令循环正卡在某个 Prompt 的 .await 上,取消通知依旧能送达 agent,
        // 触发 StopReason::Cancelled 解阻塞该 Prompt → 循环恢复 → 死锁解除。
        let guard = self
            .cancel_cx
            .lock()
            .map_err(|_| AcpClientError::NotRunning)?;
        let cx = guard.as_ref().ok_or(AcpClientError::NotRunning)?;
        cx.send_notification(CancelNotification::new(session_id))
            .map_err(|error| AcpClientError::Transport(error.to_string()))
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
    bridges: AcpBridges,
) -> Result<AcpClientHandle, AcpClientError> {
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<Command>();
    let seq = Arc::new(AtomicU64::new(0));

    // 带外取消通道:连接闭包就绪后写入 cx 克隆,供 AcpClientHandle::cancel 直接使用。
    let cancel_cx: Arc<Mutex<Option<ConnectionTo<Agent>>>> = Arc::new(Mutex::new(None));
    let cancel_cx_task = cancel_cx.clone();

    let notif_sink = sink.clone();
    let notif_seq = seq.clone();

    tauri::async_runtime::spawn(async move {
        // === 自行 spawn AI 子进程（替换 AcpAgent::spawn_process），设 CREATE_NO_WINDOW ===
        // 方案A：不 fork SDK；Calamex 侧控制 creation_flags，消除 Windows 控制台弹框。
        let mut command = tokio::process::Command::new(&config.program);
        command
            .args(&config.args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        for (k, v) in &config.env {
            command.env(k, v);
        }
        // Windows 上设 CREATE_NO_WINDOW（0x0800_0000）；非 Windows 为 no-op。
        crate::commands::configure_tokio_command_for_background(&mut command);
        let mut child = match command.spawn() {
            Ok(c) => c,
            Err(e) => {
                log::warn!("acp: 子进程启动失败：{e}");
                return;
            }
        };
        let child_stdin  = child.stdin.take().expect("stdin piped");
        let child_stdout = child.stdout.take().expect("stdout piped");
        let child_stderr = child.stderr.take().expect("stderr piped");
        // 排干 stderr，防止管道填满阻塞子进程；错误信息仍记入 debug 日志。
        tauri::async_runtime::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut buf = [0u8; 1024];
            let mut stderr = child_stderr;
            loop {
                match stderr.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        log::debug!("acp-stderr: {}", String::from_utf8_lossy(&buf[..n]).trim_end_matches('\n'));
                    }
                }
            }
        });
        use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
        let transport = ByteStreams::new(child_stdin.compat_write(), child_stdout.compat());
        // === END ===

        let AcpBridges { fs_read, fs_write } = bridges;
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
                        sink(AcpStreamFrame {
                            session_id,
                            seq: n,
                            event,
                        });
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
                        // 带外作答(根因修复):审批是人类决策,可阻塞任意长时间。SDK 单入站分发循环
                        // 按序 await 每个处理器 future,若在此内联 resolver(req).await,整个入站循环会被
                        // 人类卡死——连同同一回合 Prompt 的 StopReason 响应都无法被路由回去,使命令循环的
                        // block_task().await 永不返回,后续命令(含带外 session/cancel 触发的 Cancelled
                        // 响应)永久排队 → 必须重启。把「等裁决 + 回投响应」搬进独立任务,处理器立即返回:
                        // Responder 独占响应通道(SDK typed.rs/handlers.rs:返回 Handled::Yes 不会自动
                        // 应答,响应仅由 responder.respond 发出),延迟到独立任务里应答是安全的,且入站循环
                        // 瞬间空闲,可继续路由 Prompt / Cancelled 响应。
                        tokio::spawn(async move {
                            let outcome = match resolver(req).await {
                                PermissionDecision::Selected(option_id) => {
                                    RequestPermissionOutcome::Selected(
                                        SelectedPermissionOutcome::new(option_id),
                                    )
                                }
                                PermissionDecision::Cancelled => {
                                    RequestPermissionOutcome::Cancelled
                                }
                            };
                            if let Err(error) =
                                responder.respond(RequestPermissionResponse::new(outcome))
                            {
                                log::warn!("acp permission responder failed: {error}");
                            }
                        });
                        Ok::<(), agent_client_protocol::Error>(())
                    }
                },
                on_receive_request!(),
            )
            .on_receive_request(
                move |req: ReadTextFileRequest, responder: Responder<ReadTextFileResponse>, _cx: ConnectionTo<Agent>| {
                    let cb = fs_read.clone();
                    async move {
                        tokio::spawn(async move {
                            let reply = match cb(req).await {
                                Ok(resp) => responder.respond(resp),
                                Err(err) => responder.respond_with_error(err),
                            };
                            if let Err(error) = reply {
                                log::warn!("acp fs/read_text_file responder failed: {error}");
                            }
                        });
                        Ok::<(), agent_client_protocol::Error>(())
                    }
                },
                on_receive_request!(),
            )
            .on_receive_request(
                move |req: WriteTextFileRequest, responder: Responder<WriteTextFileResponse>, _cx: ConnectionTo<Agent>| {
                    let cb = fs_write.clone();
                    async move {
                        tokio::spawn(async move {
                            let reply = match cb(req).await {
                                Ok(resp) => responder.respond(resp),
                                Err(err) => responder.respond_with_error(err),
                            };
                            if let Err(error) = reply {
                                log::warn!("acp fs/write_text_file responder failed: {error}");
                            }
                        });
                        Ok::<(), agent_client_protocol::Error>(())
                    }
                },
                on_receive_request!(),
            )
            .connect_with(transport, async move |cx| {
                // 持有子进程句柄（kill_on_drop），连接断开时自动终止 AI 进程。
                let _child_guard = child;
                cx.send_request(InitializeRequest::new(ProtocolVersion::V1)
    .client_capabilities(
        ClientCapabilities::new()
            .fs(FileSystemCapabilities::new()
                .read_text_file(true)
                .write_text_file(true))
            .terminal(false),
    )
    .client_info(Implementation::new("calamex", env!("CARGO_PKG_VERSION"))))
                    .block_task()
                    .await?;

                // 连接已建立:把 cx 克隆存入共享槽,使带外取消在循环阻塞时仍能发出 session/cancel。
                if let Ok(mut slot) = cancel_cx_task.lock() {
                    *slot = Some(cx.clone());
                }

                while let Some(command) = cmd_rx.recv().await {
                    // Shutdown 必须在派生任务前处理：break 只能作用于本 while 循环。
                    if matches!(command, Command::Shutdown) {
                        break;
                    }
                    // 每条命令派生到连接自身的任务（cx.spawn，SDK 认可、派发循环后台继续跑），命令循环
                    // 立刻处理下一条 → 消除命令间头阻塞；同会话依赖顺序仍由调用方 await 各自 oneshot 保证。
                    // task_cx 移入任务后重绑为 cx，下方各 match arm 主体无需改动。
                    let task_cx = cx.clone();
                    let spawn_result = cx.spawn(async move {
                        let cx = task_cx;
                        match command {
                        Command::NewSession { cwd, meta, reply } => {
                            // 仅 builtin 携带 _meta（模型目录 + 凭据，命令层组装）；外部 agent
                            // meta 为 None，构造与旧行为一致的请求。NewSessionRequest 为
                            // #[non_exhaustive]，不能用结构体字面量补字段，故经官方 builder
                            // .meta(map)（接受 impl IntoOption<Meta>，Meta = Map<String, Value>）注入。
                            let request = NewSessionRequest::new(cwd);
                            let request = match meta {
                                Some(meta) => request.meta(meta),
                                None => request,
                            };
                            let res = cx
                                .send_request(request)
                                .block_task()
                                .await;
                            // 最小透传：把 NewSessionResponse.config_options（可用配置项清单）原样
                            // 序列化为 JSON 一并回传（null → None），宿主侧据 thread_id 登记，供配置项选择器消费。
                            let outcome = res.map(|r| NewSessionOutcome {
                                session_id: r.session_id,
                                config_options: serde_json::to_value(&r.config_options)
                                    .ok()
                                    .filter(|v| !v.is_null()),
                            });
                            let _ = reply.send(outcome.map_err(|e| e.to_string()));
                        }
                        Command::Prompt {
                            session_id,
                            blocks,
                            reply,
                        } => {
                            let req = PromptRequest::new(session_id, blocks);
                            let res = cx.send_request(req).block_task().await;
                            let _ =
                                reply.send(res.map(|r| r.stop_reason).map_err(|e| e.to_string()));
                        }
                        Command::SetSessionConfigOption {
                            session_id,
                            config_id,
                            value,
                            reply,
                        } => {
                            let res = cx
                                .send_request(SetSessionConfigOptionRequest::new(
                                    session_id, config_id, value,
                                ))
                                .block_task()
                                .await;
                            // 最小透传：set_config_option 响应携带的 configOptions（切换后
                            // 完整快照）原样序列化回传（camelCase wire；缺失/null → None），
                            // 宿主侧据 thread_id 更新缓存并回传前端即时快照。
                            let outcome = res.map(|r| {
                                serde_json::to_value(&r)
                                    .ok()
                                    .and_then(|v| v.get("configOptions").cloned())
                                    .filter(|v| !v.is_null())
                            });
                            let _ = reply.send(outcome.map_err(|e| e.to_string()));
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
                        Command::Shutdown => {}
                    }
                        Ok::<(), agent_client_protocol::Error>(())
                    });
                    if let Err(error) = spawn_result {
                        log::warn!("acp: 派生命令任务失败：{error}");
                    }
                }

                // 循环退出(Shutdown 或命令通道关闭):清空带外取消槽,避免对已断连接再发通知。
                if let Ok(mut slot) = cancel_cx_task.lock() {
                    *slot = None;
                }

                Ok::<(), agent_client_protocol::Error>(())
            })
            .await;

        if let Err(error) = result {
            log::warn!("acp client connection ended with error: {error}");
        }
    });

    Ok(AcpClientHandle { cmd_tx, cancel_cx })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- NewSession _meta 模型目录注入测试 ----

    #[test]
    fn new_session_request_carries_model_catalog_meta() {
        // 仅 builtin 后端在 session/new 经官方 _meta 通道下发模型目录（含凭据 + 当前选中项），供其
        // 边车公示官方 config_options 模型选择器、并在 set_config_option 切换时按 modelId 命中凭据。
        // 验证官方 builder .meta(map) 把目录序列化到线上键 _meta（serde rename），且形状与边车
        // model-config-options.ts 的 parseModelCatalogFromMeta 期望一致：
        // calamex.dev/modelCatalog -> { models:[{modelId,apiKey,baseUrl?}], currentModelId? }。
        let mut catalog = serde_json::Map::new();
        catalog.insert(
            "calamex.dev/modelCatalog".to_string(),
            serde_json::json!({
                "models": [
                    { "modelId": "deepseek/deepseek-v4-pro", "apiKey": "sk-x" }
                ],
                "currentModelId": "deepseek/deepseek-v4-pro",
            }),
        );

        let request = NewSessionRequest::new(PathBuf::from("/repo")).meta(catalog);
        let value = serde_json::to_value(&request).unwrap();

        let entry = &value["_meta"]["calamex.dev/modelCatalog"];
        assert_eq!(entry["models"][0]["modelId"], "deepseek/deepseek-v4-pro");
        assert_eq!(entry["models"][0]["apiKey"], "sk-x");
        assert!(entry["models"][0].get("baseUrl").is_none());
        assert_eq!(entry["currentModelId"], "deepseek/deepseek-v4-pro");
    }

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

    // ---- 取消死锁回归测试 ----

    #[test]
    fn cancel_bypasses_serial_command_queue() {
        // 回归(带外取消):cancel() 必须绕过串行命令队列(cmd_tx)直接走连接句柄。
        // 旧实现把 Cancel 投进 cmd_tx,一旦 Prompt 把命令循环 .await 阻塞,
        // Cancel 永远排在队尾发不出去 → 死锁直到重启。
        //
        // 连接句柄尚未就绪(None)时,cancel 应立即返回 NotRunning,
        // 且绝不向命令队列投递任何命令(断言队列仍为空)。
        let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<Command>();
        let handle = AcpClientHandle {
            cmd_tx,
            cancel_cx: Arc::new(Mutex::new(None)),
        };

        let result = handle.cancel(SessionId::from("sess_1".to_string()));
        assert!(matches!(result, Err(AcpClientError::NotRunning)));
        assert!(
            cmd_rx.try_recv().is_err(),
            "cancel 不得经由串行命令队列,否则会被阻塞的 Prompt 卡住"
        );
    }
}
