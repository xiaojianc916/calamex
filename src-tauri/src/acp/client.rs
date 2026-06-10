//! 宿主侧 ACP(Agent Client Protocol)stdio 客户端。
//!
//! 这是「先加新模块 → cargo 验证 → 绿了再删旧」迁移路径中新增、可逆、按 cargo
//! feature `acp_client` 门控的模块。默认构建(`default = ["desktop"]`)不会编译它,
//! 因此落地阶段不影响现有 HTTP/NDJSON sidecar。
//!
//! 设计完全对齐官方 Rust crate `agent-client-protocol`(git 钉到 v0.14.0 的 SACP
//! 角色/构建器模型),不自创 JSON-RPC:
//!   * 用 `Client.builder()` 注册 `on_receive_notification`(把流式 `session/update`
//!     转发给 webview)与 `on_receive_request`(把权限请求路由给上层审批 UI)。
//!   * 用 `AcpAgent::from_args(...)` 作 stdio 传输:派生子进程
//!     `node dist/acp/stdio-entry.js`,由 crate 负责行分帧 / stderr 收集 /
//!     drop 时杀子进程。采用结构化词元而非单一命令行字符串,规避
//!     `shell_words::split` 对含空格 / 反斜杠路径(尤其 Windows)的误分词。
//!   * `connect_with(transport, |cx| async {...})` 内运行长生命周期命令循环,宿主侧
//!     (Tauri 命令)经 mpsc 投递 NewSession / Prompt / SetSessionMode / RestoreCheckpoint /
//!     Cancel / Shutdown。

// 过渡期:本模块尚未接线到宿主命令(公开 API 暂无调用点)。接线后移除该 allow。
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
    SessionNotification, SetSessionModeRequest, StopReason, TextContent,
};
use agent_client_protocol::{
    AcpAgent, Agent, BoxFuture, Client, ConnectionTo, JsonRpcRequest, Responder,
    on_receive_notification, on_receive_request,
};

/// webview 流式帧:对齐现有 `ai:sidecar-stream` 的 `{sessionId, seq, event}` 契约。
/// `event` 直接是官方 `SessionNotification` 的 JSON(camelCase 线格式)。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpStreamFrame {
    pub session_id: Option<String>,
    pub seq: u64,
    pub event: serde_json::Value,
}

/// 流式事件下沉口:与 Tauri 解耦,便于单测与后续接线(由调用方提供 emit 闭包)。
pub type EventSink = Arc<dyn Fn(AcpStreamFrame) + Send + Sync>;

/// 权限决策:由上层(审批 UI)给出。`Selected` 必须携带请求 options 中的某个 option_id。
pub enum PermissionDecision {
    Selected(PermissionOptionId),
    Cancelled,
}

/// 权限解析器:收到官方 `RequestPermissionRequest`,异步返回决策(等待用户审批)。
pub type PermissionResolver =
    Arc<dyn Fn(RequestPermissionRequest) -> BoxFuture<'static, PermissionDecision> + Send + Sync>;

/// 检查点回滚扩展方法的请求级模型配置。
/// 字段镜像 sidecar `ext-methods.ts` 的 `modelConfigParamsSchema`(camelCase 线格式)。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRestoreModelConfig {
    pub model_id: String,
    pub api_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

/// 检查点回滚扩展方法的请求。
///
/// 这是 SDK 官方推荐的扩展方法落地方式:用 `#[derive(JsonRpcRequest)]` + `#[request(...)]`
/// 把一个一等的带类型请求接入,`cx.send_request(...)` 原生可发,响应按 id 定型解析,
/// 不经枚举回退通道,因此无需 `_` 前缀。线方法名与 sidecar 的 `CHECKPOINT_RESTORE_METHOD`
/// (`calamex.dev/checkpoint/restore`)逐字一致;TS SDK 的 AgentSideConnection 对未知方法
/// 直接 `agent.extMethod(method, params)`(原样透传、不剥前缀),故两侧对得上。
/// 字段镜像 sidecar `ext-methods.ts` 的 `checkpointRestoreParamsSchema`。
/// 响应为整封 sidecar 响应信封(schemaVersion + sessionId + events + result),
/// 以 `serde_json::Value` 原样回传,交由宿主侧既有 `AgentSidecarResponsePayload` 解析。
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
    pub model_config: Option<CheckpointRestoreModelConfig>,
}

/// 启动配置。采用结构化字段而非单一命令行字符串:
///   * `program`:ACP stdio 入口可执行程序(如 node 的绝对路径);
///   * `args`:传给程序的参数(如 `dist/acp/stdio-entry.js`);
///   * `env`:注入到子进程环境的变量。
///
/// 经 `AcpAgent::from_args` 逐词元传入(每个词元为独立元素,不经 shell 分词),
/// 从而规避 `from_str` 内 `shell_words::split` 对含空格 / 反斜杠路径(尤其 Windows)
/// 的误分词。
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

/// 投递给常驻连接任务的命令。
enum Command {
    NewSession {
        cwd: PathBuf,
        reply: oneshot::Sender<Result<SessionId, String>>,
    },
    Prompt {
        session_id: SessionId,
        text: String,
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
    Cancel {
        session_id: SessionId,
    },
    Shutdown,
}

/// 宿主侧句柄:向常驻 ACP 连接任务投递命令。
#[derive(Clone)]
pub struct AcpClientHandle {
    cmd_tx: mpsc::UnboundedSender<Command>,
}

impl AcpClientHandle {
    /// 新建一个 ACP 会话,返回 `session/new` 的 session_id。
    pub async fn new_session(&self, cwd: PathBuf) -> Result<SessionId, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::NewSession { cwd, reply })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    /// 发送一轮 prompt,阻塞直到该回合结束,返回 `session/prompt` 的 stop_reason。
    pub async fn prompt(
        &self,
        session_id: SessionId,
        text: String,
    ) -> Result<StopReason, AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::Prompt {
                session_id,
                text,
                reply,
            })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    /// 设置会话模式(`session/set_mode`)。
    ///
    /// 用于在 ask / plan / agent / patch / review 等模式间切换;`mode_id` 须取自
    /// 会话当前可用模式(`session/new` 响应或 `current_mode_update` 通知公示的 `modes`)。
    /// 由调用方构造 `SessionModeId`,本模块不臆造其构造方式,对齐官方
    /// `SetSessionModeRequest::new(session_id, mode_id)`。
    pub async fn set_session_mode(
        &self,
        session_id: SessionId,
        mode_id: SessionModeId,
    ) -> Result<(), AcpClientError> {
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::SetSessionMode {
                session_id,
                mode_id,
                reply,
            })
            .map_err(|_| AcpClientError::NotRunning)?;
        rx.await
            .map_err(|_| AcpClientError::NotRunning)?
            .map_err(AcpClientError::Protocol)
    }

    /// 触发检查点回滚(扩展方法 `calamex.dev/checkpoint/restore`)。
    ///
    /// 这是 ACP 标准会话回合之外的「带外」能力,经 sidecar 公示的扩展方法通道下发;
    /// 标准客户端(如 Zed)不识别该方法会安全忽略,核心会话流不受影响。
    /// 返回 sidecar 的整封响应信封(`serde_json::Value`),由宿主侧解析。
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

    /// 取消指定会话当前操作(`session/cancel` 通知,fire-and-forget)。
    pub fn cancel(&self, session_id: SessionId) -> Result<(), AcpClientError> {
        self.cmd_tx
            .send(Command::Cancel { session_id })
            .map_err(|_| AcpClientError::NotRunning)
    }

    /// 请求常驻任务优雅结束(随后连接断开、子进程被回收)。
    pub fn shutdown(&self) {
        let _ = self.cmd_tx.send(Command::Shutdown);
    }
}

/// 构造 `AcpAgent::from_args` 所需的词元序列:前导 `NAME=value` 为子进程环境变量,
/// 其后为程序与其参数。每个词元都是独立元素,不经 shell 分词,因此 Windows 下含
/// 空格的 node / 入口路径也安全(规避 `from_str` 的 `shell_words::split` 风险)。
fn build_agent_args(config: &AcpClientConfig) -> Vec<String> {
    let mut args: Vec<String> = config
        .env
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect();
    args.push(config.program.clone());
    args.extend(config.args.iter().cloned());
    args
}

/// 启动常驻 ACP 客户端连接任务,返回宿主侧命令句柄。
///
/// 传输用官方 `AcpAgent`(stdio 子进程);连接握手与会话生命周期完全交给 crate。
/// 连接任务跑在 Tauri 多线程运行时上(`ConnectTo` future 为 `Send`,无需 LocalSet)。
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
            // 流式 session/update:Client 默认 dispatch 返回 Handled::No,通知会落到此处理器。
            .on_receive_notification(
                move |notif: SessionNotification, _cx| {
                    let sink = notif_sink.clone();
                    let seq = notif_seq.clone();
                    async move {
                        let event =
                            serde_json::to_value(&notif).unwrap_or(serde_json::Value::Null);
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
            // 权限请求:异步交给上层审批 UI 决策。
            // 参数类型:handlers.rs 要求 AsyncFnMut(Req, Responder<Req::Response>, ConnectionTo<Host::Counterpart>)。
            // Host=Client,故连接参数是 ConnectionTo<Agent>(Client::Counterpart = Agent)。
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
                            PermissionDecision::Cancelled => {
                                RequestPermissionOutcome::Cancelled
                            }
                        };
                        responder.respond(RequestPermissionResponse::new(outcome))?;
                        Ok::<(), agent_client_protocol::Error>(())
                    }
                },
                on_receive_request!(),
            )
            .connect_with(transport, async move |cx| {
                // 1) 握手
                cx.send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task()
                    .await?;

                // 2) 常驻命令循环(由宿主侧 mpsc 驱动)
                while let Some(command) = cmd_rx.recv().await {
                    match command {
                        Command::NewSession { cwd, reply } => {
                            let res = cx
                                .send_request(NewSessionRequest::new(cwd))
                                .block_task()
                                .await;
                            let _ = reply
                                .send(res.map(|r| r.session_id).map_err(|e| e.to_string()));
                        }
                        Command::Prompt {
                            session_id,
                            text,
                            reply,
                        } => {
                            let req = PromptRequest::new(
                                session_id,
                                vec![ContentBlock::Text(TextContent::new(text))],
                            );
                            let res = cx.send_request(req).block_task().await;
                            let _ = reply
                                .send(res.map(|r| r.stop_reason).map_err(|e| e.to_string()));
                        }
                        Command::SetSessionMode {
                            session_id,
                            mode_id,
                            reply,
                        } => {
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

    #[test]
    fn build_agent_args_prefixes_env_then_program_and_args() {
        let config = AcpClientConfig {
            program: "node".to_string(),
            args: vec!["dist/acp/stdio-entry.js".to_string()],
            env: vec![
                ("AGENT_SIDECAR_TOKEN".to_string(), "secret".to_string()),
                ("AGENT_SIDECAR_PORT".to_string(), "39871".to_string()),
            ],
        };
        assert_eq!(
            build_agent_args(&config),
            vec![
                "AGENT_SIDECAR_TOKEN=secret".to_string(),
                "AGENT_SIDECAR_PORT=39871".to_string(),
                "node".to_string(),
                "dist/acp/stdio-entry.js".to_string(),
            ]
        );
    }

    #[test]
    fn build_agent_args_without_env_is_program_then_args() {
        let config = AcpClientConfig {
            program: "node".to_string(),
            args: vec!["dist/acp/stdio-entry.js".to_string()],
            env: vec![],
        };
        assert_eq!(
            build_agent_args(&config),
            vec![
                "node".to_string(),
                "dist/acp/stdio-entry.js".to_string(),
            ]
        );
    }

    #[test]
    fn build_agent_args_preserves_spaces_in_paths() {
        // 这正是本次修复要防范的回归:Windows 含空格 / 反斜杠的路径作为独立词元
        // 完整保留,不被 shell 分词拆碎(旧 from_str 路径会把它拆成多个参数)。
        let config = AcpClientConfig {
            program: r"C:\Program Files\nodejs\node.exe".to_string(),
            args: vec![r"C:\My Apps\calamex\dist\acp\stdio-entry.js".to_string()],
            env: vec![],
        };
        assert_eq!(
            build_agent_args(&config),
            vec![
                r"C:\Program Files\nodejs\node.exe".to_string(),
                r"C:\My Apps\calamex\dist\acp\stdio-entry.js".to_string(),
            ]
        );
    }

    #[test]
    fn stream_frame_serializes_to_camel_case() {
        let frame = AcpStreamFrame {
            session_id: Some("sess_1".to_string()),
            seq: 7,
            event: serde_json::json!({ "kind": "agent_message_chunk" }),
        };
        let value = serde_json::to_value(&frame).unwrap();
        assert_eq!(value["sessionId"], "sess_1");
        assert_eq!(value["seq"], 7);
        assert_eq!(value["event"]["kind"], "agent_message_chunk");
    }

    #[test]
    fn checkpoint_restore_request_serializes_to_camel_case_params() {
        let request = CheckpointRestoreRequest {
            run_id: "run_1".to_string(),
            snapshot_id: Some("snap_1".to_string()),
            step: None,
            session_id: None,
            model_config: Some(CheckpointRestoreModelConfig {
                model_id: "deepseek/deepseek-v4-pro".to_string(),
                api_key: "secret".to_string(),
                base_url: None,
            }),
        };
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["runId"], "run_1");
        assert_eq!(value["snapshotId"], "snap_1");
        assert!(value.get("step").is_none());
        assert!(value.get("sessionId").is_none());
        assert_eq!(value["modelConfig"]["modelId"], "deepseek/deepseek-v4-pro");
        assert_eq!(value["modelConfig"]["apiKey"], "secret");
        assert!(value["modelConfig"].get("baseUrl").is_none());
    }
}
